import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT } from '../../redis/redis.module';
import Redis from 'ioredis';

/**
 * WhatsAppOptOutService
 *
 * Per-recipient STOP / START for WhatsApp *messaging*.
 *
 * This is separate from, and unrelated to, the WhatsApp *calling* opt-out
 * (WHATSAPP_CALLING_OPTOUT_ENABLED). Calling had an opt-out from day one;
 * messaging had none. "stop" existed only as a flow-cancel keyword in
 * agent-orchestrator.service.ts - it ended the current flow and the bot
 * happily messaged the same person again a minute later.
 *
 * It is also deliberately NOT part of isOutboundRecipientAllowed() in
 * WhatsAppCloudService. That method returns true unconditionally the moment
 * WHATSAPP_OUTBOUND_ALLOWLIST_REQUIRED is set to false - which is exactly the
 * change that opens the bot to the public. Folding opt-out into it would mean
 * opt-out silently stops working on launch day. The suppression is an
 * independent check in sendMessage().
 *
 * Storage is Redis, no TTL - an opt-out is permanent until the user sends
 * START. Caveat worth knowing: this is only as durable as Redis. Every
 * transition is also written to the log as a structured OPTOUT_EVENT line so
 * the list is reconstructable if Redis is ever lost. If the volume of
 * opt-outs ever matters commercially, move this to Postgres.
 */
const OPTOUT_KEY_PREFIX = 'wa:optout:';

/**
 * Matched against the WHOLE normalized message, never as a substring:
 * "stop" opts out, "stop the order" does not. That is the WhatsApp
 * convention and it avoids opting someone out for using the word in a
 * sentence.
 */
const STOP_KEYWORDS = new Set([
  'stop',
  'stop all',
  'stopall',
  'unsubscribe',
  'unsubscribe me',
  'optout',
  'opt out',
  'band karo',
  'band kar do',
  'band karein',
  'bandh karo',
  'message band karo',
  'mat bhejo',
  'message mat bhejo',
  'बंद करो',
  'मत भेजो',
]);

const START_KEYWORDS = new Set([
  'start',
  'unstop',
  'resume',
  'subscribe',
  'start karo',
  'chalu karo',
  'shuru karo',
  'चालू करो',
  'शुरू करो',
]);

@Injectable()
export class WhatsAppOptOutService {
  private readonly logger = new Logger(WhatsAppOptOutService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Key on digits only. The same person arrives as "+919999999999",
   * "919999999999" and occasionally "9999999999" depending on which leg of
   * the stack produced the number; all three must hit one key or the opt-out
   * leaks.
   */
  private key(phone: string): string {
    return `${OPTOUT_KEY_PREFIX}${String(phone || '').replace(/\D/g, '')}`;
  }

  /**
   * Lowercase, strip surrounding punctuation and emoji, collapse whitespace.
   * "STOP!" , "stop." and " Stop " all normalize to "stop".
   */
  private normalize(text: string): string {
    return String(text || '')
      .toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  isStopKeyword(text: string): boolean {
    return STOP_KEYWORDS.has(this.normalize(text));
  }

  isStartKeyword(text: string): boolean {
    return START_KEYWORDS.has(this.normalize(text));
  }

  /**
   * Fails OPEN - a Redis error returns false and the message is sent.
   *
   * The alternative fails closed and silences the entire bot for everyone on
   * a Redis blip. Redis also holds every session, so if it is down the flow
   * engine is already broken and there is very little to suppress. The error
   * is logged loudly rather than swallowed.
   */
  async isOptedOut(phone: string): Promise<boolean> {
    try {
      return (await this.redis.exists(this.key(phone))) === 1;
    } catch (error) {
      this.logger.error(
        `Opt-out lookup failed, allowing send (fail-open): ${error.message}`,
      );
      return false;
    }
  }

  async optOut(phone: string, keyword: string): Promise<void> {
    const key = this.key(phone);
    await this.redis.set(key, JSON.stringify({ at: Date.now(), keyword }));
    this.logger.warn(
      `OPTOUT_EVENT action=stop key=${key} keyword="${this.normalize(keyword)}"`,
    );
  }

  async optIn(phone: string): Promise<void> {
    const key = this.key(phone);
    await this.redis.del(key);
    this.logger.warn(`OPTOUT_EVENT action=start key=${key}`);
  }
}
