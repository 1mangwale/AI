import { Controller, Post, Body, Logger, HttpCode, Res } from '@nestjs/common';
import { Response } from 'express';
import { WhatsAppFlowTokenService, FlowTokenData } from '../services/whatsapp-flow-token.service';
import { WhatsAppFlowEncryptionService } from '../services/whatsapp-flow-encryption.service';
import { WhatsAppQuickOrderService } from '../services/whatsapp-quick-order.service';
import { PhpAddressService } from '../../php-integration/services/php-address.service';
import { PhpWalletService } from '../../php-integration/services/php-wallet.service';
import { SessionService } from '../../session/session.service';

/**
 * WhatsApp Flow Data Exchange Controller
 *
 * Handles requests from WhatsApp's servers during Flow interactions.
 * WhatsApp calls this endpoint at each screen transition:
 *
 *   action=ping     → health check
 *   action=INIT     → user opened the Flow, return initial screen data
 *   action=data_exchange → user submitted a screen, return next screen or close
 *   action=back     → user navigated back
 *
 * Endpoint must respond within 10 seconds or WhatsApp shows an error.
 */
@Controller('whatsapp/flows')
export class WhatsAppFlowController {
  private readonly logger = new Logger(WhatsAppFlowController.name);

  constructor(
    private readonly flowTokenService: WhatsAppFlowTokenService,
    private readonly encryptionService: WhatsAppFlowEncryptionService,
    private readonly quickOrderService: WhatsAppQuickOrderService,
    private readonly addressService: PhpAddressService,
    private readonly walletService: PhpWalletService,
    private readonly sessionService: SessionService,
  ) {}

  /**
   * WhatsApp Flow data exchange endpoint
   * Called by Meta's servers for Flow interactions
   */
  @Post('data-exchange')
  @HttpCode(200)
  async handleDataExchange(
    @Body() body: any,
    @Res() res: Response,
  ): Promise<void> {
    // Check if request is encrypted (production mode from Meta)
    const isEncrypted = this.encryptionService.isEncryptedRequest(body);

    let action: string;
    let flow_token: string;
    let screen: string;
    let data: any;
    let version: string;
    let aesKey: Buffer | null = null;
    let iv: Buffer | null = null;

    if (isEncrypted) {
      // Decrypt the request payload
      try {
        const decrypted = this.encryptionService.decryptRequest(body);
        ({ action, flow_token, screen, data, version } = decrypted.decryptedData);
        aesKey = decrypted.aesKey;
        iv = decrypted.iv;
        this.logger.log(`Flow data-exchange (encrypted): action=${action}, screen=${screen}`);
      } catch (err) {
        this.logger.error(`Flow decryption failed: ${err.message}`);
        res.status(421).send();
        return;
      }
    } else {
      // Plaintext mode (development/testing)
      ({ action, flow_token, screen, data, version } = body);
      this.logger.log(`Flow data-exchange: action=${action}, screen=${screen}, version=${version}`);
    }

    // Health check
    if (action === 'ping') {
      const pingResponse = { data: { status: 'active' } };
      this.sendFlowResponse(res, pingResponse, isEncrypted, aesKey, iv);
      return;
    }

    // Validate flow token
    const tokenData = await this.flowTokenService.validateToken(flow_token);
    if (!tokenData) {
      this.logger.warn(`Invalid flow token: ${(flow_token || '').substring(0, 12)}...`);
      const errorResponse = { data: { error: true }, screen: 'ERROR' };
      this.sendFlowResponse(res, errorResponse, isEncrypted, aesKey, iv);
      return;
    }

    try {
      const result = await this.routeFlowAction(action, screen, data, tokenData);
      this.sendFlowResponse(res, result, isEncrypted, aesKey, iv);
    } catch (err) {
      this.logger.error(`Flow data-exchange error: ${err.message}`, err.stack);
      const errorResponse = { data: { error: true }, screen: 'ERROR' };
      this.sendFlowResponse(res, errorResponse, isEncrypted, aesKey, iv);
    }
  }

