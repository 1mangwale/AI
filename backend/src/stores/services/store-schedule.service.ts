import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import {
  StoreSchedule,
  StoreOpenStatus,
  EnrichedStoreSchedule,
} from '../interfaces/store-schedule.interface';

/**
 * Store Schedule Service
 * 
 * Manages store opening/closing hours and availability status
 * Queries MySQL store_schedule table
 */
@Injectable()
export class StoreScheduleService {
  private readonly logger = new Logger(StoreScheduleService.name);
  private pool: mysql.Pool;

  constructor(private configService: ConfigService) {
    // Connect to MySQL for store schedule data
    const host = process.env.PHP_DB_HOST || this.configService.get('php.database.host') || '127.0.0.1';
    const port = parseInt(process.env.PHP_DB_PORT || this.configService.get('php.database.port') || '23306');
    const user = process.env.PHP_DB_USER || 'mangwale_user';
    const password = process.env.PHP_DB_PASSWORD;
    const database = process.env.PHP_DB_NAME || 'mangwale_db';
    
    if (!password) {
      throw new Error('PHP_DB_PASSWORD environment variable is required');
    }
    
    try {
      this.pool = mysql.createPool({
        host,
        port,
        user,
        password,
        database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
      });
      this.logger.log(`✅ StoreScheduleService initialized with MySQL (${host}:${port}/${database})`);
    } catch (error) {
      this.logger.warn(`⚠️ MySQL connection failed - schedule service disabled: ${error.message}`);
      this.pool = null;
    }
  }

  /**
   * Get store schedule for a specific day (returns first row only)
   * @deprecated Use getStoreSchedules() to correctly handle split-shift stores
   */
  async getStoreSchedule(
    storeId: number,
    date: Date = new Date(),
  ): Promise<StoreSchedule | null> {
    const schedules = await this.getStoreSchedules(storeId, date);
    return schedules.length > 0 ? schedules[0] : null;
  }

