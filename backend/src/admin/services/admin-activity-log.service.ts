import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export type AdminAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'forgot_password'
  | 'otp_verified'
  | 'password_reset'
  | 'password_changed'
  | 'profile_viewed';

@Injectable()
export class AdminActivityLogService {
  private readonly logger = new Logger(AdminActivityLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(
    adminId: string | null,
    action: AdminAction,
    module: string,
    details: Record<string, any>,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO admin_activity_log (admin_id, action, module, details, ip_address, user_agent, created_at)
        VALUES (${adminId}::uuid, ${action}, ${module}, ${JSON.stringify(details)}::jsonb, ${ipAddress ?? null}, ${userAgent ?? null}, NOW())
      `;
    } catch (error) {
      // Activity logging should never break the main flow
      this.logger.error(`Failed to log admin activity: ${error.message}`);
    }
  }
}
