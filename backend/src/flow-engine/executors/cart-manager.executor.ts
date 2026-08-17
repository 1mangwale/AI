import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';

interface FoodVariation {
  type: string;
  price: string;
}

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
  variation?: FoodVariation[];
  variationLabel?: string;
}

/**
 * Cart Manager Executor
 * 
 * Handles cart operations with multi-store support.
 * Users can add items from multiple restaurants. At checkout,
 * items are grouped by store and separate orders are placed per store.
 * 
 * Operations:
 * - add: Add items to cart (supports multi-store)
 * - remove: Remove item from cart
 * - clear: Clear entire cart
 * - validate: Check if cart is valid for checkout (groups by store)
 */
@Injectable()
export class CartManagerExecutor implements ActionExecutor {
  readonly name = 'cart_manager';
  private readonly logger = new Logger(CartManagerExecutor.name);

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      const operation = config.operation || 'add';
      
      switch (operation) {
        case 'add':
          return this.addToCart(config, context);
        case 'remove':
          return this.removeFromCart(config, context);
        case 'clear':
          return this.clearCart(context);
        case 'validate':
          return this.validateCart(config, context);
        default:
          return {
            success: false,
            error: `Unknown cart operation: ${operation}`,
            event: 'error',
          };
      }
    } catch (error) {
      this.logger.error(`Cart operation failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
        event: 'error',
      };
    }
  }

  /**
   * Add items to cart with multi-store support
   */
  private addToCart(config: any, context: FlowContext): ActionExecutionResult {
    // Get new items to add
    const newItemsPath = config.newItemsPath || 'selection_result.selectedItems';
    const newItems = this.getNestedValue(context.data, newItemsPath) as CartItem[];
    
    if (!newItems || !Array.isArray(newItems) || newItems.length === 0) {
      return {
        success: false,
        error: 'No items to add to cart',
        event: 'no_items',
      };
    }

    // Get existing cart items
    const existingCart = (context.data.cart_items as CartItem[]) || [];

    // Multi-store support: allow items from any store
    // Merge items - update quantities for existing items or add new ones
    // Items with different variations are treated as separate line items
    const updatedCart = [...existingCart];
    
    for (const newItem of newItems) {
      const variationKey = newItem.variationLabel || '';
      const existingIndex = updatedCart.findIndex(
        item => item.itemId === newItem.itemId && (item.variationLabel || '') === variationKey
      );
      
      if (existingIndex >= 0) {
        // Update quantity of existing item
        updatedCart[existingIndex] = {
          ...updatedCart[existingIndex],
          quantity: updatedCart[existingIndex].quantity + newItem.quantity,
        };
        this.logger.debug(`Updated quantity: ${newItem.itemName} now has ${updatedCart[existingIndex].quantity}`);
      } else {
        // Add new item
        updatedCart.push(newItem);
        this.logger.debug(`Added to cart: ${newItem.itemName} x${newItem.quantity}`);
      }
    }

    // Calculate total
    const totalPrice = updatedCart.reduce(
      (sum, item) => sum + (item.price * item.quantity), 
      0
    );
    const totalItems = updatedCart.reduce(
      (sum, item) => sum + item.quantity, 
      0
    );

    // Group by store for summary
    const storeGroups = this.groupByStore(updatedCart);
    const storeCount = Object.keys(storeGroups).length;

    // Build cart summary message (grouped by store if multi-store)
    const cartSummary = this.buildCartSummary(updatedCart, totalPrice);

    // Convert cart items to card format for display
    const cartCards = this.convertToCards(updatedCart);

    this.logger.log(`🛒 Cart updated: ${updatedCart.length} unique items, ${totalItems} total qty, ₹${totalPrice}, ${storeCount} store(s)`);

    return {
      success: true,
      output: {
        cart_items: cartCards, // Cards format for display
        cart_data: updatedCart, // Raw cart data for processing  
        selected_items: updatedCart, // For backwards compatibility
        totalPrice,
        totalItems,
        storeId: updatedCart[0]?.storeId, // Primary store (first item)
        storeName: updatedCart[0]?.storeName,
        cartSummary,
        itemsAdded: newItems.length,
        storeCount,
        isMultiStore: storeCount > 1,
      },
      event: 'items_added',
    };
  }

  /**
   * Group cart items by store ID
   */
  private groupByStore(cart: CartItem[]): Record<string, { storeName: string; storeId: number; items: CartItem[]; total: number }> {
    const groups: Record<string, { storeName: string; storeId: number; items: CartItem[]; total: number }> = {};
    
    for (const item of cart) {
      const key = String(item.storeId || 'unknown');
      if (!groups[key]) {
        groups[key] = {
          storeName: item.storeName || 'Unknown Store',
          storeId: item.storeId || 0,
          items: [],
          total: 0,
        };
      }
      groups[key].items.push(item);
      groups[key].total += item.price * item.quantity;
    }
    
    return groups;
  }

  /**
   * Convert cart items to card format for UI display
   * Compatible with ProductCard interface in frontend
   */
  private convertToCards(cart: CartItem[]): any[] {
    return cart.map((item, index) => ({
      id: String(item.itemId),
      name: item.variationLabel 
        ? `${item.itemName} (${item.variationLabel}) x${item.quantity}`
        : `${item.itemName} x${item.quantity}`,
      image: '', // Cart items may not have images - will show placeholder
      price: `₹${item.price * item.quantity}`,
      description: item.storeName ? `From ${item.storeName} • ₹${item.price} each` : `₹${item.price} each`,
      storeName: item.storeName,
      storeId: item.storeId,
      // Badge to show quantity
      badges: item.variationLabel ? [`x${item.quantity}`, item.variationLabel] : [`x${item.quantity}`],
      // Cart-specific action
      action: {
        label: '➖ Remove',
        value: `remove ${item.itemName}`,
      },
      // Extra data for cart operations
      quantity: item.quantity,
      unitPrice: item.price,
      itemTotal: item.price * item.quantity,
      isCartItem: true,
      variation: item.variation,
      variationLabel: item.variationLabel,
    }));
  }

  /**
   * Remove item from cart by itemId, index, or itemName (fuzzy match)
   */
  private removeFromCart(config: any, context: FlowContext): ActionExecutionResult {
    const existingCart = (context.data.cart_items as CartItem[]) || [];
    const itemId = config.itemId;
    const itemIndex = config.itemIndex;
    const itemName = config.itemName;
    const userMessage = (context.data._user_message || context.data.user_message) as string;

    if (existingCart.length === 0) {
      return {
        success: true,
        output: {
          cart_items: [],
          message: 'Cart is already empty',
        },
        event: 'cart_empty',
      };
    }

    let updatedCart: CartItem[];
    let removedItem: CartItem | undefined;

    if (itemId !== undefined) {
      removedItem = existingCart.find(item => item.itemId === itemId);
      updatedCart = existingCart.filter(item => item.itemId !== itemId);
    } else if (itemIndex !== undefined && itemIndex >= 0 && itemIndex < existingCart.length) {
      removedItem = existingCart[itemIndex];
      updatedCart = existingCart.filter((_, idx) => idx !== itemIndex);
    } else if (itemName) {
      // Fuzzy match by item name
      const matchResult = this.findItemByName(existingCart, itemName);
      if (matchResult) {
        removedItem = matchResult;
        updatedCart = existingCart.filter(item => item.itemId !== matchResult.itemId);
      } else {
        return {
          success: false,
          error: `Item "${itemName}" not found in cart`,
          event: 'item_not_found',
        };
      }
    } else if (userMessage) {
      // Try to extract item name from user message and fuzzy match
      const extractedItem = this.extractItemNameFromMessage(userMessage);
      if (extractedItem) {
        const matchResult = this.findItemByName(existingCart, extractedItem);
        if (matchResult) {
          removedItem = matchResult;
          updatedCart = existingCart.filter(item => item.itemId !== matchResult.itemId);
          this.logger.log(`🎯 Matched "${extractedItem}" from message to cart item: ${matchResult.itemName}`);
        } else {
          return {
            success: false,
            error: `Item "${extractedItem}" not found in cart`,
            event: 'item_not_found',
          };
        }
      } else {
        return {
          success: false,
          error: 'Could not determine which item to remove',
          event: 'item_not_found',
        };
      }
    } else {
      return {
        success: false,
        error: 'No itemId, itemIndex, or itemName provided for removal',
        event: 'error',
      };
    }

    const totalPrice = updatedCart.reduce(
      (sum, item) => sum + (item.price * item.quantity), 
      0
    );

    return {
      success: true,
      output: {
        cart_items: updatedCart,
        selected_items: updatedCart,
        totalPrice,
        removedItem,
        message: removedItem 
          ? `Removed ${removedItem.itemName} from cart` 
          : 'Item not found in cart',
      },
      event: updatedCart.length > 0 ? 'item_removed' : 'cart_empty',
    };
  }

  /**
   * Extract item name from user message like "remove dal fry from cart"
   */
  private extractItemNameFromMessage(message: string): string | null {
    const lowerMsg = message.toLowerCase();
    
    // Patterns to extract item name
    const patterns = [
      /remove\s+(.+?)\s*(?:from\s*)?(?:cart|order)?$/i,
      /delete\s+(.+?)\s*(?:from\s*)?(?:cart|order)?$/i,
      /cancel\s+(.+?)\s*(?:from\s*)?(?:cart|order)?$/i,
      /(.+?)\s+hatao/i,
      /(.+?)\s+nikalo/i,
      /cart\s+se\s+(.+?)\s*(?:hatao|nikalo)?$/i,
      /(.+?)\s+nahi\s+chahiye/i,
    ];

    for (const pattern of patterns) {
      const match = lowerMsg.match(pattern);
      if (match && match[1]) {
        // Clean up the extracted name
        let itemName = match[1].trim();
        // Remove common words
        itemName = itemName.replace(/\b(the|a|an|my|this|that|one|from|cart|order)\b/gi, '').trim();
        if (itemName.length > 1) {
          this.logger.debug(`Extracted item name: "${itemName}" from message: "${message}"`);
          return itemName;
        }
      }
    }
    return null;
  }

  /**
   * Find cart item by fuzzy name match
   */
  private findItemByName(cart: CartItem[], searchName: string): CartItem | undefined {
    const searchLower = searchName.toLowerCase().trim();
    
    // First try exact match
    let match = cart.find(item => 
      item.itemName.toLowerCase() === searchLower
    );
    if (match) return match;

    // Try contains match
    match = cart.find(item => 
      item.itemName.toLowerCase().includes(searchLower) ||
      searchLower.includes(item.itemName.toLowerCase())
    );
    if (match) return match;

    // Try word-based fuzzy match
    const searchWords = searchLower.split(/\s+/).filter(w => w.length > 2);
    let bestMatch: CartItem | undefined;
    let bestScore = 0;

    for (const item of cart) {
      const itemWords = item.itemName.toLowerCase().split(/\s+/);
      let matchCount = 0;
      
      for (const searchWord of searchWords) {
        if (itemWords.some(iw => iw.includes(searchWord) || searchWord.includes(iw))) {
          matchCount++;
        }
      }
      
      const score = searchWords.length > 0 ? matchCount / searchWords.length : 0;
      if (score > bestScore && score >= 0.5) {
        bestScore = score;
        bestMatch = item;
      }
    }

    if (bestMatch) {
      this.logger.log(`🔍 Fuzzy match: "${searchName}" → "${bestMatch.itemName}" (score: ${bestScore})`);
    }

    return bestMatch;
  }

  /**
   * Clear entire cart
   */
  private clearCart(context: FlowContext): ActionExecutionResult {
    this.logger.log('🗑️ Clearing cart');
    
    // Directly clear cart in context to ensure subsequent actions see empty cart
    context.data.cart_items = [];
    context.data.selected_items = [];
    context.data.cart_total = 0;
    context.data.cart_store_id = null;
    context.data.cart_store_name = null;
    
    return {
      success: true,
      output: {
        cart_items: [],
        selected_items: [],
        totalPrice: 0,
        totalItems: 0,
        message: 'Cart cleared successfully',
      },
      event: 'cart_cleared',
    };
  }

  /**
   * Validate cart for checkout — supports multi-store carts
   * Groups items by store for separate order placement
   */
  private validateCart(config: any, context: FlowContext): ActionExecutionResult {
    const cart = (context.data.cart_items as CartItem[]) || [];

    if (cart.length === 0) {
      return {
        success: true,
        output: {
          valid: false,
          message: 'Your cart is empty. Please add some items first.',
        },
        event: 'cart_empty',
      };
    }

    // Group items by store
    const storeGroups = this.groupByStore(cart);
    const storeIds = Object.keys(storeGroups);
    const isMultiStore = storeIds.length > 1;

    // Check minimum order amount if configured
    const minOrderAmount = config.minOrderAmount || 0;
    const totalPrice = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    if (totalPrice < minOrderAmount) {
      return {
        success: true,
        output: {
          valid: false,
          totalPrice,
          minOrderAmount,
          message: `Minimum order amount is ₹${minOrderAmount}. Your current total is ₹${totalPrice}.`,
        },
        event: 'below_minimum',
      };
    }

    // Build store groups array for order placement
    const orderGroups = storeIds.map(storeId => ({
      storeId: storeGroups[storeId].storeId,
      storeName: storeGroups[storeId].storeName,
      items: storeGroups[storeId].items,
      total: storeGroups[storeId].total,
    }));

    return {
      success: true,
      output: {
        valid: true,
        cart_items: cart,
        // Display-shaped copy. add() returns cards under cart_items; validate()
        // returns raw rows there, so a caller rendering cart_items as cards got
        // nameless entries. Callers that display must use cart_cards.
        cart_cards: this.convertToCards(cart),
        totalPrice,
        totalItems: cart.reduce((sum, item) => sum + item.quantity, 0),
        storeId: storeIds.length === 1 ? storeGroups[storeIds[0]].storeId : undefined,
        isMultiStore,
        storeCount: storeIds.length,
        orderGroups, // Per-store groups for separate order placement
        message: isMultiStore 
          ? `Cart has items from ${storeIds.length} restaurants. Separate orders will be placed for each.`
          : 'Cart is ready for checkout',
      },
      event: isMultiStore ? 'multi_store_cart' : 'cart_valid',
    };
  }

  /**
   * Build user-friendly cart summary (grouped by store for multi-store carts)
   */
  private buildCartSummary(cart: CartItem[], totalPrice: number): string {
    if (cart.length === 0) {
      return 'Your cart is empty.';
    }

    const storeGroups = this.groupByStore(cart);
    const storeIds = Object.keys(storeGroups);
    const isMultiStore = storeIds.length > 1;
    const lines: string[] = ['🛒 **Your Cart**\n'];

    if (isMultiStore) {
      // Multi-store: group items under each store
      for (const storeId of storeIds) {
        const group = storeGroups[storeId];
        lines.push(`📍 **${group.storeName}**`);
        for (const item of group.items) {
          const itemTotal = item.price * item.quantity;
          const variationInfo = item.variationLabel ? ` (${item.variationLabel})` : '';
          lines.push(`  • ${item.quantity}x ${item.itemName}${variationInfo} - ₹${itemTotal.toFixed(0)}`);
        }
        lines.push(`  _Subtotal: ₹${group.total.toFixed(0)}_\n`);
      }
      lines.push(`📦 _${storeIds.length} separate orders will be placed_`);
    } else {
      // Single store
      const storeName = cart[0]?.storeName;
      if (storeName) {
        lines.push(`📍 From: ${storeName}\n`);
      }
      for (const item of cart) {
        const itemTotal = item.price * item.quantity;
        const variationInfo = item.variationLabel ? ` (${item.variationLabel})` : '';
        lines.push(`• ${item.quantity}x ${item.itemName}${variationInfo} - ₹${itemTotal.toFixed(0)}`);
      }
    }
    
    lines.push(`\n**Total: ₹${totalPrice.toFixed(0)}**`);
    
    return lines.join('\n');
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }
}