  /**
   * Send response — encrypted (text/plain base64) or plaintext (JSON)
   */
  private sendFlowResponse(
    res: Response,
    responseData: any,
    encrypted: boolean,
    aesKey: Buffer | null,
    iv: Buffer | null,
  ): void {
    if (encrypted && aesKey && iv) {
      try {
        const encryptedResponse = this.encryptionService.encryptResponse(responseData, aesKey, iv);
        res.setHeader('Content-Type', 'text/plain');
        res.send(encryptedResponse);
      } catch (err) {
        this.logger.error(`Flow response encryption failed: ${err.message}`);
        res.status(500).send();
      }
    } else {
      res.json(responseData);
    }
  }

  /**
   * Route the Flow action to the appropriate handler based on flowType
   */
  private async routeFlowAction(
    action: string,
    screen: string,
    data: any,
    tokenData: FlowTokenData,
  ): Promise<any> {
    const { flowType } = tokenData;

    switch (flowType) {
      case 'address_selection':
        return this.handleAddressFlow(action, screen, data, tokenData);
      case 'payment_selection':
        return this.handlePaymentFlow(action, screen, data, tokenData);
      case 'item_customization':
        return this.handleCustomizationFlow(action, screen, data, tokenData);
      case 'quick_order':
        return this.handleQuickOrderFlow(action, screen, data, tokenData);
      case 'quick_reorder':
        return this.handleQuickReorderFlow(action, screen, data, tokenData);
      default:
        this.logger.warn(`Unknown flowType: ${flowType}`);
        return { data: { error: true }, screen: 'ERROR' };
    }
  }

  // ── Address Selection Flow ─────────────────────────────────

  private async handleAddressFlow(
    action: string,
    screen: string,
    data: any,
    tokenData: FlowTokenData,
  ): Promise<any> {
    const { phone } = tokenData;
    const session = await this.sessionService.getSession(phone);
    const authToken = session?.data?.auth_token;

    if (action === 'INIT' || (action === 'data_exchange' && screen === 'ADDRESS_LIST')) {
      // Fetch saved addresses
      let addresses: any[] = [];
      if (authToken) {
        try {
          addresses = await this.addressService.getAddresses(authToken) || [];
        } catch (e) {
          this.logger.warn(`Failed to fetch addresses: ${e.message}`);
        }
      }

      const addressOptions = addresses.map((addr: any) => ({
        id: String(addr.id),
        title: addr.type === 'home' ? '🏠 Home' : addr.type === 'office' ? '🏢 Office' : `📍 ${addr.address || 'Saved Address'}`,
        description: addr.address || `${addr.latitude}, ${addr.longitude}`,
      }));

      return {
        screen: 'ADDRESS_LIST',
        data: {
          addresses: addressOptions,
          has_addresses: addressOptions.length > 0,
        },
      };
    }

    if (action === 'data_exchange' && screen === 'ADDRESS_CONFIRM') {
      // User selected an address or entered a new one
      const selectedId = data?.selected_address_id;
      const newAddress = data?.new_address;

      // Store in session for the flow engine to pick up
      if (selectedId) {
        // Fetch full address details
        let addresses: any[] = [];
        if (authToken) {
          addresses = await this.addressService.getAddresses(authToken) || [];
        }
        const selected = addresses.find((a: any) => String(a.id) === String(selectedId));
        if (selected) {
          await this.sessionService.setData(phone, 'flow_address_result', {
            source: 'saved',
            addressId: selected.id,
            lat: selected.latitude,
            lng: selected.longitude,
            address: selected.address,
            addressType: selected.type,
          });
        }
      } else if (newAddress) {
        await this.sessionService.setData(phone, 'flow_address_result', {
          source: 'new',
          lat: newAddress.latitude,
          lng: newAddress.longitude,
          address: newAddress.text || newAddress.address,
          house: newAddress.house_number,
          landmark: newAddress.landmark,
        });
      }

      // Close the Flow — the nfm_reply webhook handler will resume the flow engine
      return {
        screen: 'SUCCESS',
        data: {
          extension_message_response: {
            params: {
              flow_token: data?.flow_token,
              status: 'address_selected',
            },
          },
        },
      };
    }

    return { screen: 'ADDRESS_LIST', data: {} };
  }

