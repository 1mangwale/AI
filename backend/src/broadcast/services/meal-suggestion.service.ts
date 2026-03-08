import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as pg from 'pg';
import * as mysql from 'mysql2/promise';

interface EligibleUser {
  phone: string;
  userId: number;
  name: string;
  language: string;
  lastOrderDate: Date;
  orderCount: number;
}

interface MealSuggestion {
  phone: string;
  userId: number;
  templateName: string;
  templateParams: Record<string, any>;
  mealContext: Record<string, any>;
}

@Injectable()
export class MealSuggestionService implements OnModuleInit {
  private readonly logger = new Logger(MealSuggestionService.name);
  private pgPool: pg.Pool;
  private mysqlPool: mysql.Pool;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    try {
      this.pgPool = new pg.Pool({
        connectionString: this.configService.get<string>('DATABASE_URL'),
        max: 5,
      });

      this.mysqlPool = mysql.createPool({
        host: this.configService.get<string>('PHP_DB_HOST', '103.160.107.208'),
        port: this.configService.get<number>('PHP_DB_PORT', 3307),
        user: this.configService.get<string>('PHP_DB_USER', 'forge'),
        password: this.configService.get<string>('PHP_DB_PASSWORD'),
        database: this.configService.get<string>('PHP_DB_NAME', 'mangwale_db'),
        waitForConnections: true,
        connectionLimit: 5,
      });

      this.logger.log('MealSuggestionService pools initialized');
    } catch (error) {
      this.logger.error('Failed to initialize DB pools', error);
    }
  }

  /**
   * Find users eligible for proactive meal suggestions.
   * Queries Laravel MySQL for recent WhatsApp orderers, excludes opt-outs and today\'s sends.
   */
  async findEligibleUsers(
    mealTime: 'lunch' | 'dinner',
    limit = 50,
  ): Promise<EligibleUser[]> {
    try {
      // Get opted-out phones
      const optOutResult = await this.pgPool.query(
        'SELECT phone FROM proactive_opt_outs',
      );
      const optedOutPhones = optOutResult.rows.map((r) => r.phone);

      // Get phones already messaged today
      const todaySentResult = await this.pgPool.query(
        `SELECT DISTINCT phone FROM proactive_messages
         WHERE sent_at >= CURRENT_DATE
         AND message_type = $1`,
        [mealTime],
      );
      const todaySentPhones = todaySentResult.rows.map((r) => r.phone);

      const excludePhones = [...new Set([...optedOutPhones, ...todaySentPhones])];

      // Query Laravel MySQL for recent WhatsApp orderers (last 30 days)
      const [rows] = await this.mysqlPool.query<mysql.RowDataPacket[]>(
        `SELECT
           u.id as userId,
           u.phone,
           COALESCE(u.f_name, '') as name,
           COUNT(DISTINCT o.id) as orderCount,
           MAX(o.created_at) as lastOrderDate
         FROM users u
         INNER JOIN orders o ON o.user_id = u.id
         WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
           AND o.order_status NOT IN ('canceled', 'refunded', 'failed')
           AND u.phone IS NOT NULL
           AND u.phone != ''
           AND u.status = 1
         GROUP BY u.id, u.phone, u.f_name
         HAVING orderCount >= 2
         ORDER BY orderCount DESC
         LIMIT ?`,
        [limit + excludePhones.length],
      );

      // Filter out excluded phones in application layer
      const eligible: EligibleUser[] = [];
      for (const row of rows) {
        if (eligible.length >= limit) break;
        const phone = String(row.phone).replace(/^\+?91/, '').trim();
        const fullPhone = `91${phone}`;
        if (excludePhones.includes(fullPhone) || excludePhones.includes(phone)) {
          continue;
        }
        eligible.push({
          phone: fullPhone,
          userId: row.userId,
          name: row.name || 'there',
          language: 'en',
          lastOrderDate: row.lastOrderDate,
          orderCount: row.orderCount,
        });
      }

      this.logger.log(
        `Found ${eligible.length} eligible users for ${mealTime} suggestions`,
      );
      return eligible;
    } catch (error) {
      this.logger.error('Failed to find eligible users', error);
      return [];
    }
  }

  /**
   * Generate a personalized meal suggestion for a user.
   * Reads user_profiles (favorites, dietary) + order history to compose template params.
   */
  async generateSuggestion(
    user: EligibleUser,
    mealTime: 'lunch' | 'dinner',
  ): Promise<MealSuggestion | null> {
    try {
      // Try to get user profile from PostgreSQL
      let favoriteItems: string[] = [];
      let favoriteStores: string[] = [];
      let dietaryType = '';
      let language = 'en';

      try {
        const profileResult = await this.pgPool.query(
          `SELECT favorite_items, favorite_stores, dietary_type, language_preference
           FROM user_profiles WHERE user_id = $1 LIMIT 1`,
          [user.userId],
        );
        if (profileResult.rows.length > 0) {
          const profile = profileResult.rows[0];
          favoriteItems = this.parseJsonArray(profile.favorite_items);
          favoriteStores = this.parseJsonArray(profile.favorite_stores);
          dietaryType = profile.dietary_type || '';
          language = profile.language_preference || 'en';
        }
      } catch {
        // Profile table may not have data for this user — continue with order history
      }

      // Get most ordered items from Laravel MySQL
      let topItem = '';
      let topStore = '';
      try {
        const [itemRows] = await this.mysqlPool.query<mysql.RowDataPacket[]>(
          `SELECT
             od.food_id,
             od.food_details,
             s.name as store_name,
             COUNT(*) as freq
           FROM order_details od
           INNER JOIN orders o ON o.id = od.order_id
           INNER JOIN stores s ON s.id = o.store_id
           WHERE o.user_id = ?
             AND o.order_status = 'delivered'
             AND o.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
           GROUP BY od.food_id, od.food_details, s.name
           ORDER BY freq DESC
           LIMIT 3`,
          [user.userId],
        );

        if (itemRows.length > 0) {
          // Parse food_details JSON to get item name
          try {
            const details = JSON.parse(itemRows[0].food_details);
            topItem = details.name || details.item_name || '';
          } catch {
            topItem = '';
          }
          topStore = itemRows[0].store_name || '';
        }
      } catch {
        // Fall back to favorites from profile
      }

      // Use profile favorites as fallback
      if (!topItem && favoriteItems.length > 0) {
        topItem = favoriteItems[0];
      }
      if (!topStore && favoriteStores.length > 0) {
        topStore = favoriteStores[0];
      }

      // Build contextual greeting
      const greeting = mealTime === 'lunch'
        ? 'Lunch time'
        : 'Dinner time';

      const suggestion = topItem
        ? `Your favourite ${topItem}${topStore ? ` from ${topStore}` : ''} is waiting for you`
        : 'Check out today\'s top picks near you';

      // Select template based on language
      const isHindi = language === 'hi' || language === 'mr';
      const templateName = isHindi
        ? `meal_suggestion_hi_v1`
        : `meal_suggestion_v1`;

      return {
        phone: user.phone,
        userId: user.userId,
        templateName,
        templateParams: {
          name: user.name || 'there',
          greeting,
          suggestion,
        },
        mealContext: {
          mealTime,
          topItem,
          topStore,
          dietaryType,
          language,
          orderCount: user.orderCount,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to generate suggestion for user ${user.userId}`,
        error,
      );
      return null;
    }
  }

  private parseJsonArray(value: any): string[] {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
