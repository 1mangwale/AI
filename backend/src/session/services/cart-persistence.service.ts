import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

interface CartItem {
  itemIndex: number;
  itemId: number | string;
  itemName: string;
  quantity: number;
  price: number;
  rawPrice?: number;
  storeId?: number;
  moduleId?: number;
  storeName?: string;
  storeLat?: number;
  storeLng?: number;
  variation?: { type: string; price: string }[];
  variationLabel?: string;
  specialInstruction?: string;
}

interface PersistedCart {
  items: CartItem[];
  updatedAt: number;
  flowId?: string;
}

/**
 * CartPersistenceService
 *
 * Persists cart data in a dedicated Redis key separate from the session/flow context.
 * This ensures carts survive session expiry (24h TTL) and flow resets.
 *
 * Key format: `cart:{phoneNumber}`
 * TTL: 48 hours
 */
@Injectable()
export class CartPersistenceService {
  private readonly logger = new Logger(CartPersistenceService.name);
  private readonly CART_TTL = 48 * 60 * 60; // 48 hours in seconds
  private readonly KEY_PREFIX = 'cart:';

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Save cart items to Redis
   */
  async saveCart(phoneNumber: string, items: CartItem[], flowId?: string): Promise<void> {
    if (!items || items.length === 0) {
      await this.clearCart(phoneNumber);
      return;
    }

    const key = this.getKey(phoneNumber);
    const data: PersistedCart = {
      items,
      updatedAt: Date.now(),
      flowId,
    };

    try {
      await this.redis.setex(key, this.CART_TTL, JSON.stringify(data));
      this.logger.debug(`Cart saved for ${phoneNumber}: ${items.length} items`);
    } catch (error) {
      this.logger.error(`Failed to save cart for ${phoneNumber}: ${error.message}`);
    }
  }

  /**
   * Get persisted cart items
   */
  async getCart(phoneNumber: string): Promise<CartItem[] | null> {
    try {
      const raw = await this.redis.get(this.getKey(phoneNumber));
      if (!raw) return null;

      const data: PersistedCart = JSON.parse(raw);
      return data.items;
    } catch (error) {
      this.logger.error(`Failed to get cart for ${phoneNumber}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get full persisted cart with metadata
   */
  async getCartWithMeta(phoneNumber: string): Promise<PersistedCart | null> {
    try {
      const raw = await this.redis.get(this.getKey(phoneNumber));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      this.logger.error(`Failed to get cart meta for ${phoneNumber}: ${error.message}`);
      return null;
    }
  }

  /**
   * Clear cart
   */
  async clearCart(phoneNumber: string): Promise<void> {
    try {
      await this.redis.del(this.getKey(phoneNumber));
      this.logger.debug(`Cart cleared for ${phoneNumber}`);
    } catch (error) {
      this.logger.error(`Failed to clear cart for ${phoneNumber}: ${error.message}`);
    }
  }

  /**
   * Get cart age in minutes (for recovery detection)
   */
  async getCartAge(phoneNumber: string): Promise<number | null> {
    try {
      const raw = await this.redis.get(this.getKey(phoneNumber));
      if (!raw) return null;

      const data: PersistedCart = JSON.parse(raw);
      return (Date.now() - data.updatedAt) / (1000 * 60);
    } catch (error) {
      return null;
    }
  }

  /**
   * Scan for abandoned carts (for cart recovery cron)
   * Returns phone numbers with carts older than minAgeMinutes
   */
  async findAbandonedCarts(minAgeMinutes: number): Promise<string[]> {
    const abandoned: string[] = [];
    let cursor = '0';

    try {
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor, 'MATCH', `${this.KEY_PREFIX}*`, 'COUNT', 100,
        );
        cursor = nextCursor;

        for (const key of keys) {
          const raw = await this.redis.get(key);
          if (!raw) continue;

          const data: PersistedCart = JSON.parse(raw);
          const ageMinutes = (Date.now() - data.updatedAt) / (1000 * 60);

          if (ageMinutes >= minAgeMinutes && data.items.length > 0) {
            const phoneNumber = key.replace(this.KEY_PREFIX, '');
            abandoned.push(phoneNumber);
          }
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.error(`Failed to scan abandoned carts: ${error.message}`);
    }

    return abandoned;
  }

  private getKey(phoneNumber: string): string {
    return `${this.KEY_PREFIX}${phoneNumber}`;
  }
}
