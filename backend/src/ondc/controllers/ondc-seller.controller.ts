import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { OndcCatalogService } from '../services/ondc-catalog.service';
import { OndcRegistryService } from '../services/ondc-registry.service';
import { OndcSignatureService } from '../services/ondc-signature.service';
import { OndcSearchService } from '../services/ondc-search.service';
import {
  BecknContext,
  BecknOrder,
  BecknIntent,
  OndcAckResponse,
} from '../interfaces/ondc.interfaces';

/**
 * ONDC Seller Controller (BPP - Buyer Platform Provider)
 *
 * Receives requests from BAPs (buyer apps) via the ONDC network.
 * These are the action requests that BAPs send to interact with our catalog
 * and place orders.
 *
 * As a BPP, we:
 * - Handle /search requests by matching our catalog
 * - Handle /select to provide quotes
 * - Handle /init to initialize orders
 * - Handle /confirm to accept orders
 * - Handle /status to provide order status
 *
 * Routes: POST /ondc/seller/*
 */
@Controller('ondc/seller')
export class OndcSellerController {
  private readonly logger = new Logger(OndcSellerController.name);

  constructor(
    private readonly catalogService: OndcCatalogService,
    private readonly registryService: OndcRegistryService,
    private readonly signatureService: OndcSignatureService,
    private readonly searchService: OndcSearchService,
  ) {}

  // ============================================
  // SEARCH — BAP searching our catalog
  // ============================================

  /**
   * POST /ondc/seller/search
   *
   * A BAP sends a search request to find items in our catalog.
   * We match against our inventory and respond with matching items.
   */
  @Post('search')
  @HttpCode(HttpStatus.OK)
  async search(
    @Body() body: { context: BecknContext; message: { intent: BecknIntent } },
    @Headers('authorization') authHeader: string,
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `Search received from BAP ${body.context?.bap_id} ` +
        `txn=${body.context?.transaction_id}`,
      );

      if (!this.validateSignature(authHeader, body)) {
        return this.buildNack(body.context, 'search', 'Invalid signature');
      }

      // Log the incoming search
      await this.searchService.logTransaction(
        'search',
        body.context,
        body,
        'in_progress',
      );

      // Handle the search request asynchronously
      // We ACK immediately and send on_search callback later
      this.handleSearchAsync(body.context, body.message.intent).catch((err) => {
        this.logger.error(`Async search handling failed: ${err.message}`, err.stack);
      });