  // ── Payment Selection Flow ─────────────────────────────────

  private async handlePaymentFlow(
    action: string,
    screen: string,
    data: any,
    tokenData: FlowTokenData,
  ): Promise<any> {
    const { phone } = tokenData;
    const session = await this.sessionService.getSession(phone);
    const authToken = session?.data?.auth_token;

    if (action === 'INIT' || (action === 'data_exchange' && screen === 'PAYMENT_OPTIONS')) {
      // Fetch wallet balance
      let walletBalance = 0;
      let formattedBalance = '₹0.00';
      if (authToken) {
        try {
          const result = await this.walletService.getWalletBalance(authToken);
          if (result.success) {
            walletBalance = result.balance;
            formattedBalance = result.formattedBalance;
          }
        } catch (e) {
          this.logger.warn(`Failed to fetch wallet: ${e.message}`);
        }
      }

      const orderTotal = tokenData.data?.orderTotal || 0;

      return {
        screen: 'PAYMENT_OPTIONS',
        data: {
          wallet_balance: walletBalance,
          formatted_balance: formattedBalance,
          order_total: orderTotal,
          can_use_wallet: walletBalance >= orderTotal,
          can_partial_pay: walletBalance > 0 && walletBalance < orderTotal,
          partial_remaining: Math.max(0, orderTotal - walletBalance),
        },
      };
    }

    if (action === 'data_exchange' && screen === 'PAYMENT_CONFIRM') {
      const paymentMethod = data?.payment_method; // 'wallet', 'cod', 'digital_payment', 'partial'

      await this.sessionService.setData(phone, 'flow_payment_result', {
        payment_method: paymentMethod,
        timestamp: Date.now(),
      });

      return {
        screen: 'SUCCESS',
        data: {
          extension_message_response: {
            params: {
              flow_token: data?.flow_token,
              status: 'payment_selected',
              payment_method: paymentMethod,
            },
          },
        },
      };
    }

    return { screen: 'PAYMENT_OPTIONS', data: {} };
  }

  // ── Item Customization Flow ────────────────────────────────

  private async handleCustomizationFlow(
    action: string,
    screen: string,
    data: any,
    tokenData: FlowTokenData,
  ): Promise<any> {
    if (action === 'INIT') {
      // Return item details + available add-ons
      const itemData = tokenData.data?.item || {};
      return {
        screen: 'CUSTOMIZE',
        data: {
          item_name: itemData.name || 'Item',
          item_price: itemData.price || 0,
          current_quantity: itemData.quantity || 1,
          add_ons: itemData.addOns || [],
          max_quantity: 10,
        },
      };
    }

    if (action === 'data_exchange' && screen === 'CUSTOMIZE_CONFIRM') {
      const { phone } = tokenData;
      await this.sessionService.setData(phone, 'flow_customization_result', {
        quantity: data?.quantity || 1,
        addOns: data?.selected_add_ons || [],
        instructions: data?.special_instructions || '',
        timestamp: Date.now(),
      });

      return {
        screen: 'SUCCESS',
        data: {
          extension_message_response: {
            params: {
              flow_token: data?.flow_token,
              status: 'customization_done',
            },
          },
        },
      };
    }

    return { screen: 'CUSTOMIZE', data: {} };
  }

  // ── Quick Order Flow ─────────────────────────────────────