  /**
   * Get ALL schedule windows for a store on a specific day.
   * Some stores have split shifts (e.g. 11:00–15:30 and 18:59–22:30) and
   * will have multiple rows per day in store_schedule.
   */
  async getStoreSchedules(
    storeId: number,
    date: Date = new Date(),
  ): Promise<StoreSchedule[]> {
    if (!this.pool) {
      this.logger.warn('MySQL pool not initialized');
      return [];
    }

    const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday

    try {
      const [rows] = await this.pool.query(
        `SELECT store_id, day, opening_time, closing_time
         FROM store_schedule
         WHERE store_id = ? AND day = ?
         ORDER BY opening_time`,
        [storeId, dayOfWeek],
      );

      if (!rows || (rows as any[]).length === 0) {
        this.logger.warn(
          `No schedule found for store ${storeId} on day ${dayOfWeek}`,
        );
        return [];
      }

      return rows as StoreSchedule[];
    } catch (error) {
      this.logger.error(
        `Error fetching schedule for store ${storeId}: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Get weekly schedule for a store
   */
  async getWeeklySchedule(storeId: number): Promise<StoreSchedule[]> {
    if (!this.pool) {
      return [];
    }

    try {
      const [rows] = await this.pool.query(
        `SELECT store_id, day, opening_time, closing_time 
         FROM store_schedule 
         WHERE store_id = ? 
         ORDER BY day`,
        [storeId],
      );

      return (rows as any[]) || [];
    } catch (error) {
      this.logger.error(
        `Error fetching weekly schedule for store ${storeId}: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Check if store is currently open.
   * Correctly handles split-shift stores (multiple time windows per day).
   * Returns open if the current time falls within ANY of the day's windows.
   */
  async isStoreOpen(
    storeId: number,
    currentTime: Date = new Date(),
  ): Promise<StoreOpenStatus> {
    const schedules = await this.getStoreSchedules(storeId, currentTime);

    if (!schedules || schedules.length === 0) {
      // No schedule found — assume open (graceful degradation)
      return {
        is_open: true,
        message: 'Open (schedule unavailable)',
      };
    }

    // Check each shift window; return open immediately if any window matches
    for (const schedule of schedules) {
      const status = this.checkIfOpen(
        schedule.opening_time,
        schedule.closing_time,
        currentTime,
      );
      if (status.is_open) {
        return status;
      }
    }

    // All windows exhausted — the store is closed. Name the NEXT opening, not
    // the first window we happened to iterate over. A split-shift store closed
    // between lunch and dinner reopens LATER TODAY; telling that customer
    // "Opens at 11:00 AM" sends them away until tomorrow and loses the order.
    const nowMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
    const toMinutes = (t: string): number => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const openings = schedules
      .map((s) => s.opening_time)
      .filter((t): t is string => Boolean(t))
      .sort((a, b) => toMinutes(a) - toMinutes(b));

    const laterToday = openings.find((o) => toMinutes(o) > nowMinutes);
    const nextOpen = laterToday ?? openings[0];

    if (!nextOpen) {
      return { is_open: false, message: 'Closed today' };
    }

    // Only say "tomorrow" when every window for today has already passed.
    return {
      is_open: false,
      message: `Closed • Opens at ${this.formatTime(nextOpen)}${laterToday ? '' : ' tomorrow'}`,
      opens_at: nextOpen,
    };
  }

  /**
   * Check if store is open based on opening/closing times
   * Handles overnight stores (e.g., opens 22:00, closes 02:00)
   */
  checkIfOpen(
    opensAt: string,
    closesAt: string,
    currentTime: Date = new Date(),
  ): StoreOpenStatus {
    if (!opensAt || !closesAt) {
      return {
        is_open: true,
        message: 'Open (hours not specified)',
      };
    }

    const now = currentTime;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    // Parse opening time
    const [openHour, openMin] = opensAt.split(':').map(Number);
    const openingMinutes = openHour * 60 + openMin;

    // Parse closing time
    const [closeHour, closeMin] = closesAt.split(':').map(Number);
    const closingMinutes = closeHour * 60 + closeMin;

    // Handle overnight stores (closing time < opening time)
    if (closingMinutes < openingMinutes) {
      // Store is open if: current time >= opening OR current time < closing
      const isOpen =
        currentMinutes >= openingMinutes || currentMinutes < closingMinutes;

      if (isOpen) {
        if (currentMinutes >= openingMinutes) {
          // Currently after opening time, closes after midnight
          return {
            is_open: true,
            message: `Open now • Closes at ${this.formatTime(closesAt)} (tomorrow)`,
            closes_at: closesAt,
          };
        } else {
          // Currently before closing time (early morning)
          return {
            is_open: true,
            message: `Open now • Closes at ${this.formatTime(closesAt)}`,
            closes_at: closesAt,
          };
        }
      } else {
        // Closed during the day
        return {
          is_open: false,
          message: `Closed • Opens at ${this.formatTime(opensAt)}`,
          opens_at: opensAt,
        };
      }
    }

    // Normal hours (closing time > opening time)
    const isOpen =
      currentMinutes >= openingMinutes && currentMinutes < closingMinutes;

    if (isOpen) {
      const minutesUntilClose = closingMinutes - currentMinutes;
      const closesSoon = minutesUntilClose <= 30;

      return {
        is_open: true,
        message: closesSoon
          ? `Open now • Closes soon at ${this.formatTime(closesAt)}`
          : `Open now • Closes at ${this.formatTime(closesAt)}`,
        closes_at: closesAt,
      };
    } else {
      // Store is closed
      if (currentMinutes < openingMinutes) {
        // Before opening time today
        return {
          is_open: false,
          message: `Closed • Opens at ${this.formatTime(opensAt)}`,
          opens_at: opensAt,
        };
      } else {
        // After closing time, opens tomorrow
        return {
          is_open: false,
          message: `Closed • Opens at ${this.formatTime(opensAt)} tomorrow`,
          opens_at: opensAt,
        };
      }
    }
  }

  /**
   * Format time string to human-readable format
   * "10:00:00" -> "10:00 AM"
   */
  private formatTime(timeStr: string): string {
    if (!timeStr) return '';

    const [hourStr, minStr] = timeStr.split(':');
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minStr, 10);

    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    const minFormatted = minute.toString().padStart(2, '0');

    return `${hour12}:${minFormatted} ${ampm}`;
  }

  /**
   * Enrich item results with store open/closed status
   */
  async enrichItemsWithSchedule(items: any[]): Promise<any[]> {
    const enrichedItems = await Promise.all(
      items.map(async (item) => {
        if (!item.store_id) return item;

        const status = await this.isStoreOpen(item.store_id);

        return {
          ...item,
          is_open: status.is_open,
          store_status_message: status.message,
          opens_at: status.opens_at,
          closes_at: status.closes_at,
        };
      }),
    );

    return enrichedItems;
  }

  /**
   * Filter items to only include open stores
   */
  async filterOpenStores(items: any[]): Promise<any[]> {
    const enriched = await this.enrichItemsWithSchedule(items);
    return enriched.filter((item) => item.is_open !== false);
  }

  /**
   * Get next 7 days schedule for a store (useful for display)
   */
  async getNextWeekSchedule(storeId: number): Promise<EnrichedStoreSchedule[]> {
    const weekSchedule = await this.getWeeklySchedule(storeId);
    const today = new Date();

    const enrichedSchedule: EnrichedStoreSchedule[] = [];

    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      const dayOfWeek = date.getDay();

      // Use filter() to get ALL windows for this day (handles split shifts)
      const daySchedules = weekSchedule.filter((s) => s.day === dayOfWeek);

      if (daySchedules.length > 0) {
        // Check if the store is open in any window for this day
        let isOpen = false;
        for (const sched of daySchedules) {
          const s = this.checkIfOpen(sched.opening_time, sched.closing_time, date);
          if (s.is_open) { isOpen = true; break; }
        }

        // Use first window as representative entry (shows first opening time)
        const firstWindow = daySchedules[0];
        enrichedSchedule.push({
          ...firstWindow,
          is_currently_open: isOpen,
          status_message: isOpen
            ? `Open now • Closes at ${this.formatTime(firstWindow.closing_time)}`
            : `Closed • Opens at ${this.formatTime(firstWindow.opening_time)}`,
        });
      }
    }

    return enrichedSchedule;
  }
}
