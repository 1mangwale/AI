import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../database/prisma.service';
import { OndcSignatureService } from './ondc-signature.service';
import { OndcSearchService } from './ondc-search.service';
import {
  BecknContext,
  BecknAction,
  BecknOrder,
  BecknOrderItem,
  BecknBilling,
  BecknFulfillment,
  BecknPayment,
  BecknQuote,
  OndcAckResponse,
  OndcOrderRequest,
  OndcOrderResponse,
} from '../interfaces/ondc.interfaces';

/**
 * ONDC Order Service
 *
 * Handles the complete order lifecycle over the ONDC/Beckn protocol:
 *
 * BAP Flow (buyer-side):
 *   select()    -> /select to BPP   -> get quote
 *   onSelect()  <- /on_select from BPP <- receive quote
 *   init()      -> /init to BPP     -> initialize order
 *   onInit()    <- /on_init from BPP <- receive initialized order
 *   confirm()   -> /confirm to BPP  -> place order
 *   onConfirm() <- /on_confirm from BPP <- receive confirmation
 *   status()    -> /status to BPP   -> check order status
 *   onStatus()  <- /on_status from BPP <- receive status update
 *   cancel()    -> /cancel to BPP   -> cancel order
 *   onCancel()  <- /on_cancel from BPP <- receive cancellation
 *
 * Each step logs the transaction and maintains state in the ondc_transactions table.
 */
@Injectable()
export class OndcOrderService {
  private readonly logger = new Logger(OndcOrderService.name);

  private readonly bapId: string;
  private readonly bapUri: string;
  private readonly domain: string;
  private readonly city: string;
  private readonly country: string;
  private readonly coreVersion = '1.1.0';

  constructor(
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
    private readonly signatureService: OndcSignatureService,
    private readonly searchService: OndcSearchService,
    private readonly configService: ConfigService,
  ) {
    this.bapId = this.configService.get<string>('ONDC_SUBSCRIBER_ID') || '';
    this.bapUri = this.configService.get<string>('ONDC_SUBSCRIBER_URL') || '';
    this.domain = this.configService.get<string>('ONDC_DOMAIN') || 'nic2004:52110';
    this.city = this.configService.get<string>('ONDC_CITY') || 'std:020';
    this.country = this.configService.get<string>('ONDC_COUNTRY') || 'IND';
  }

  // ============================================
  // SELECT — Request Quote from BPP
  // ============================================

  /**
   * Send /select to a BPP to request a quote for selected items.
   */
  async select(
    items: BecknOrderItem[],
    providerId: string,
    bppId: string,
    bppUri: string,
    fulfillment?: BecknFulfillment,
    transactionId?: string,
  ): Promise<{ success: boolean; transactionId: string; error?: string }> {
    try {
      const txnId = transactionId || this.generateUuid();
      const messageId = this.generateUuid();
      const context = this.buildContext('select', txnId, messageId, bppId, bppUri);

      const order: BecknOrder = {
        provider: {
          id: providerId,
        },
        items,
        fulfillment,
      };

      const request: OndcOrderRequest = {
        context,
        message: { order },
      };

      await this.searchService.logTransaction('select', context, request, 'initiated');
      await this.sendToBpp(bppUri, 'select', context, { order });

      this.logger.log(`Select sent to BPP ${bppId} for txn ${txnId}`);
      return { success: true, transactionId: txnId };
    } catch (error) {
      this.logger.error(`Select failed: ${error.message}`, error.stack);
      return { success: false, transactionId: transactionId || '', error: error.message };
    }
  }

  /**
   * Handle /on_select callback from BPP with the quoted order.
   */
  async onSelect(
    context: BecknContext,
    message: { order: BecknOrder },
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `Received on_select from BPP ${context.bpp_id} for txn ${context.transaction_id}`,
      );

      // Store the quote response
      await this.searchService.logTransaction(
        'on_select',
        context,
        { context, message },
        'completed',
      );

      // Log quote details for debugging
      if (message.order?.quote) {
        this.logger.log(
          `Quote: ${message.order.quote.price.currency} ${message.order.quote.price.value} ` +
          `(${message.order.quote.breakup?.length || 0} breakup items)`,
        );
      }