  private async handleQuickOrderFlow(
    action: string,
    screen: string,
    data: any,
    tokenData: FlowTokenData,
  ): Promise<any> {
    const { phone } = tokenData;
    const session = await this.sessionService.getSession(phone);
    const authToken = session?.data?.auth_token;
    const location = session?.data?.location;

    // Screen 1: Restaurant selection
    if (action === 'INIT' || (action === 'data_exchange' && screen === 'RESTAURANT_SELECT')) {
      const lat = location?.lat || tokenData.data?.lat || 19.96;
      const lng = location?.lng || tokenData.data?.lng || 73.76;

      const { restaurants } = await this.quickOrderService.getNearbyRestaurants(lat, lng);

      if (restaurants.length === 0) {
        return {
          screen: 'RESTAURANT_SELECT',
          data: {
            restaurants: [{ id: '0', title: 'No restaurants found', description: 'Please try a different location' }],
            has_restaurants: false,
          },
        };
      }

      return {
        screen: 'RESTAURANT_SELECT',
        data: {
          restaurants,
          has_restaurants: true,
        },
      };
    }

    // Screen 2: Menu browse
    if (action === 'data_exchange' && screen === 'MENU_BROWSE') {
      const storeId = parseInt(data?.selected_restaurant_id || '0');
      if (!storeId) return { screen: 'RESTAURANT_SELECT', data: {} };

      // Store selected restaurant in session
      await this.sessionService.setData(phone, 'quick_order_store_id', storeId);

      const { categories } = await this.quickOrderService.getMenuForStore(
        storeId,
        location?.lat,
        location?.lng,
      );

      return {
        screen: 'MENU_BROWSE',
        data: {
          categories,
          store_id: storeId,
        },
      };
    }

    // Screen 3: Cart review
    if (action === 'data_exchange' && screen === 'CART_REVIEW') {
      const selectedItems = data?.selected_items || [];
      const { items, subtotal } = this.quickOrderService.buildCartFromSelections(selectedItems);

      // Store cart in session
      await this.sessionService.setData(phone, 'quick_order_cart', { items, subtotal });

      const deliveryFee = 40; // Default delivery fee estimate
      return {
        screen: 'CART_REVIEW',
        data: {
          items: items.map((i: any) => ({
            id: String(i.item_id),
            title: `${i.name} x${i.quantity}`,
            description: `₹${i.price * i.quantity}`,
          })),
          subtotal,
          delivery_fee: deliveryFee,
          total: subtotal + deliveryFee,
        },
      };
    }

    // Screen 4: Checkout (address + payment)
    if (action === 'data_exchange' && screen === 'CHECKOUT') {
      let addresses: any[] = [];
      let walletBalance = 0;

      if (authToken) {
        try {
          addresses = await this.addressService.getAddresses(authToken) || [];
        } catch (e) {
          this.logger.warn(`Failed to fetch addresses: ${e.message}`);
        }
        try {
          const wallet = await this.walletService.getWalletBalance(authToken);
          if (wallet.success) walletBalance = wallet.balance;
        } catch (e) {
          this.logger.warn(`Failed to fetch wallet: ${e.message}`);
        }
      }

      const cart = session?.data?.quick_order_cart || { subtotal: 0 };
      const total = (cart.subtotal || 0) + 40;

      return {
        screen: 'CHECKOUT',
        data: {
          addresses: addresses.map((a: any) => ({
            id: String(a.id),
            title: a.type === 'home' ? '🏠 Home' : a.type === 'office' ? '🏢 Office' : `📍 ${(a.address || '').substring(0, 20)}`,
            description: (a.address || '').substring(0, 72),
          })),
          has_addresses: addresses.length > 0,
          wallet_balance: walletBalance,
          can_use_wallet: walletBalance >= total,
          order_total: total,
          payment_methods: [
            { id: 'cash_on_delivery', title: '💵 Cash on Delivery' },
            { id: 'digital_payment', title: '📱 Pay Online (UPI/Card)' },
            ...(walletBalance > 0 ? [{ id: 'wallet', title: `👛 Wallet (₹${walletBalance})` }] : []),
          ],
        },
      };
    }

    // Screen 5: Order confirmation — place the order
    if (action === 'data_exchange' && screen === 'ORDER_CONFIRM') {
      const addressId = parseInt(data?.selected_address_id || '0');
      const paymentMethod = data?.payment_method || 'cash_on_delivery';
      const cart = session?.data?.quick_order_cart;
      const storeId = session?.data?.quick_order_store_id;

      if (!authToken || !cart?.items?.length || !addressId) {
        this.logger.warn('Quick order missing required data');
        return { screen: 'CHECKOUT', data: { error: 'Missing required information' } };
      }

      const result = await this.quickOrderService.placeQuickOrder({
        phone,
        authToken,
        items: cart.items,
        addressId,
        paymentMethod,
        storeId,
      });

      // Store result in session for flow engine
      await this.sessionService.setData(phone, 'quick_order_result', result);

      // Clean up session
      await this.sessionService.setData(phone, 'quick_order_cart', null);
      await this.sessionService.setData(phone, 'quick_order_store_id', null);

      return {
        screen: 'SUCCESS',
        data: {
          extension_message_response: {
            params: {
              flow_token: data?.flow_token,
              status: result.success ? 'order_placed' : 'order_failed',
              order_id: result.orderId,
              payment_link: result.paymentLink,
            },
          },
        },
      };
    }

    return { screen: 'RESTAURANT_SELECT', data: {} };
  }

