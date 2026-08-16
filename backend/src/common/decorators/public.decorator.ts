import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route (or an entire controller) as reachable without a Mangwale
 * credential.
 *
 * Use for exactly three things:
 *   1. External webhooks — Meta, Exotel, MSG91/Twilio, Telegram, Laravel.
 *      These callers cannot send our header; they are authenticated by
 *      signature verification inside the handler instead.
 *   2. The guest web-chat surface on chat.mangwale.ai.
 *   3. Routes that validate their own token (customer Laravel Passport
 *      tokens are verified against PHP inside the handler — see
 *      auth.controller.ts:268 — and cannot be checked by a global guard).
 *
 * Everything else is default-closed via GlobalAuthGuard.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
