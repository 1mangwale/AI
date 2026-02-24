import {
  Controller,
  Post,
  Put,
  Get,
  Body,
  Req,
  Res,
  UseGuards,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { AdminRoleService } from '../services/admin-role.service';
import { AdminEmailService } from '../services/admin-email.service';
import { AdminActivityLogService } from '../services/admin-activity-log.service';
import { AdminJwtGuard } from '../guards/admin-jwt.guard';
import { LoginDto, ForgotPasswordDto, VerifyOtpDto, ResetPasswordDto, ChangePasswordDto } from '../dto/admin-auth.dto';

@Controller('admin/auth')
export class AdminAuthController {
  private readonly logger = new Logger(AdminAuthController.name);

  constructor(
    private readonly adminRoleService: AdminRoleService,
    private readonly emailService: AdminEmailService,
    private readonly activityLog: AdminActivityLogService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * POST /api/admin/auth/login
   * Email + password → JWT token
   */
  @Post('login')
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip;
    const ua = req.headers['user-agent'];

    try {
      const { user, token } = await this.adminRoleService.authenticate(dto.email, dto.password);

      await this.activityLog.log(user.id, 'login', 'auth', { email: dto.email }, ip, ua);

      // Set HttpOnly cookie for persistent admin sessions
      res.cookie('mangwale_admin_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24h — matches JWT expiry
        path: '/',
      });

      return {
        success: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          permissions: user.permissions,
        },
      };
    } catch (error) {
      this.logger.error(`Login failed for ${dto.email}: ${error.message}`);
      // Log failed attempt — use null adminId since we don't know who it is
      await this.activityLog.log(null, 'login_failed', 'auth', { email: dto.email }, ip, ua);

      return {
        success: false,
        message: 'Invalid email or password',
      };
    }
  }

  /**
   * POST /api/admin/auth/forgot-password
   * Generate OTP + send email. Always returns same response (anti-enumeration).
   */
  @Post('forgot-password')
  @Throttle({ short: { limit: 2, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    const ip = req.ip;
    const ua = req.headers['user-agent'];
    const genericResponse = {
      success: true,
      message: 'If an account with that email exists, an OTP has been sent.',
    };

    // Check cooldown
    const cooldownKey = `admin:otp_cooldown:${dto.email}`;
    const hasCooldown = await this.redis.get(cooldownKey);
    if (hasCooldown) {
      return genericResponse;
    }

    const admin = await this.adminRoleService.getAdminByEmail(dto.email);
    if (!admin) {
      return genericResponse;
    }

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();

    // Store in Redis with 10 min TTL
    const otpKey = `admin:otp:${dto.email}`;
    await this.redis.set(otpKey, JSON.stringify({ otp, attempts: 0 }), 'EX', 600);

    // Set cooldown (60s)
    await this.redis.set(cooldownKey, '1', 'EX', 60);

    // Send email
    await this.emailService.sendOtp(dto.email, admin.name, otp);

    await this.activityLog.log(admin.id, 'forgot_password', 'auth', { email: dto.email }, ip, ua);

    return genericResponse;
  }

  /**
   * POST /api/admin/auth/verify-otp
   * Verify OTP → return reset token
   */
  @Post('verify-otp')
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    const ip = req.ip;
    const ua = req.headers['user-agent'];
    const otpKey = `admin:otp:${dto.email}`;

    const stored = await this.redis.get(otpKey);
    if (!stored) {
      return { success: false, message: 'OTP expired or not found. Please request a new one.' };
    }

    const data = JSON.parse(stored);

    // Check attempt limit
    if (data.attempts >= 5) {
      await this.redis.del(otpKey);
      return { success: false, message: 'Too many attempts. Please request a new OTP.' };
    }

    // Constant-time comparison
    const otpBuffer = Buffer.from(dto.otp.padEnd(6, '\0'));
    const storedBuffer = Buffer.from(data.otp.padEnd(6, '\0'));
    const isValid = otpBuffer.length === storedBuffer.length && crypto.timingSafeEqual(otpBuffer, storedBuffer);

    if (!isValid) {
      data.attempts += 1;
      // Keep remaining TTL
      const ttl = await this.redis.ttl(otpKey);
      await this.redis.set(otpKey, JSON.stringify(data), 'EX', ttl > 0 ? ttl : 600);
      return { success: false, message: 'Invalid OTP. Please try again.' };
    }

    // OTP valid — delete it and create reset token
    await this.redis.del(otpKey);

    const resetToken = crypto.randomUUID();
    const resetKey = `admin:reset:${resetToken}`;
    await this.redis.set(resetKey, dto.email, 'EX', 300); // 5 min TTL

    const admin = await this.adminRoleService.getAdminByEmail(dto.email);
    if (admin) {
      await this.activityLog.log(admin.id, 'otp_verified', 'auth', { email: dto.email }, ip, ua);
    }

    return {
      success: true,
      resetToken,
      message: 'OTP verified. Use the reset token to set a new password.',
    };
  }

  /**
   * POST /api/admin/auth/reset-password
   * Use reset token to set new password
   */
  @Post('reset-password')
  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    const ip = req.ip;
    const ua = req.headers['user-agent'];
    const resetKey = `admin:reset:${dto.resetToken}`;

    const email = await this.redis.get(resetKey);
    if (!email) {
      return { success: false, message: 'Reset token expired or invalid. Please start over.' };
    }

    // Delete the reset token (one-time use)
    await this.redis.del(resetKey);

    await this.adminRoleService.updatePassword(email, dto.newPassword);

    const admin = await this.adminRoleService.getAdminByEmail(email);
    if (admin) {
      await this.activityLog.log(admin.id, 'password_reset', 'auth', { email }, ip, ua);
    }

    this.logger.log(`Password reset completed for ${email}`);

    return {
      success: true,
      message: 'Password reset successfully. You can now log in with your new password.',
    };
  }

  /**
   * PUT /api/admin/auth/change-password
   * Change password for the currently authenticated admin
   */
  @Put('change-password')
  @UseGuards(AdminJwtGuard)
  @HttpCode(HttpStatus.OK)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request) {
    const adminUser = (req as any).adminUser;

    try {
      await this.adminRoleService.changePassword(adminUser.id, dto.oldPassword, dto.newPassword);
      await this.activityLog.log(adminUser.id, 'password_changed', 'auth', {}, req.ip, req.headers['user-agent'] as string);

      return {
        success: true,
        message: 'Password changed successfully.',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to change password.',
      };
    }
  }

  /**
   * POST /api/admin/auth/logout
   * Clear admin auth cookie
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const adminUser = (req as any).adminUser;

    res.clearCookie('mangwale_admin_token', { path: '/' });

    if (adminUser?.id) {
      await this.activityLog.log(adminUser.id, 'logout', 'auth', {}, req.ip, req.headers['user-agent'] as string);
    }

    return { success: true, message: 'Logged out successfully.' };
  }

  /**
   * GET /api/admin/auth/profile
   * Get current admin profile (requires JWT)
   */
  @Get('profile')
  @UseGuards(AdminJwtGuard)
  async getProfile(@Req() req: Request) {
    const adminUser = (req as any).adminUser;

    await this.activityLog.log(adminUser.id, 'profile_viewed', 'auth', {}, req.ip, req.headers['user-agent'] as string);

    return {
      success: true,
      user: {
        id: adminUser.id,
        email: adminUser.email,
        name: adminUser.name,
        role: adminUser.role,
        permissions: adminUser.permissions,
        createdAt: adminUser.createdAt,
      },
    };
  }
}
