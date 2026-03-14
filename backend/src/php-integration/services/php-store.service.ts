import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpApiService } from './php-api.service';
import { CircuitBreakerService } from '../../common/services/circuit-breaker.service';

@Injectable()
export class PhpStoreService extends PhpApiService {
  constructor(configService: ConfigService, circuitBreaker: CircuitBreakerService) {
    super(configService, circuitBreaker);
  }

  /**
   * Get store details with zone-aware pricing/availability
   */
  async getStoreDetails(storeId: number, lat?: number, lng?: number, zoneId?: number): Promise<any> {
    try {
      this.logger.log(`🏪 Fetching store details for ID: ${storeId} (Zone: ${zoneId || 'Default'})`);

      const headers: any = {};
      if (zoneId) headers['zoneId'] = JSON.stringify([zoneId]);

      const params: any = {};
      if (lat) params['lat'] = lat;
      if (lng) params['lng'] = lng;

      const response = await this.get(
        `/api/v1/stores/details/${storeId}`,
        params,
        headers
      );

      return response;
    } catch (error) {
      this.logger.error(`Failed to fetch store details: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get store menu/items with zone-aware pricing
   */
  async getStoreMenu(storeId: number, lat?: number, lng?: number, zoneId?: number): Promise<any> {
    try {
      this.logger.log(`📜 Fetching menu for store ID: ${storeId} (Zone: ${zoneId || 'Default'})`);

      const headers: any = {};
      if (zoneId) headers['zoneId'] = JSON.stringify([zoneId]);

      const params: any = {};
      if (lat) params['lat'] = lat;
      if (lng) params['lng'] = lng;

      // Note: Endpoint might be /api/v1/items/latest or similar depending on PHP backend
      // Assuming /api/v1/items/latest?store_id=X based on typical structure, 
      // or the one used in FunctionExecutor: /api/v1/restaurants/{id}/menu
      
      // Let's stick to the one observed in FunctionExecutor for now, but make it zone-aware
      const response = await this.get(
        `/api/v1/restaurants/${storeId}/menu`,
        params,
        headers
      );

      return response;
    } catch (error) {
      this.logger.error(`Failed to fetch store menu: ${error.message}`);
      throw error;
    }
  }

  /**
   * Validate cart items availability and pricing for the zone
   */
  async validateCart(items: any[], zoneId?: number): Promise<any> {
    try {
      this.logger.log(`🛒 Validating cart items (Zone: ${zoneId || 'Default'})`);

      const headers: any = {};
      if (zoneId) headers['zoneId'] = JSON.stringify([zoneId]);

      const validatedItems = [];
      let totalAmount = 0;
      let storeId = null;

      for (const item of items) {
        try {
          // Fetch item details to get real price and check availability
          const itemDetails: any = await this.get(
            `/api/v1/items/details/${item.id}`,
            {},
            headers
          );

          if (!itemDetails) {
            throw new Error(`Item ${item.id} not found`);
          }

          // Check if all items are from the same store
          if (storeId && storeId !== itemDetails.store_id) {
             this.logger.warn(`Mixed store cart detected: ${storeId} vs ${itemDetails.store_id}`);
          }
          storeId = itemDetails.store_id;

          // Calculate price
          const price = parseFloat(itemDetails.price);
          const quantity = item.quantity || 1;
          const itemTotal = price * quantity;

          validatedItems.push({
            ...item,
            name: itemDetails.name,
            price: price,
            total: itemTotal,
            store_id: itemDetails.store_id,
            available: true,
            details: itemDetails // Include full details for context
          });

          totalAmount += itemTotal;
        } catch (err) {
          this.logger.warn(`Failed to validate item ${item.id}: ${err.message}`);
          validatedItems.push({
            ...item,
            available: false,
            error: err.message
          });
        }
      }

      return {
        valid: validatedItems.every(i => i.available),
        items: validatedItems,
        totalAmount,
        storeId
      };

    } catch (error) {
      this.logger.error(`Cart validation failed: ${error.message}`);
      return {
        valid: false,
        message: error.message
      };
    }
  }

  /**
   * Search items via PHP Backend (Fallback)
   */
  async searchItems(query: string, zoneId?: number): Promise<any> {
    try {
      this.logger.log(`🔍 Searching items via PHP: "${query}" (Zone: ${zoneId || 'Default'})`);

      const headers: any = {};
      if (zoneId) headers['zoneId'] = JSON.stringify([zoneId]);

      const response = await this.get(
        `/api/v1/items/search`,
        { search: query },
        headers
      );

      return response;
    } catch (error) {
      this.logger.error(`PHP Search failed: ${error.message}`);
      // Return empty result instead of throwing to allow graceful degradation
      return { data: [] };
    }
  }

  /**
   * Search stores/restaurants via PHP Backend
   */
  async searchStores(query: string, zoneId?: number): Promise<any> {
    try {
      this.logger.log(`🏪 Searching stores via PHP: "${query}" (Zone: ${zoneId || 'Default'})`);

      const headers: any = {};
      if (zoneId) headers['zoneId'] = JSON.stringify([zoneId]);

      const response = await this.get(
        `/api/v1/stores/search`,
        { search: query },
        headers
      );

      return response;
    } catch (error) {
      this.logger.error(`PHP Store search failed: ${error.message}`);
      // Return empty result instead of throwing to allow graceful degradation
      return { data: [] };
    }
  }

  /**
   * Check stock availability for items
   */
  async checkItemStock(itemIds: (number | string)[], zoneId?: number): Promise<{
    allAvailable: boolean;
    items: Array<{
      id: number | string;
      available: boolean;
      stock?: number;
      name?: string;
      lowStock?: boolean;
    }>;
    unavailableItems?: string[];
  }> {
    try {
      this.logger.log(`📦 Checking stock for ${itemIds.length} items (Zone: ${zoneId || 'Default'})`);

      const headers: any = {};
      if (zoneId) headers['zoneId'] = JSON.stringify([zoneId]);

      const itemStatuses = [];
      const unavailableItems: string[] = [];
      
      for (const itemId of itemIds) {
        try {
          const itemDetails: any = await this.get(
            `/api/v1/items/details/${itemId}`,
            {},
            headers
          );

          const stock = itemDetails?.stock ?? 100;
          const isAvailable = itemDetails && stock !== 0 && itemDetails.available !== false;
          const isLowStock = stock > 0 && stock < 10;
          const name = itemDetails?.name || `Item ${itemId}`;
          
          if (!isAvailable) {
            unavailableItems.push(name);
          }
          
          itemStatuses.push({
            id: itemId,
            available: isAvailable,
            stock: stock,
            name: name,
            lowStock: isLowStock,
          });
        } catch (err) {
          this.logger.warn(`Failed to check stock for item ${itemId}: ${err.message}`);
          const name = `Item ${itemId}`;
          unavailableItems.push(name);
          itemStatuses.push({
            id: itemId,
            available: false,
            name: name,
            lowStock: false,
          });
        }
      }

      return {
        allAvailable: itemStatuses.every(item => item.available),
        items: itemStatuses,
        unavailableItems,
      };
    } catch (error) {
      this.logger.error(`Stock check failed: ${error.message}`);
      return {
        allAvailable: false,
        items: itemIds.map(id => ({ id, available: false, lowStock: false })),
        unavailableItems: itemIds.map(id => `Item ${id}`),
      };
    }
  }

  /**
   * Check store availability (accepting orders)
   */
  async checkStoreAvailability(storeId: number, zoneId?: number): Promise<{
    acceptingOrders: boolean;
    open: boolean;
    message?: string;
    nextOpenTime?: string;
  }> {
    try {
      this.logger.log(`🏪 Checking store ${storeId} availability (Zone: ${zoneId || 'Default'})`);

      const headers: any = {};
      if (zoneId) headers['zoneId'] = JSON.stringify([zoneId]);

      const storeDetails: any = await this.get(
        `/api/v1/stores/details/${storeId}`,
        {},
        headers
      );

      const isOpen = storeDetails?.open ?? storeDetails?.is_open ?? true;
      const acceptingOrders = storeDetails?.accepting_orders ?? storeDetails?.active ?? isOpen;

      return {
        acceptingOrders,
        open: isOpen,
        message: acceptingOrders ? undefined : 'Store is currently not accepting orders',
        nextOpenTime: storeDetails?.next_open_time || storeDetails?.opening_time,
      };
    } catch (error) {
      this.logger.error(`Store availability check failed: ${error.message}`);
      return {
        acceptingOrders: false,
        open: false,
        message: 'Unable to check store availability',
      };
    }
  }
}
