/**
 * Inventory Executor
 * 
 * Checks stock availability and store status.
 * 
 * Actions:
 * - check_stock: Check if items are in stock
 * - check_store: Check if store is open/accepting orders
 * - validate_cart: Validate all cart items are available
 */

import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { PhpStoreService } from '../../php-integration/services/php-store.service';

@Injectable()
export class InventoryExecutor implements ActionExecutor {
  private readonly logger = new Logger(InventoryExecutor.name);
  readonly name = 'inventory';

  constructor(private readonly phpStoreService: PhpStoreService) {}

  async execute(config: Record<string, any>, context: FlowContext): Promise<ActionExecutionResult> {
    const action = config.action || 'check_stock';

    this.logger.debug(`Inventory action: ${action}`);

    try {
      switch (action) {
        case 'check_stock':
          return this.checkStock(config, context);

        case 'check_store':
          return this.checkStore(config, context);

        case 'validate_cart':
          return this.validateCart(config, context);

        default:
          return {
            success: false,
            error: `Unknown inventory action: ${action}`,
            event: 'error',
          };
      }
    } catch (error) {
      this.logger.error(`Inventory executor error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        event: 'error',
      };
    }
  }

  validate(config: Record<string, any>): boolean {
    return true; // Action defaults to check_stock
  }

  /**
   * Check stock for specific item IDs
   */
  private async checkStock(config: any, context: FlowContext): Promise<ActionExecutionResult> {
    // Get item IDs from config or context
    const itemIdsPath = config.itemIdsPath || 'selected_items';
    const items = this.resolve(context, itemIdsPath) || [];
    
    // Extract IDs if items are objects
    const itemIds = items.map((item: any) => 
      typeof item === 'number' ? item : (item.id || item.item_id)
    ).filter(Boolean);

    if (itemIds.length === 0) {
      return {
        success: true,
        output: {
          allAvailable: true,
          items: [],
          message: 'No items to check',
        },
        event: 'available',
      };
    }

    const zoneId = context.data.zone_id || context.data.zoneId;
    
    this.logger.log(`📦 Checking stock for ${itemIds.length} items`);

    const stockResult = await this.phpStoreService.checkItemStock(itemIds, zoneId);

    // Build user-friendly messages
    let message = '';
    if (!stockResult.allAvailable) {
      const unavailableNames = stockResult.items
        .filter(i => !i.available)
        .map(i => i.name || `Item #${i.id}`)
        .join(', ');
      message = `Sorry, these items are unavailable: ${unavailableNames}`;
    }

    const lowStockItems = stockResult.items.filter(i => i.lowStock);
    if (lowStockItems.length > 0) {
      const lowStockNames = lowStockItems.map(i => i.name || `Item #${i.id}`).join(', ');
      message += message ? '. ' : '';
      message += `Low stock warning: ${lowStockNames}`;
    }

    return {
      success: true,
      output: {
        allAvailable: stockResult.allAvailable,
        items: stockResult.items,
        unavailableItems: stockResult.unavailableItems,
        hasLowStock: lowStockItems.length > 0,
        message: message || 'All items available',
      },
      event: stockResult.allAvailable ? 'available' : 'unavailable',
    };
  }

  /**
   * Check if store is open and accepting orders
   */
  private async checkStore(config: any, context: FlowContext): Promise<ActionExecutionResult> {
    const storeId = this.resolve(context, config.storeIdPath) ||
                    context.data.store_id ||
                    context.data.cart_store_id ||
                    context.data.restaurant_id ||
                    context.data.selected_items?.[0]?.storeId ||
                    context.data.selected_items?.[0]?.store_id;

    if (!storeId) {
      return {
        success: false,
        error: 'Store ID is required',
        event: 'error',
      };
    }

    const zoneId = context.data.zone_id || context.data.zoneId;
    
    this.logger.log(`🏪 Checking store ${storeId} availability`);

    const availability = await this.phpStoreService.checkStoreAvailability(storeId, zoneId);

    return {
      success: true,
      output: {
        storeId,
        ...availability,
      },
      event: availability.acceptingOrders ? 'open' : 'closed',
    };
  }

  /**
   * Validate full cart - check all items and store availability
   */
  private async validateCart(config: any, context: FlowContext): Promise<ActionExecutionResult> {
    const cartPath = config.cartPath || 'selected_items';
    const items = this.resolve(context, cartPath) || [];

    if (items.length === 0) {
      return {
        success: true,
        output: {
          valid: false,
          message: 'Cart is empty',
        },
        event: 'empty',
      };
    }

    const zoneId = context.data.zone_id || context.data.zoneId;

    // Get store ID from first item
    const storeId = items[0]?.store_id || items[0]?.restaurant_id || context.data.store_id;

    // Check store availability
    if (storeId) {
      const storeAvailability = await this.phpStoreService.checkStoreAvailability(storeId, zoneId);
      if (!storeAvailability.acceptingOrders) {
        return {
          success: true,
          output: {
            valid: false,
            storeOpen: false,
            message: storeAvailability.message || 'Store is not accepting orders',
            nextOpenTime: storeAvailability.nextOpenTime,
          },
          event: 'store_closed',
        };
      }
    }

    // Check item availability
    const itemIds = items.map((item: any) => item.id || item.item_id).filter(Boolean);
    const stockResult = await this.phpStoreService.checkItemStock(itemIds, zoneId);

    if (!stockResult.allAvailable) {
      const unavailableNames = stockResult.items
        .filter(i => !i.available)
        .map(i => i.name || `Item #${i.id}`)
        .join(', ');

      return {
        success: true,
        output: {
          valid: false,
          storeOpen: true,
          allItemsAvailable: false,
          unavailableItems: stockResult.unavailableItems,
          message: `These items are unavailable: ${unavailableNames}`,
          items: stockResult.items,
        },
        event: 'items_unavailable',
      };
    }

    // All good!
    return {
      success: true,
      output: {
        valid: true,
        storeOpen: true,
        allItemsAvailable: true,
        message: 'Cart is valid',
        items: stockResult.items,
      },
      event: 'valid',
    };
  }

  /**
   * Resolve a value from context using dot notation path
   */
  private resolve(context: FlowContext, path: string): any {
    if (!path) return null;
    return path.split('.').reduce((obj, key) => obj?.[key], context.data);
  }
}