      return this.buildAck(context, 'on_select');
    } catch (error) {
      this.logger.error(`Failed to handle on_select: ${error.message}`, error.stack);
      return this.buildNack(context, 'on_select', error.message);
    }
  }

  // ============================================
  // INIT — Initialize Order
  // ============================================

  /**
   * Send /init to BPP to initialize the order with billing and fulfillment details.
   */
  async init(
    order: BecknOrder,
    bppId: string,
    bppUri: string,
    transactionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const messageId = this.generateUuid();
      const context = this.buildContext('init', transactionId, messageId, bppId, bppUri);

      const request: OndcOrderRequest = {
        context,
        message: { order },
      };

      await this.searchService.logTransaction('init', context, request, 'initiated');
      await this.sendToBpp(bppUri, 'init', context, { order });

      this.logger.log(`Init sent to BPP ${bppId} for txn ${transactionId}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`Init failed: ${error.message}`, error.stack);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle /on_init callback from BPP with initialized order (payment details, etc.).
   */
  async onInit(
    context: BecknContext,
    message: { order: BecknOrder },
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `Received on_init from BPP ${context.bpp_id} for txn ${context.transaction_id}`,
      );

      await this.searchService.logTransaction(
        'on_init',
        context,
        { context, message },
        'completed',
      );

      // Log payment info if available
      if (message.order?.payment) {
        this.logger.log(
          `Payment: type=${message.order.payment.type}, ` +
          `collected_by=${message.order.payment.collected_by}`,
        );
      }

      return this.buildAck(context, 'on_init');
    } catch (error) {
      this.logger.error(`Failed to handle on_init: ${error.message}`, error.stack);
      return this.buildNack(context, 'on_init', error.message);
    }
  }

  // ============================================
  // CONFIRM — Place Order
  // ============================================

  /**
   * Send /confirm to BPP to place the order.
   */
  async confirm(
    order: BecknOrder,
    bppId: string,
    bppUri: string,
    transactionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const messageId = this.generateUuid();
      const context = this.buildContext('confirm', transactionId, messageId, bppId, bppUri);

      const request: OndcOrderRequest = {
        context,
        message: { order },
      };

      await this.searchService.logTransaction('confirm', context, request, 'initiated');
      await this.sendToBpp(bppUri, 'confirm', context, { order });

      this.logger.log(`Confirm sent to BPP ${bppId} for txn ${transactionId}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`Confirm failed: ${error.message}`, error.stack);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle /on_confirm callback from BPP with order confirmation.
   */
  async onConfirm(
    context: BecknContext,
    message: { order: BecknOrder },
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `Received on_confirm from BPP ${context.bpp_id} for txn ${context.transaction_id}`,
      );

      await this.searchService.logTransaction(
        'on_confirm',
        context,
        { context, message },
        'completed',
      );

      if (message.order?.id) {
        this.logger.log(`Order confirmed: ONDC order ID = ${message.order.id}`);
      }

      return this.buildAck(context, 'on_confirm');
    } catch (error) {
      this.logger.error(`Failed to handle on_confirm: ${error.message}`, error.stack);
      return this.buildNack(context, 'on_confirm', error.message);
    }
  }

  // ============================================
  // STATUS — Check Order Status
  // ============================================

  /**
   * Send /status to BPP to check the current status of an order.
   */
  async status(
    orderId: string,
    bppId: string,
    bppUri: string,
    transactionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const messageId = this.generateUuid();
      const context = this.buildContext('status', transactionId, messageId, bppId, bppUri);

      const order: BecknOrder = { id: orderId };

      await this.searchService.logTransaction('status', context, { context, message: { order } }, 'initiated');
      await this.sendToBpp(bppUri, 'status', context, { order });

      this.logger.log(`Status request sent for order ${orderId} to BPP ${bppId}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`Status request failed: ${error.message}`, error.stack);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle /on_status callback from BPP with order status update.
   */
  async onStatus(
    context: BecknContext,
    message: { order: BecknOrder },
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `Received on_status from BPP ${context.bpp_id} for txn ${context.transaction_id}`,
      );

      await this.searchService.logTransaction(
        'on_status',
        context,
        { context, message },
        'completed',
      );

      if (message.order) {
        this.logger.log(
          `Order ${message.order.id} status: ${message.order.state}, ` +
          `fulfillment: ${message.order.fulfillment?.state?.descriptor?.code || 'unknown'}`,
        );
      }

      return this.buildAck(context, 'on_status');
    } catch (error) {
      this.logger.error(`Failed to handle on_status: ${error.message}`, error.stack);
      return this.buildNack(context, 'on_status', error.message);
    }
  }

  // ============================================
  // CANCEL — Cancel Order
  // ============================================

  /**
   * Send /cancel to BPP to cancel an order.
   */
  async cancel(
    orderId: string,
    reason: string,
    bppId: string,
    bppUri: string,
    transactionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const messageId = this.generateUuid();
      const context = this.buildContext('cancel', transactionId, messageId, bppId, bppUri);

      const cancelPayload = {
        order: {
          id: orderId,
        },
        cancellation_reason_id: reason,
      };

      await this.searchService.logTransaction('cancel', context, { context, message: cancelPayload }, 'initiated');
      await this.sendToBpp(bppUri, 'cancel', context, cancelPayload);

      this.logger.log(`Cancel request sent for order ${orderId} to BPP ${bppId}: ${reason}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`Cancel request failed: ${error.message}`, error.stack);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle /on_cancel callback from BPP with cancellation confirmation.
   */
  async onCancel(
    context: BecknContext,
    message: { order: BecknOrder },
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `Received on_cancel from BPP ${context.bpp_id} for txn ${context.transaction_id}`,
      );

      await this.searchService.logTransaction(
        'on_cancel',
        context,
        { context, message },
        'completed',
      );

      if (message.order?.id) {
        this.logger.log(`Order ${message.order.id} cancelled, state: ${message.order.state}`);
      }

      return this.buildAck(context, 'on_cancel');
    } catch (error) {
      this.logger.error(`Failed to handle on_cancel: ${error.message}`, error.stack);
      return this.buildNack(context, 'on_cancel', error.message);
    }
  }

  // ============================================
  // TRANSACTION RETRIEVAL
  // ============================================

  /**
   * Get the full transaction history for an ONDC order lifecycle.
   */
  async getTransactionHistory(transactionId: string): Promise<any[]> {
    try {
      const transactions = await this.prisma.$queryRaw<any[]>`
        SELECT id, transaction_id, message_id, action, bap_id, bpp_id,
               status, created_at, updated_at
        FROM ondc_transactions
        WHERE transaction_id = ${transactionId}
        ORDER BY created_at ASC
      `;

      return transactions || [];
    } catch (error) {
      this.logger.error(`Failed to get transaction history: ${error.message}`, error.stack);
      return [];
    }
  }

  /**
   * Get the latest response for a specific action in a transaction.
   */
  async getLatestResponse(
    transactionId: string,
    action: string,
  ): Promise<any | null> {
    try {
      const result = await this.prisma.$queryRaw<any[]>`
        SELECT * FROM ondc_transactions
        WHERE transaction_id = ${transactionId}
          AND action = ${action}
        ORDER BY created_at DESC
        LIMIT 1
      `;

      return result?.[0] || null;
    } catch (error) {
      this.logger.error(`Failed to get latest response: ${error.message}`, error.stack);
      return null;
    }
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  /**
   * Build a BecknContext for outgoing requests.
   */
  private buildContext(
    action: BecknAction,
    transactionId: string,
    messageId: string,
    bppId?: string,
    bppUri?: string,
  ): BecknContext {
    return {
      domain: this.domain,
      country: this.country,
      city: this.city,
      action,
      core_version: this.coreVersion,
      bap_id: this.bapId,
      bap_uri: this.bapUri,
      bpp_id: bppId,
      bpp_uri: bppUri,
      transaction_id: transactionId,
      message_id: messageId,
      timestamp: new Date().toISOString(),
      ttl: 'PT30S',
    };
  }

  /**
   * Sign and POST a request to a BPP endpoint.
   */
  private async sendToBpp(
    bppUri: string,
    action: BecknAction,
    context: BecknContext,
    message: any,
  ): Promise<any> {
    const payload = { context, message };
    const body = JSON.stringify(payload);
    const authHeader = this.signatureService.signRequest(body);

    const url = `${bppUri}/${action}`;

    try {
      const response = await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
          },
          timeout: 10000,
        }),
      );

      const ackResponse = response.data as OndcAckResponse;

      if (ackResponse?.message?.ack?.status !== 'ACK') {
        this.logger.warn(
          `NACK from BPP ${context.bpp_id} for /${action}: ${JSON.stringify(ackResponse?.error)}`,
        );
      }

      return ackResponse;
    } catch (error) {
      this.logger.error(
        `Failed to send /${action} to BPP ${bppUri}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Build an ACK response.
   */
  private buildAck(context: BecknContext, action: BecknAction): OndcAckResponse {
    return {
      context: {
        ...context,
        action,
        bap_id: this.bapId,
        bap_uri: this.bapUri,
        timestamp: new Date().toISOString(),
      },
      message: {
        ack: { status: 'ACK' },
      },
    };
  }

  /**
   * Build a NACK response.
   */
  private buildNack(
    context: BecknContext,
    action: BecknAction,
    errorMessage: string,
  ): OndcAckResponse {
    return {
      context: {
        ...context,
        action,
        bap_id: this.bapId,
        bap_uri: this.bapUri,
        timestamp: new Date().toISOString(),
      },
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

  private generateUuid(): string {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}
