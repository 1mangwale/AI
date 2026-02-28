import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../database/prisma.service';
import { OndcSignatureService } from './ondc-signature.service';
import {
  BecknContext,
  BecknAction,
  BecknIntent,
  BecknCatalog,
  OndcSearchRequest,
  OndcSearchResponse,
  OndcAckResponse,
  OndcTransaction,
} from '../interfaces/ondc.interfaces';

/**
 * ONDC Search Service
 *
 * Handles the /search protocol action on the BAP (Buyer App) side.
 * When a customer searches for items, we broadcast the search to the
 * ONDC network gateway. BPPs (sellers) respond asynchronously via
 * /on_search callback with their catalog results.
 *
 * Flow:
 * 1. Customer searches -> search() -> POST to ONDC gateway /search
 * 2. BPPs respond -> /on_search callback -> onSearch() stores results
 * 3. Frontend polls for aggregated results by transaction_id
 */
@Injectable()
export class OndcSearchService implements OnModuleInit {
  private readonly logger = new Logger(OndcSearchService.name);

  private readonly gatewayUrl: string;
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
    private readonly configService: ConfigService,
  ) {
    this.gatewayUrl = this.configService.get<string>('ONDC_GATEWAY_URL') || 'https://gateway.ondc.org';
    this.bapId = this.configService.get<string>('ONDC_SUBSCRIBER_ID') || '';
    this.bapUri = this.configService.get<string>('ONDC_SUBSCRIBER_URL') || '';
    this.domain = this.configService.get<string>('ONDC_DOMAIN') || 'nic2004:52110';
    this.city = this.configService.get<string>('ONDC_CITY') || 'std:020';
    this.country = this.configService.get<string>('ONDC_COUNTRY') || 'IND';
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS ondc_transactions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          transaction_id VARCHAR(255) NOT NULL,
          message_id VARCHAR(255) NOT NULL,
          action VARCHAR(50) NOT NULL,
          bap_id VARCHAR(255),
          bpp_id VARCHAR(255),
          request_payload JSONB,
          response_payload JSONB,
          status VARCHAR(30) DEFAULT 'initiated',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `;

      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_ondc_tx_id
          ON ondc_transactions(transaction_id)
      `;

      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_ondc_action
          ON ondc_transactions(action)
      `;

      this.logger.log('ONDC transactions table initialized');
    } catch (error) {
      this.logger.error(`Failed to initialize ondc_transactions table: ${error.message}`, error.stack);
    }
  }

  // ============================================
  // SEARCH (BAP -> Gateway)
  // ============================================

  /**
   * Broadcast a search request to the ONDC network.
   * Creates a transaction, builds a Beckn search request, signs it,
   * and POSTs to the gateway.
   */
  async search(intent: BecknIntent): Promise<{
    success: boolean;
    transactionId?: string;
    messageId?: string;
    error?: string;
  }> {
    try {
      const transactionId = this.generateUuid();
      const messageId = this.generateUuid();

      const context = this.buildContext('search', transactionId, messageId);

      const searchRequest: OndcSearchRequest = {
        context,
        message: {
          intent,
        },
      };

      // Log the outgoing transaction
      await this.logTransaction('search', context, searchRequest, 'initiated');

      // Sign and send
      const body = JSON.stringify(searchRequest);
      const authHeader = this.signatureService.signRequest(body);

      const response = await firstValueFrom(
        this.httpService.post(`${this.gatewayUrl}/search`, searchRequest, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
          },
          timeout: 10000,
        }),
      );

      const ackResponse = response.data as OndcAckResponse;
      const isAcked = ackResponse?.message?.ack?.status === 'ACK';

      if (isAcked) {
        this.logger.log(`Search broadcast to ONDC network: txn=${transactionId}`);
        await this.updateTransactionStatus(transactionId, 'search', 'in_progress');
      } else {
        this.logger.warn(`Search NACK from gateway: ${JSON.stringify(ackResponse?.error)}`);
        await this.updateTransactionStatus(transactionId, 'search', 'error');
      }

      return {
        success: isAcked,
        transactionId,
        messageId,
        error: isAcked ? undefined : ackResponse?.error?.message,
      };
    } catch (error) {
      this.logger.error(`ONDC search failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // ============================================
  // ON_SEARCH CALLBACK (BPPs -> BAP)
  // ============================================

  /**
   * Handle /on_search callback from BPPs via the gateway.
   * BPPs send their catalog results matching our search intent.
   * We store each BPP's catalog and aggregate them for the frontend.
   */
  async onSearch(
    context: BecknContext,
    message: { catalog: BecknCatalog },
  ): Promise<OndcAckResponse> {
    try {
      this.logger.log(
        `Received on_search from BPP ${context.bpp_id} for txn ${context.transaction_id}`,
      );

      // Log the incoming response
      await this.logTransaction(
        'on_search',
        context,
        { context, message },
        'completed',
      );

      // Store the catalog response for this BPP
      await this.storeCatalogResponse(
        context.transaction_id,
        context.bpp_id || 'unknown',
        message.catalog,
      );

      // Return ACK
      return {
        context: {
          ...context,
          action: 'on_search',
          bap_id: this.bapId,
          bap_uri: this.bapUri,
          timestamp: new Date().toISOString(),
        },
        message: {
          ack: { status: 'ACK' },
        },
      };
    } catch (error) {
      this.logger.error(`Failed to handle on_search: ${error.message}`, error.stack);

      return {
        context: {
          ...context,
          action: 'on_search',
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
          message: 'Internal processing error',
        },
      };
    }
  }

  // ============================================
  // SEARCH RESULTS RETRIEVAL
  // ============================================

  /**
   * Get aggregated search results for a transaction.
   * Returns all catalog responses received from BPPs.
   */
  async getSearchResults(transactionId: string): Promise<{
    transactionId: string;
    status: string;
    results: any[];
  }> {
    try {
      const transactions = await this.prisma.$queryRaw<OndcTransaction[]>`
        SELECT * FROM ondc_transactions
        WHERE transaction_id = ${transactionId}
          AND action = 'on_search'
        ORDER BY created_at DESC
      `;

      const results = transactions.map((tx) => ({
        bppId: tx.bpp_id,
        catalog: tx.response_payload?.message?.catalog || tx.response_payload,
        receivedAt: tx.created_at,
      }));

      // Check the search transaction status
      const searchTx = await this.prisma.$queryRaw<OndcTransaction[]>`
        SELECT * FROM ondc_transactions
        WHERE transaction_id = ${transactionId}
          AND action = 'search'
        ORDER BY created_at DESC
        LIMIT 1
      `;

      const status = searchTx?.[0]?.status || 'unknown';

      return {
        transactionId,
        status,
        results,
      };
    } catch (error) {
      this.logger.error(`Failed to get search results for ${transactionId}: ${error.message}`, error.stack);
      return {
        transactionId,
        status: 'error',
        results: [],
      };
    }
  }

  // ============================================
  // TRANSACTION LOGGING
  // ============================================

  /**
   * Log an ONDC transaction (request or response) to the database.
   */
  async logTransaction(
    action: BecknAction | string,
    context: BecknContext,
    payload: any,
    status: string = 'initiated',
  ): Promise<void> {
    try {
      const payloadJson = JSON.stringify(payload);
      const isResponse = action.startsWith('on_');

      await this.prisma.$executeRaw`
        INSERT INTO ondc_transactions (
          transaction_id, message_id, action, bap_id, bpp_id,
          request_payload, response_payload, status
        ) VALUES (
          ${context.transaction_id},
          ${context.message_id},
          ${action},
          ${context.bap_id || null},
          ${context.bpp_id || null},
          ${isResponse ? null : payloadJson}::jsonb,
          ${isResponse ? payloadJson : null}::jsonb,
          ${status}
        )
      `;
    } catch (error) {
      this.logger.error(`Failed to log ONDC transaction: ${error.message}`, error.stack);
    }
  }

  /**
   * Update the status of an existing transaction.
   */
  async updateTransactionStatus(
    transactionId: string,
    action: string,
    status: string,
  ): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE ondc_transactions
        SET status = ${status}, updated_at = NOW()
        WHERE transaction_id = ${transactionId}
          AND action = ${action}
      `;
    } catch (error) {
      this.logger.error(`Failed to update transaction status: ${error.message}`, error.stack);
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
   * Store a BPP's catalog response for later aggregation.
   */
  private async storeCatalogResponse(
    transactionId: string,
    bppId: string,
    catalog: BecknCatalog,
  ): Promise<void> {
    try {
      const catalogJson = JSON.stringify(catalog);

      await this.prisma.$executeRaw`
        INSERT INTO ondc_transactions (
          transaction_id, message_id, action, bpp_id,
          response_payload, status
        ) VALUES (
          ${transactionId},
          ${this.generateUuid()},
          'on_search',
          ${bppId},
          ${catalogJson}::jsonb,
          'completed'
        )
      `;
    } catch (error) {
      this.logger.error(`Failed to store catalog response: ${error.message}`, error.stack);
    }
  }

  private generateUuid(): string {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}