  // ── Quick Reorder Flow ───────────────────────────────────

  private async handleQuickReorderFlow(
    action: string,
    screen: string,
    data: any,
    tokenData: FlowTokenData,
  ): Promise<any> {
    const { phone } = tokenData;
    const session = await this.sessionService.getSession(phone);
    const authToken = session?.data?.auth_token;

    if (!authToken) {
      return {
        screen: 'ORDER_HISTORY',
        data: { orders: [], has_orders: false, error: 'Please log in first' },
      };
    }

    // Screen 1: Order history
    if (action === 'INIT' || (action === 'data_exchange' && screen === 'ORDER_HISTORY')) {
      const orders = await this.quickOrderService.getRecentOrders(authToken, 5);

      return {
        screen: 'ORDER_HISTORY',
        data: {
          orders: orders.map((o) => ({
            id: o.id,
            title: o.title,
            description: o.description,
          })),
          has_orders: orders.length > 0,
        },
      };
    }

    // Screen 2: Modify order (adjust quantities)
    if (action === 'data_exchange' && screen === 'MODIFY_ORDER') {
      const selectedOrderId = data?.selected_order_id;
      const orders = await this.quickOrderService.getRecentOrders(authToken, 5);
      const selectedOrder = orders.find((o) => o.id === selectedOrderId);

      if (!selectedOrder) {
        return { screen: 'ORDER_HISTORY', data: {} };
      }

      // Store selected order in session
      await this.sessionService.setData(phone, 'reorder_selected', selectedOrder);

      return {
        screen: 'MODIFY_ORDER',
        data: {
          items: selectedOrder.items.map((i: any) => ({
            id: String(i.item_id),
            title: (i.name || 'Item').substring(0, 24),
            description: `₹${i.price} × ${i.quantity}`,
            quantity: i.quantity,
          })),
          address_id: selectedOrder.addressId,
          payment_method: selectedOrder.paymentMethod,
        },
      };
    }

    // Screen 3: Confirm reorder
    if (action === 'data_exchange' && screen === 'REORDER_CONFIRM') {
      const modifiedItems = data?.items || [];
      const addressId = data?.address_id || session?.data?.reorder_selected?.addressId;
      const paymentMethod = data?.payment_method || session?.data?.reorder_selected?.paymentMethod || 'cash_on_delivery';
      const selectedOrder = session?.data?.reorder_selected;

      if (!modifiedItems.length || !addressId) {
        return { screen: 'MODIFY_ORDER', data: { error: 'Missing items or address' } };
      }

      // Place the reorder
      const result = await this.quickOrderService.placeQuickOrder({
        phone,
        authToken,
        items: modifiedItems.map((i: any) => ({
          item_id: parseInt(i.id || i.item_id),
          quantity: i.quantity || 1,
          variation: [],
          add_on_ids: [],
          add_on_qtys: [],
        })),
        addressId: parseInt(addressId),
        paymentMethod,
        storeId: parseInt(selectedOrder?.storeId || '0'),
      });

      // Clean up
      await this.sessionService.setData(phone, 'reorder_selected', null);

      return {
        screen: 'SUCCESS',
        data: {
          extension_message_response: {
            params: {
              flow_token: data?.flow_token,
              status: result.success ? 'reorder_placed' : 'reorder_failed',
              order_id: result.orderId,
              payment_link: result.paymentLink,
            },
          },
        },
      };
    }

    return { screen: 'ORDER_HISTORY', data: {} };
  }
}
