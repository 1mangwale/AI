import { Controller, Post, Body, Logger, HttpCode, Res } from '@nestjs/common';
import { Response } from 'express';
import { WhatsAppFlowTokenService, FlowTokenData } from '../services/whatsapp-flow-token.service';
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
    const { action, flow_token, screen, data, version } = body;
    this.logger.log(`Flow data-exchange: action=${action}, screen=${screen}, version=${version}`);

    // Health check
    if (action === 'ping') {
      res.json({ data: { status: 'active' } });
      return;
    }

    // Validate flow token
    const tokenData = await this.flowTokenService.validateToken(flow_token);
    if (!tokenData) {
      this.logger.warn(`Invalid flow token: ${(flow_token || '').substring(0, 12)}...`);
      res.json({
        data: { error: true },
        screen: 'ERROR',
      });
      return;
    }

    try {
      const result = await this.routeFlowAction(action, screen, data, tokenData);
      res.json(result);
    } catch (err) {
      this.logger.error(`Flow data-exchange error: ${err.message}`, err.stack);
      res.json({
        data: { error: true },
        screen: 'ERROR',
      });
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
}
