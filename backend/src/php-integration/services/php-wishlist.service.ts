import { Injectable, Logger } from '@nestjs/common';
import { PhpApiService } from './php-api.service';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from '../../common/services/circuit-breaker.service';

/**
 * PHP Wishlist Service
 * Handles wishlist (favourites) API calls
 *
 * API Endpoints:
 * - GET  /api/v1/customer/wish-list/
 * - POST /api/v1/customer/wish-list/add
 * - DELETE /api/v1/customer/wish-list/remove
 */
@Injectable()
export class PhpWishlistService extends PhpApiService {
  constructor(configService: ConfigService, circuitBreaker: CircuitBreakerService) {
    super(configService, circuitBreaker);
  }

  /**
   * Get user's wishlist
   */
  async getWishlist(token: string): Promise<{
    success: boolean;
    items?: Array<{
      id: number;
      itemId: number;
      name: string;
      price: number;
      storeId: number;
      storeName: string;
      moduleId: number;
    }>;
    message?: string;
  }> {
    try {
      this.logger.log('❤️ Fetching wishlist');
      const response: any = await this.authenticatedRequest('get', '/api/v1/customer/wish-list/', token);
      if (response && Array.isArray(response)) {
        return {
          success: true,
          items: response.map((entry: any) => ({
            id: entry.id,
            itemId: entry.item_id || entry.item?.id,
            name: entry.item?.name || entry.name || 'Item',
            price: parseFloat(entry.item?.price || entry.price || 0),
            storeId: entry.item?.store_id || entry.store_id,
            storeName: entry.item?.store?.name || '',
            moduleId: entry.item?.module_id || 4,
          })),
        };
      }
      return { success: false, message: 'Wishlist is empty' };
    } catch (error) {
      this.logger.error(`Failed to get wishlist: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Add item to wishlist
   */
  async addToWishlist(token: string, itemId: number): Promise<{
    success: boolean;
    message?: string;
  }> {
    try {
      this.logger.log(`❤️ Adding item ${itemId} to wishlist`);
      await this.authenticatedRequest('post', '/api/v1/customer/wish-list/add', token, {
        item_id: itemId,
        model: 'Item',
      });
      return { success: true, message: 'Added to wishlist' };
    } catch (error) {
      this.logger.error(`Failed to add to wishlist: ${error.message}`);
      return { success: false, message: error.response?.data?.message || error.message };
    }
  }

  /**
   * Remove item from wishlist
   */
  async removeFromWishlist(token: string, itemId: number): Promise<{
    success: boolean;
    message?: string;
  }> {
    try {
      this.logger.log(`🗑️ Removing item ${itemId} from wishlist`);
      await this.authenticatedRequest('delete', '/api/v1/customer/wish-list/remove', token, {
        item_id: itemId,
        model: 'Item',
      });
      return { success: true, message: 'Removed from wishlist' };
    } catch (error) {
      this.logger.error(`Failed to remove from wishlist: ${error.message}`);
      return { success: false, message: error.response?.data?.message || error.message };
    }
  }
}
