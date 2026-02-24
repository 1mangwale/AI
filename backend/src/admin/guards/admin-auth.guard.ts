import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AdminRoleService } from '../services/admin-role.service';
import * as crypto from 'crypto';

/**
 * Combined guard — accepts EITHER:
 *   1. Authorization: Bearer <jwt> (dashboard users)
 *   2. X-Admin-Api-Key header (automation/scripts)
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly adminRoleService: AdminRoleService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // Try JWT from Bearer header first, then HttpOnly cookie
    const authHeader = request.headers['authorization'];
    let token: string | undefined;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (request.cookies?.mangwale_admin_token) {
      token = request.cookies.mangwale_admin_token;
    } else if (request.cookies?.mangwale_token) {
      token = request.cookies.mangwale_token;
    }

    if (token) {
      const adminUser = this.adminRoleService.verifyToken(token);
      if (adminUser) {
        (request as any).adminUser = adminUser;
        return true;
      }
    }

    // Fall back to API key
    const apiKey = request.headers['x-admin-api-key'] as string;
    const validKey = process.env.ADMIN_API_KEY;

    if (validKey && apiKey && apiKey.length === validKey.length) {
      const isValid = crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(validKey));
      if (isValid) {
        // API key auth doesn't attach a user — it's a service-level credential
        return true;
      }
    }

    throw new UnauthorizedException('Valid JWT Bearer token or X-Admin-Api-Key required');
  }
}
