import {
  Controller,
  Post,
  Body,
  Headers,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { OndcSearchService } from '../services/ondc-search.service';
import { OndcOrderService } from '../services/ondc-order.service';
import { OndcSignatureService } from '../services/ondc-signature.service';
import {
  BecknContext,
  OndcAckResponse,
} from '../interfaces/ondc.interfaces';

/**
 * ONDC Buyer Controller (BAP - Buyer Application Platform)
 *
 * Receives callbacks from BPPs (sellers) via the ONDC network.
 * These are the "on_*" callbacks that BPPs send in response to
 * our outgoing requests (search, select, init, confirm, status, cancel).
 *
 * Each endpoint:
 * 1. Validates the signature from the incoming request
 * 2. Logs the transaction
 * 3. Delegates to the appropriate service method
 * 4. Returns ACK/NACK per Beckn protocol
 *
 * Routes: POST /ondc/buyer/on_*
 */
@Controller('ondc/buyer')
export class OndcBuyerController {
  private readonly logger = new Logger(OndcBuyerController.name);

  constructor(
    private readonly searchService: OndcSearchService,
    private readonly orderService: OndcOrderService,
    private readonly signatureService: OndcSignatureService,
  ) {}

  // ============================================
  // SEARCH CALLBACK
  // ============================================

  /**
   * POST /ondc/buyer/on_search
   *
   * Receives catalog responses from BPPs matching our search request.
   * Multiple BPPs may call this endpoint for a single search transaction.
   */
  @Post('on_search')
  @HttpCode(HttpStatus.OK)
  async onSearch(
    @Body() body: { context: BecknContext; message: { catalog: any } },
    @Headers('authorization') authHeader: string,
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `on_search received from BPP ${body.context?.bpp_id} ` +
        `txn=${body.context?.transaction_id}`,
      );

      // Validate signature
      if (!this.validateSignature(authHeader, body)) {
        return this.buildNack(body.context, 'on_search', 'Invalid signature');
      }

      return await this.searchService.onSearch(body.context, body.message);
    } catch (error) {
      this.logger.error(`on_search handler error: ${error.message}`, error.stack);
      return this.buildNack(body.context, 'on_search', error.message);
    }
  }

  // ============================================
  // ORDER LIFECYCLE CALLBACKS
  // ============================================

  /**
   * POST /ondc/buyer/on_select
   *
   * Receives the quoted order from BPP in response to /select.
   * Contains price breakup and fulfillment options.
   */
  @Post('on_select')
  @HttpCode(HttpStatus.OK)
  async onSelect(
    @Body() body: { context: BecknContext; message: { order: any } },
    @Headers('authorization') authHeader: string,
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `on_select received from BPP ${body.context?.bpp_id} ` +
        `txn=${body.context?.transaction_id}`,
      );

      if (!this.validateSignature(authHeader, body)) {
        return this.buildNack(body.context, 'on_select', 'Invalid signature');
      }

      return await this.orderService.onSelect(body.context, body.message);
    } catch (error) {
      this.logger.error(`on_select handler error: ${error.message}`, error.stack);
      return this.buildNack(body.context, 'on_select', error.message);
    }
  }

  /**
   * POST /ondc/buyer/on_init
   *
   * Receives the initialized order from BPP with payment details.
   */
  @Post('on_init')
  @HttpCode(HttpStatus.OK)
  async onInit(
    @Body() body: { context: BecknContext; message: { order: any } },
    @Headers('authorization') authHeader: string,
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `on_init received from BPP ${body.context?.bpp_id} ` +
        `txn=${body.context?.transaction_id}`,
      );

      if (!this.validateSignature(authHeader, body)) {
        return this.buildNack(body.context, 'on_init', 'Invalid signature');
      }

      return await this.orderService.onInit(body.context, body.message);
    } catch (error) {
      this.logger.error(`on_init handler error: ${error.message}`, error.stack);
      return this.buildNack(body.context, 'on_init', error.message);
    }
  }

  /**
   * POST /ondc/buyer/on_confirm
   *
   * Receives order confirmation from BPP.
   */
  @Post('on_confirm')
  @HttpCode(HttpStatus.OK)
  async onConfirm(
    @Body() body: { context: BecknContext; message: { order: any } },
    @Headers('authorization') authHeader: string,
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `on_confirm received from BPP ${body.context?.bpp_id} ` +
        `txn=${body.context?.transaction_id}`,
      );

      if (!this.validateSignature(authHeader, body)) {
        return this.buildNack(body.context, 'on_confirm', 'Invalid signature');
      }

      return await this.orderService.onConfirm(body.context, body.message);
    } catch (error) {
      this.logger.error(`on_confirm handler error: ${error.message}`, error.stack);
      return this.buildNack(body.context, 'on_confirm', error.message);
    }
  }

  /**
   * POST /ondc/buyer/on_status
   *
   * Receives order status update from BPP.
   */
  @Post('on_status')
  @HttpCode(HttpStatus.OK)
  async onStatus(
    @Body() body: { context: BecknContext; message: { order: any } },
    @Headers('authorization') authHeader: string,
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `on_status received from BPP ${body.context?.bpp_id} ` +
        `txn=${body.context?.transaction_id}`,
      );

      if (!this.validateSignature(authHeader, body)) {
        return this.buildNack(body.context, 'on_status', 'Invalid signature');
      }

      return await this.orderService.onStatus(body.context, body.message);
    } catch (error) {
      this.logger.error(`on_status handler error: ${error.message}`, error.stack);
      return this.buildNack(body.context, 'on_status', error.message);
    }
  }

  /**
   * POST /ondc/buyer/on_cancel
   *
   * Receives cancellation confirmation from BPP.
   */
  @Post('on_cancel')
  @HttpCode(HttpStatus.OK)
  async onCancel(
    @Body() body: { context: BecknContext; message: { order: any } },
    @Headers('authorization') authHeader: string,
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `on_cancel received from BPP ${body.context?.bpp_id} ` +
        `txn=${body.context?.transaction_id}`,
      );

      if (!this.validateSignature(authHeader, body)) {
        return this.buildNack(body.context, 'on_cancel', 'Invalid signature');
      }

      return await this.orderService.onCancel(body.context, body.message);
    } catch (error) {
      this.logger.error(`on_cancel handler error: ${error.message}`, error.stack);
      return this.buildNack(body.context, 'on_cancel', error.message);
    }
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  /**
   * Validate the signature from an incoming BPP request.
   * In production, this would look up the BPP's public key from the registry.
   * For now, logs a warning if no auth header and continues (sandbox mode).
   */
  private validateSignature(authHeader: string, body: any): boolean {
    if (!authHeader) {
      this.logger.warn('No authorization header in incoming request - proceeding in sandbox mode');
      return true; // Allow unsigned requests in sandbox
    }

    try {
      const isValid = this.signatureService.verifySignature(
        authHeader,
        JSON.stringify(body),
      );

      if (!isValid) {
        this.logger.warn(`Signature verification failed for BPP ${body?.context?.bpp_id}`);
      }

      return isValid;
    } catch (error) {
      this.logger.warn(`Signature validation error: ${error.message} - proceeding anyway`);
      return true; // Lenient in sandbox mode
    }
  }

  /**
   * Build a NACK response for error cases.
   */
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
