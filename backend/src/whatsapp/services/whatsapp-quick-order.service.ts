import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PhpOrderService } from '../../php-integration/services/php-order.service';
import { PhpAddressService } from '../../php-integration/services/php-address.service';
import { PhpWalletService } from '../../php-integration/services/php-wallet.service';
import { WhatsAppCloudService } from './whatsapp-cloud.service';
import { SessionService } from '../../session/session.service';

/**
 * WhatsApp Quick Order Service
 *
 * Orchestrates the Quick Order and Quick Reorder WhatsApp Flow screens.
 * Provides data for each screen transition and handles final order placement.
 *
 * Flow: Restaurant Select → Menu Browse → Cart Review → Checkout → Confirm
 */
@Injectable()
export class WhatsAppQuickOrderService {
  private readonly logger = new Logger(WhatsAppQuickOrderService.name);
  private readonly searchApiUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly phpOrderService: PhpOrderService,
    private readonly addressService: PhpAddressService,
    private readonly walletService: PhpWalletService,
    private readonly whatsapp: WhatsAppCloudService,
    private readonly sessionService: SessionService,
  ) {
    this.searchApiUrl = this.configService.get('SEARCH_API_URL', 'http://localhost:3100');
  }

  /**
   * Get nearby restaurants for the RESTAURANT_SELECT screen
   */
  async getNearbyRestaurants(lat: number, lng: number, limit = 10): Promise<{
    restaurants: Array<{
      id: string;
      title: string;
      description: string;
    }>;
  }> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.searchApiUrl}/v2/search/stores`, {
          params: {
            lat,
            lng,
            radius_km: 5,
            module_ids: '4', // Food module
            limit,
            sort: 'distance',
          },
          timeout: 10000,
        }),
      );

      const stores = response.data?.stores || response.data?.results || [];
      return {
        restaurants: stores.map((s: any) => ({
          id: String(s.id || s.store_id),
          title: (s.name || s.store_name || 'Restaurant').substring(0, 24), // WhatsApp 24 char limit
          description: [
            s.cuisine_type || s.category,
            s.distance ? `${s.distance.toFixed(1)} km` : null,
            s.avg_rating ? `⭐ ${s.avg_rating}` : null,
          ].filter(Boolean).join(' · ').substring(0, 72), // WhatsApp 72 char limit
        })),
      };
    } catch (error: any) {
      this.logger.error(`Failed to get nearby restaurants: ${error.message}`);
      return { restaurants: [] };
    }
  }

  /**
   * Get menu items for a restaurant, grouped by category for MENU_BROWSE screen
   */
  async getMenuForStore(storeId: number, lat?: number, lng?: number): Promise<{
    categories: Array<{
      id: string;
      title: string;
      items: Array<{
        id: string;
        title: string;
        description: string;
      }>;
    }>;
  }> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.searchApiUrl}/v2/search/items`, {
          params: {
            store_id: storeId,
            module_ids: '4',
            limit: 50,
            ...(lat && lng ? { lat, lng } : {}),
          },
          timeout: 10000,
        }),
      );

      const items = response.data?.items || response.data?.results || [];

      // Group by category
      const categoryMap = new Map<string, any[]>();
      for (const item of items) {
        const cat = item.category_name || item.category || 'Menu';
        if (!categoryMap.has(cat)) categoryMap.set(cat, []);
        categoryMap.get(cat)!.push(item);
      }

      // Convert to WhatsApp-compatible format (max 10 sections, 10 items per section)
      const categories: any[] = [];
      let sectionCount = 0;
      for (const [catName, catItems] of categoryMap) {
        if (sectionCount >= 10) break;
        categories.push({
          id: `cat_${sectionCount}`,
          title: catName.substring(0, 24),
          items: catItems.slice(0, 10).map((item: any) => ({
            id: String(item.id || item.item_id),
            title: (item.name || item.item_name || 'Item').substring(0, 24),
            description: `₹${item.price || 0}${item.veg ? ' 🟢' : ''}`.substring(0, 72),
          })),
        });
        sectionCount++;
      }

      return { categories };
    } catch (error: any) {
      this.logger.error(`Failed to get menu for store ${storeId}: ${error.message}`);
      return { categories: [] };
    }
  }

  /**
   * Build cart data from flow checkbox selections
   */
  buildCartFromSelections(
    selections: Array<{ itemId: string; quantity: number; name?: string; price?: number }>,
  ): { items: any[]; subtotal: number } {
    const items = selections.map((s) => ({
      item_id: parseInt(s.itemId),
      quantity: s.quantity || 1,
      name: s.name || '',
      price: s.price || 0,
      variation: [],
      add_on_ids: [],
      add_on_qtys: [],
    }));

    const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    return { items, subtotal };
  }

  /**
   * Place a quick order — full pipeline from cart to PHP order
   */
  async placeQuickOrder(params: {
    phone: string;
    authToken: string;
    items: Array<{ item_id: number; quantity: number; variation?: string[]; add_on_ids?: number[]; add_on_qtys?: number[] }>;
    addressId: number;
    paymentMethod: 'cash_on_delivery' | 'digital_payment' | 'wallet';
    storeId: number;
    couponCode?: string;
    orderNote?: string;
  }): Promise<{
    success: boolean;
    orderId?: number;
    total?: number;
    message?: string;
    paymentLink?: string;
  }> {
    try {
      // 1. Populate PHP cart for pricing
      await this.phpOrderService.populateCartForPricing(
        params.authToken,
        params.items,
        4, // Food module
      );

      // 2. Place the order
      const orderResult = await this.phpOrderService.createFoodOrder(params.authToken, {
        moduleId: 4,
        addressId: params.addressId,
        paymentMethod: params.paymentMethod,
        couponCode: params.couponCode || '',
        orderNote: params.orderNote || '',
        selectedItems: params.items,
      });

      const orderId = orderResult?.order_id || orderResult?.orderId;
      const total = orderResult?.total || orderResult?.order_amount;

      if (orderId) {
        this.logger.log(`✅ Quick order placed: #${orderId} for ${params.phone}`);

        // 3. Send WhatsApp confirmation
        await this.sendOrderConfirmation(params.phone, {
          orderId,
          total,
          paymentMethod: params.paymentMethod,
          itemCount: params.items.length,
        });

        return {
          success: true,
          orderId,
          total,
          paymentLink: orderResult?.payment_link,
        };
      }

      return { success: false, message: orderResult?.message || 'Order placement failed' };
    } catch (error: any) {
      this.logger.error(`Quick order failed for ${params.phone}: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get recent orders for Quick Reorder screen
   */
  async getRecentOrders(authToken: string, limit = 5): Promise<Array<{
    id: string;
    title: string;
    description: string;
    items: any[];
    addressId?: number;
    paymentMethod?: string;
  }>> {
    try {
      const orders = await this.phpOrderService.getOrders(authToken, limit);
      const orderList = orders || [];

      return orderList.slice(0, limit).map((order: any) => {
        const items = order.details || order.items || [];
        const itemNames = items
          .map((i: any) => {
            const details = typeof i.food_details === 'string'
              ? JSON.parse(i.food_details)
              : i.food_details || {};
            return details.name || i.name || '';
          })
          .filter(Boolean);

        return {
          id: String(order.id),
          title: `Order #${order.id} · ₹${order.order_amount || 0}`.substring(0, 24),
          description: itemNames.join(', ').substring(0, 72) || 'Order items',
          items: items.map((i: any) => {
            const details = typeof i.food_details === 'string'
              ? JSON.parse(i.food_details)
              : i.food_details || {};
            return {
              item_id: i.item_id || details.id,
              name: details.name || i.name || '',
              quantity: i.quantity || 1,
              price: i.price || details.price || 0,
            };
          }),
          addressId: order.delivery_address_id,
          paymentMethod: order.payment_method,
        };
      });
    } catch (error: any) {
      this.logger.error(`Failed to get recent orders: ${error.message}`);
      return [];
    }
  }

  /**
   * Send order confirmation via WhatsApp
   */
  private async sendOrderConfirmation(phone: string, order: {
    orderId: number;
    total: number;
    paymentMethod: string;
    itemCount: number;
  }): Promise<void> {
    try {
      const paymentLabel = order.paymentMethod === 'cash_on_delivery'
        ? '💵 Cash on Delivery'
        : order.paymentMethod === 'wallet'
          ? '👛 Wallet'
          : '📱 Online Payment';

      await this.whatsapp.sendText(phone,
        `🎉 *Order Placed!*\n\n` +
        `Order #${order.orderId}\n` +
        `📦 ${order.itemCount} item${order.itemCount > 1 ? 's' : ''}\n` +
        `💰 Total: ₹${order.total}\n` +
        `${paymentLabel}\n\n` +
        `We'll notify you when the restaurant confirms your order! 🙏`,
      );
    } catch (error: any) {
      this.logger.warn(`Failed to send order confirmation: ${error.message}`);
    }
  }
}
