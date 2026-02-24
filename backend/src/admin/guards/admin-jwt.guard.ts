import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AdminRoleService } from '../services/admin-role.service';

@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(private readonly adminRoleService: AdminRoleService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // Try Bearer header first, then fall back to HttpOnly cookie
    const authHeader = request.headers['authorization'];
    let token: string | undefined;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (request.cookies?.mangwale_admin_token) {
      token = request.cookies.mangwale_admin_token;
    } else if (request.cookies?.mangwale_token) {
      token = request.cookies.mangwale_token;
    }

    if (!token) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const adminUser = this.adminRoleService.verifyToken(token);

    if (!adminUser) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    (request as any).adminUser = adminUser;
    return true;
  }
}
