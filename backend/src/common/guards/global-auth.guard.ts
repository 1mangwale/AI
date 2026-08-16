import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import * as crypto from 'crypto';
import { AdminRoleService } from '../../admin/services/admin-role.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

type Mode = 'off' | 'shadow' | 'enforce';
type Outcome =
  | 'admin-jwt'
  | 'api-key'
  | 'no-credential'
  | 'bearer-not-admin'
  | 'bad-api-key';

/**
 * Paths that must never require a credential, enforced by prefix rather than
 * by decorator so that a missed @Public() can never take a webhook offline.
 * The decorator remains the mechanism for marking individual routes.
 */
const PUBLIC_PATH_PREFIXES = [
  '/health',
  '/ready',
  '/metrics',
  '/api/webhook/', // Meta, Exotel, MSG91, Twilio, Telegram, Instagram
  '/api/webhooks/', // order events from Laravel / dispatcher
  '/api/chat/', // guest web-chat surface on chat.mangwale.ai
  '/api/v1/auth/', // customer auth; validates Passport tokens against PHP itself
];

/**
 * Prefixes enforced even while the guard is in shadow mode.
 *
 * These are operational control surfaces with no legitimate unauthenticated
 * caller, confirmed reachable from the open internet on 2026-08-16:
 * /api/docker exposes the container inventory, per-container logs, and a
 * POST action route, with no guard of any kind.
 *
 * The dashboard calls these from three places without a credential, so its
 * Docker page returns 401 until the frontend authenticates. That is the
 * intended trade.
 */
const ALWAYS_ENFORCED_PREFIXES = ['/api/docker/'];

/**
 * Default-closed authentication for the whole application.
 *
 * Auth in this codebase has been opt-in: 96 controllers, 20 of which carry any
 * @UseGuards, and no APP_GUARD. Every new controller therefore shipped open.
 * This guard inverts the default. It accepts the two credentials the system can
 * already present — the same pair AdminAuthGuard accepts — and rejects the rest.
 *
 * Rollout is staged through GLOBAL_AUTH_MODE:
 *   off     — disabled entirely.
 *   shadow  — logs what it *would* block and lets the request through (default).
 *   enforce — returns 401.
 *
 * Shadow mode exists because 133 raw fetch('/api/...') calls across 49 frontend
 * files carry no auth header, and grep cannot reliably tell which of those are
 * legitimate. Reading real traffic can.
 */
@Injectable()
export class GlobalAuthGuard implements CanActivate {
  private readonly logger = new Logger('GlobalAuthGuard');
  private readonly mode: Mode;

  constructor(
    private readonly reflector: Reflector,
    private readonly adminRoleService: AdminRoleService,
  ) {
    const raw = (process.env.GLOBAL_AUTH_MODE || 'shadow').toLowerCase();
    this.mode = (['off', 'shadow', 'enforce'].includes(raw) ? raw : 'shadow') as Mode;
    this.logger.log(`Global auth guard active in "${this.mode}" mode`);
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.mode === 'off') return true;
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (request.method === 'OPTIONS') return true;

    const path = request.path || request.url || '';
    if (PUBLIC_PATH_PREFIXES.some((p) => path.startsWith(p))) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const outcome = this.authenticate(request);
    if (outcome === 'admin-jwt' || outcome === 'api-key') return true;

    const alwaysEnforced = ALWAYS_ENFORCED_PREFIXES.some((p) => path.startsWith(p));

    if (this.mode === 'shadow' && !alwaysEnforced) {
      this.logger.warn(
        `[GAUTH] WOULD-BLOCK ${request.method} ${path} reason=${outcome} ` +
          `ip=${this.clientIp(request)} ua="${this.shortUa(request)}"`,
      );
      return true;
    }

    throw new UnauthorizedException(
      'This endpoint requires a valid X-Admin-Api-Key header or an admin Bearer token',
    );
  }

  /**
   * Mirrors AdminAuthGuard: an admin JWT, or the shared admin API key.
   * A customer Passport token is deliberately NOT accepted — verifying one
   * costs an HTTP round-trip to Laravel, which a global guard cannot afford.
   * Customer-facing routes are marked public and verify their own tokens.
   */
  private authenticate(request: Request): Outcome {
    const authHeader = request.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const adminUser = this.adminRoleService.verifyToken(authHeader.slice(7));
      if (adminUser) {
        (request as any).adminUser = adminUser;
        return 'admin-jwt';
      }
      return 'bearer-not-admin';
    }

    const apiKey = request.headers['x-admin-api-key'] as string | undefined;
    if (!apiKey) return 'no-credential';

    const validKey = process.env.ADMIN_API_KEY;
    if (!validKey || apiKey.length !== validKey.length) return 'bad-api-key';

    const matches = crypto.timingSafeEqual(
      Buffer.from(apiKey),
      Buffer.from(validKey),
    );
    return matches ? 'api-key' : 'bad-api-key';
  }

  private clientIp(request: Request): string {
    const fwd = request.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
    return request.ip || 'unknown';
  }

  private shortUa(request: Request): string {
    const ua = (request.headers['user-agent'] as string) || '';
    return ua.slice(0, 60);
  }
}
