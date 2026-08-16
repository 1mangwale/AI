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
 * caller. Each was confirmed reachable from the open internet on 2026-08-16
 * through chat.mangwale.ai, whose traefik router sends /api/* straight to :3200.
 *
 *   /api/docker/        container inventory, per-container logs, start/stop.
 *   /api/settings/key/  returns ANY setting by exact name, and PUTs any value.
 *                       A live probe returned ADMIN_API_KEY -- the very
 *                       credential this guard accepts -- in plaintext to an
 *                       anonymous caller. No frontend code calls this prefix,
 *                       so enforcing it breaks nothing.
 *   /api/secrets/       secret CRUD + rotate. Its module is not currently
 *                       imported so it 404s; enforcing now means it ships
 *                       closed whenever someone mounts it.
 *   /api/broadcast/     POST send / quick-send fan real WhatsApp messages out
 *                       to an audience. Outward-facing and irreversible.
 *   /api/llm/           POST chat spends metered Groq / OpenRouter quota.
 *   /api/healing/trigger, /api/healing/config
 *                       start a repair cycle and enable auto-repair, which
 *                       writes config and NLU training data. The rest of
 *                       /api/healing/ stays in shadow, because client-logger.ts
 *                       posts browser logs to /api/healing/client-logs.
 *
 * Admin pages calling these without a credential now 401 until the frontend
 * sends its admin JWT. That is the intended trade: each is a LAN-only admin
 * screen, while the surfaces above answer to the open internet.
 */
const ALWAYS_ENFORCED_PREFIXES = [
  '/api/docker/',
  '/api/settings/key/',
  '/api/secrets/',
  '/api/broadcast/',
  '/api/llm/',
  '/api/healing/trigger',
  '/api/healing/config',

  // main.ts:65 sets a global 'api' prefix, and 14 mounted controllers ALSO
  // declare @Controller('api/...'), so they serve at /api/api/... and matched
  // NONE of the rules above -- this allowlist silently did not cover them.
  // Confirmed public through chat.mangwale.ai on 2026-08-16:
  //   mos/scheduler/jobs/:name/run    fires a bulk WhatsApp blast
  //   mos/whatsapp-commerce/orders    returns real customer phone numbers
  //   mos/models/orchestra/test       spends metered LLM credit
  //   approvals/:id/approve           forges an AI workflow decision
  // Nothing internal breaks: next.config.ts:226 rewrites /api/mos/* to the
  // SINGLE prefix, so the dashboard already 404s on these -- enforcing turns
  // a 404 into a 401 with no visible change.
  // BEFORE WHATSAPP FLOWS GO LIVE, move /api/api/whatsapp/flows/ into
  // PUBLIC_PATH_PREFIXES: Meta calls it with no credential and it validates
  // its own flow_token instead. Safe to enforce today only because every
  // WA_FLOW_*_ID is empty and it has never received a POST (log spans
  // 2026-03-18 to now).
  '/api/api/',
];

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