      return this.buildAck(body.context, 'search');
    } catch (error) {
      this.logger.error(`Search handler error: ${error.message}`, error.stack);
      return this.buildNack(body.context, 'search', error.message);
    }
  }

  // ============================================
  // SELECT — BAP requesting a quote
  // ============================================

  /**
   * POST /ondc/seller/select
   *
   * BAP sends selected items for a price quote.
   * We calculate prices including delivery and respond with a quote.
   */
  @Post('select')
  @HttpCode(HttpStatus.OK)
  async select(
    @Body() body: { context: BecknContext; message: { order: BecknOrder } },
    @Headers('authorization') authHeader: string,
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `Select received from BAP ${body.context?.bap_id} ` +
        `txn=${body.context?.transaction_id}`,
      );

      if (!this.validateSignature(authHeader, body)) {
        return this.buildNack(body.context, 'select', 'Invalid signature');
      }

      await this.searchService.logTransaction(
        'select',
        body.context,
        body,
        'in_progress',
      );

      // Handle select asynchronously — send on_select callback to BAP
      this.handleSelectAsync(body.context, body.message.order).catch((err) => {
        this.logger.error(`Async select handling failed: ${err.message}`, err.stack);
      });

      return this.buildAck(body.context, 'select');
    } catch (error) {
      this.logger.error(`Select handler error: ${error.message}`, error.stack);
      return this.buildNack(body.context, 'select', error.message);
    }
  }

  // ============================================
  // INIT — BAP initializing an order
  // ============================================

  /**
   * POST /ondc/seller/init
   *
   * BAP sends billing/fulfillment details to initialize the order.
   */
  @Post('init')
  @HttpCode(HttpStatus.OK)
  async init(
    @Body() body: { context: BecknContext; message: { order: BecknOrder } },
    @Headers('authorization') authHeader: string,
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `Init received from BAP ${body.context?.bap_id} ` +
        `txn=${body.context?.transaction_id}`,
      );

      if (!this.validateSignature(authHeader, body)) {
        return this.buildNack(body.context, 'init', 'Invalid signature');
      }

      await this.searchService.logTransaction(
        'init',
        body.context,
        body,
        'in_progress',
      );

      // Handle init asynchronously — send on_init callback to BAP
      this.handleInitAsync(body.context, body.message.order).catch((err) => {
        this.logger.error(`Async init handling failed: ${err.message}`, err.stack);
      });

      return this.buildAck(body.context, 'init');
    } catch (error) {
      this.logger.error(`Init handler error: ${error.message}`, error.stack);
      return this.buildNack(body.context, 'init', error.message);
    }
  }

  // ============================================
  // CONFIRM — BAP placing the order
  // ============================================

  /**
   * POST /ondc/seller/confirm
   *
   * BAP confirms the order with payment details.
   */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Body() body: { context: BecknContext; message: { order: BecknOrder } },
    @Headers('authorization') authHeader: string,
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `Confirm received from BAP ${body.context?.bap_id} ` +
        `txn=${body.context?.transaction_id}`,
      );

      if (!this.validateSignature(authHeader, body)) {
        return this.buildNack(body.context, 'confirm', 'Invalid signature');
      }

      await this.searchService.logTransaction(
        'confirm',
        body.context,
        body,
        'in_progress',
      );

      // Handle confirm asynchronously — send on_confirm callback to BAP
      this.handleConfirmAsync(body.context, body.message.order).catch((err) => {
        this.logger.error(`Async confirm handling failed: ${err.message}`, err.stack);
      });

      return this.buildAck(body.context, 'confirm');
    } catch (error) {
      this.logger.error(`Confirm handler error: ${error.message}`, error.stack);
      return this.buildNack(body.context, 'confirm', error.message);
    }
  }

  // ============================================
  // STATUS — BAP checking order status
  // ============================================

  /**
   * POST /ondc/seller/status
   *
   * BAP requests current order status.
   */
  @Post('status')
  @HttpCode(HttpStatus.OK)
  async status(
    @Body() body: { context: BecknContext; message: { order: { id: string } } },
    @Headers('authorization') authHeader: string,
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `Status received from BAP ${body.context?.bap_id} ` +
        `order=${body.message?.order?.id} txn=${body.context?.transaction_id}`,
      );

      if (!this.validateSignature(authHeader, body)) {
        return this.buildNack(body.context, 'status', 'Invalid signature');
      }

      await this.searchService.logTransaction(
        'status',
        body.context,
        body,
        'in_progress',
      );

      // Handle status asynchronously — send on_status callback to BAP
      this.handleStatusAsync(body.context, body.message.order.id).catch((err) => {
        this.logger.error(`Async status handling failed: ${err.message}`, err.stack);
      });

      return this.buildAck(body.context, 'status');
    } catch (error) {
      this.logger.error(`Status handler error: ${error.message}`, error.stack);
      return this.buildNack(body.context, 'status', error.message);
    }
  }

  // ============================================
  // REGISTRY STATUS
  // ============================================

  /**
   * GET /ondc/registry/status
   *
   * Check our ONDC registry registration status.
   * Used by admin dashboard to verify ONDC integration status.
   */
  @Get('/registry/status')
  async getRegistryStatus() {
    return this.registryService.getRegistrationStatus();
  }

  // ============================================
  // ASYNC HANDLERS (respond via callback)
  // ============================================

  /**
   * Process search and send on_search callback to BAP.
   */
  private async handleSearchAsync(
    context: BecknContext,
    intent: BecknIntent,
  ): Promise<void> {
    try {
      const catalog = await this.catalogService.handleSearchRequest(intent);

      // Send on_search callback to BAP
      const callbackContext: BecknContext = {
        ...context,
        action: 'on_search',
        timestamp: new Date().toISOString(),
      };

      const callbackPayload = {
        context: callbackContext,
        message: { catalog },
      };

      // In production: POST to context.bap_uri + '/on_search'
      this.logger.log(
        `on_search callback prepared for BAP ${context.bap_id} ` +
        `(${catalog['bpp/providers']?.length || 0} providers)`,
      );

      await this.searchService.logTransaction(
        'on_search',
        callbackContext,
        callbackPayload,
        'completed',
      );
    } catch (error) {
      this.logger.error(`Async search failed: ${error.message}`, error.stack);
    }
  }

  /**
   * Process select and send on_select callback to BAP with quote.
   */
  private async handleSelectAsync(
    context: BecknContext,
    order: BecknOrder,
  ): Promise<void> {
    try {
      // Build quote from the selected items
      // For now, return the items as-is with a basic quote
      const quote = {
        price: {
          currency: 'INR',
          value: '0', // Will be calculated from items
        },
        breakup: [] as any[],
        ttl: 'PT5M',
      };

      let totalValue = 0;

      for (const item of order.items || []) {
        // In production: look up item price from database
        const itemPrice = 100; // Placeholder
        const lineTotal = itemPrice * item.quantity.count;
        totalValue += lineTotal;

        quote.breakup.push({
          title: `Item ${item.id}`,
          price: {
            currency: 'INR',
            value: String(lineTotal),
          },
          '@ondc/org/item_id': item.id,
          '@ondc/org/item_quantity': { count: item.quantity.count },
          '@ondc/org/title_type': 'item',
        });
      }

      // Add delivery charge
      const deliveryCharge = 30;
      totalValue += deliveryCharge;
      quote.breakup.push({
        title: 'Delivery Charge',
        price: { currency: 'INR', value: String(deliveryCharge) },
        '@ondc/org/title_type': 'delivery',
      });

      quote.price.value = String(totalValue);

      const responseOrder: BecknOrder = {
        ...order,
        quote,
      };

      const callbackContext: BecknContext = {
        ...context,
        action: 'on_select',
        timestamp: new Date().toISOString(),
      };

      await this.searchService.logTransaction(
        'on_select',
        callbackContext,
        { context: callbackContext, message: { order: responseOrder } },
        'completed',
      );

      this.logger.log(`on_select callback prepared for BAP ${context.bap_id}: total=${totalValue}`);
    } catch (error) {
      this.logger.error(`Async select failed: ${error.message}`, error.stack);
    }
  }

  /**
   * Process init and send on_init callback to BAP.
   */
  private async handleInitAsync(
    context: BecknContext,
    order: BecknOrder,
  ): Promise<void> {
    try {
      // Add payment details and fulfillment info
      const responseOrder: BecknOrder = {
        ...order,
        payment: {
          ...order.payment,
          type: 'ON-FULFILLMENT',
          status: 'NOT-PAID',
          collected_by: 'BPP',
        },
      };

      const callbackContext: BecknContext = {
        ...context,
        action: 'on_init',
        timestamp: new Date().toISOString(),
      };

      await this.searchService.logTransaction(
        'on_init',
        callbackContext,
        { context: callbackContext, message: { order: responseOrder } },
        'completed',
      );

      this.logger.log(`on_init callback prepared for BAP ${context.bap_id}`);
    } catch (error) {
      this.logger.error(`Async init failed: ${error.message}`, error.stack);
    }
  }

  /**
   * Process confirm and send on_confirm callback to BAP.
   */
  private async handleConfirmAsync(
    context: BecknContext,
    order: BecknOrder,
  ): Promise<void> {
    try {
      // Generate ONDC order ID
      const ondcOrderId = `MANG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const responseOrder: BecknOrder = {
        ...order,
        id: ondcOrderId,
        state: 'Accepted',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        fulfillment: {
          ...order.fulfillment,
          state: {
            descriptor: {
              code: 'Pending',
            },
          },
        },
      };

      const callbackContext: BecknContext = {
        ...context,
        action: 'on_confirm',
        timestamp: new Date().toISOString(),
      };

      await this.searchService.logTransaction(
        'on_confirm',
        callbackContext,
        { context: callbackContext, message: { order: responseOrder } },
        'completed',
      );

      this.logger.log(`on_confirm callback prepared for BAP ${context.bap_id}: order=${ondcOrderId}`);
    } catch (error) {
      this.logger.error(`Async confirm failed: ${error.message}`, error.stack);
    }
  }

  /**
   * Process status and send on_status callback to BAP.
   */
  private async handleStatusAsync(
    context: BecknContext,
    orderId: string,
  ): Promise<void> {
    try {
      // In production: look up order from database and get real status
      const responseOrder: BecknOrder = {
        id: orderId,
        state: 'In-progress',
        fulfillment: {
          state: {
            descriptor: {
              code: 'Pending',
            },
          },
          tracking: true,
        },
        updated_at: new Date().toISOString(),
      };

      const callbackContext: BecknContext = {
        ...context,
        action: 'on_status',
        timestamp: new Date().toISOString(),
      };

      await this.searchService.logTransaction(
        'on_status',
        callbackContext,
        { context: callbackContext, message: { order: responseOrder } },
        'completed',
      );

      this.logger.log(`on_status callback prepared for BAP ${context.bap_id}: order=${orderId}`);
    } catch (error) {
      this.logger.error(`Async status failed: ${error.message}`, error.stack);
    }
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  private validateSignature(authHeader: string, body: any): boolean {
    if (!authHeader) {
      this.logger.warn('No authorization header - proceeding in sandbox mode');
      return true;
    }

    try {
      return this.signatureService.verifySignature(authHeader, JSON.stringify(body));
    } catch (error) {
      this.logger.warn(`Signature validation error: ${error.message} - proceeding anyway`);
      return true;
    }
  }

  private buildAck(context: BecknContext, action: string): OndcAckResponse {
    return {
      context: {
        ...(context || {}),
        action: action as any,
        timestamp: new Date().toISOString(),
      } as BecknContext,
      message: {
        ack: { status: 'ACK' },
      },
    };
  }

  private buildNack(
    context: BecknContext,
    action: string,
    errorMessage: string,
  ): OndcAckResponse {
    return {
      context: {
        ...(context || {}),
        action: action as any,
        timestamp: new Date().toISOString(),
      } as BecknContext,
      message: {
        ack: { status: 'NACK' },
      },
      error: {
        type: 'CORE-ERROR',
        code: '50000',
        message: errorMessage,
      },
    };
  }
}
