import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { OndcSignatureService } from './ondc-signature.service';

/**
 * ONDC Registry Service
 *
 * Manages network participant registration with the ONDC registry.
 * Handles subscriber lifecycle:
 * 1. Register as BAP/BPP with the ONDC registry
 * 2. Handle /on_subscribe callback with signed challenge
 * 3. Look up other network participants
 * 4. Check registration status
 *
 * Configuration:
 * - ONDC_SUBSCRIBER_ID: Our unique subscriber ID
 * - ONDC_SUBSCRIBER_URL: Our callback URL (must be publicly accessible)
 * - ONDC_REGISTRY_URL: ONDC registry endpoint
 * - ONDC_SUBSCRIBER_TYPE: 'BAP' or 'BPP' (we operate as both)
 * - ONDC_DOMAIN: e.g., 'nic2004:52110' for food delivery
 * - ONDC_CITY: e.g., 'std:020' for Nashik
 */
@Injectable()
export class OndcRegistryService {
  private readonly logger = new Logger(OndcRegistryService.name);

  private readonly subscriberId: string;
  private readonly subscriberUrl: string;
  private readonly registryUrl: string;
  private readonly subscriberType: string;
  private readonly domain: string;
  private readonly city: string;
  private readonly country: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly signatureService: OndcSignatureService,
  ) {
    this.subscriberId = this.configService.get<string>('ONDC_SUBSCRIBER_ID') || '';
    this.subscriberUrl = this.configService.get<string>('ONDC_SUBSCRIBER_URL') || '';
    this.registryUrl = this.configService.get<string>('ONDC_REGISTRY_URL') || 'https://registry.ondc.org';
    this.subscriberType = this.configService.get<string>('ONDC_SUBSCRIBER_TYPE') || 'BAP';
    this.domain = this.configService.get<string>('ONDC_DOMAIN') || 'nic2004:52110';
    this.city = this.configService.get<string>('ONDC_CITY') || 'std:020';
    this.country = this.configService.get<string>('ONDC_COUNTRY') || 'IND';

    if (!this.subscriberId) {
      this.logger.warn('ONDC_SUBSCRIBER_ID not configured - registry operations will fail');
    }
  }

  // ============================================
  // REGISTRATION
  // ============================================

  /**
   * Register as a network participant with the ONDC registry.
   * POST /subscribe to the registry with subscriber details.
   */
  async register(): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      if (!this.subscriberId || !this.subscriberUrl) {
        return {
          success: false,
          message: 'ONDC_SUBSCRIBER_ID and ONDC_SUBSCRIBER_URL must be configured',
        };
      }

      const keyStatus = this.signatureService.getKeyPairStatus();
      if (!keyStatus.hasPrivateKey || !keyStatus.hasPublicKey) {
        return {
          success: false,
          message: 'ONDC Ed25519 key pair must be configured before registration',
        };
      }

      const subscribePayload = {
        context: {
          operation: {
            ops_no: 1,
          },
        },
        message: {
          request_id: this.generateUuid(),
          timestamp: new Date().toISOString(),
          entity: {
            gst: {
              legal_entity_name: this.configService.get<string>('ONDC_LEGAL_ENTITY_NAME') || 'Mangwale',
              business_address: this.configService.get<string>('ONDC_BUSINESS_ADDRESS') || '',
            },
            name: {
              name_eng: this.configService.get<string>('ONDC_ENTITY_NAME') || 'Mangwale',
              name_tag: this.configService.get<string>('ONDC_ENTITY_NAME') || 'Mangwale',
            },
            address: {
              full: this.configService.get<string>('ONDC_BUSINESS_ADDRESS') || '',
              city: this.city,
              country: this.country,
            },
          },
          network_participant: [
            {
              subscriber_url: this.subscriberUrl,
              domain: this.domain,
              type: this.subscriberType,
              msn: false,
              city_code: [this.city],
            },
          ],
        },
      };

      const body = JSON.stringify(subscribePayload);
      const authHeader = this.signatureService.signRequest(body);

      const response = await firstValueFrom(
        this.httpService.post(`${this.registryUrl}/subscribe`, subscribePayload, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
          },
          timeout: 15000,
        }),
      );

      this.logger.log(`ONDC registry subscribe response: ${JSON.stringify(response.data)}`);

      return {
        success: true,
        message: 'Registration request submitted to ONDC registry',
        data: response.data,
      };
    } catch (error) {
      this.logger.error(`ONDC registration failed: ${error.message}`, error.stack);
      return {
        success: false,
        message: `Registration failed: ${error.message}`,
      };
    }
  }

  /**
   * Look up a network participant by subscriber ID.
   * POST /lookup to the registry.
   */
  async lookup(
    subscriberId: string,
    domain?: string,
    type?: string,
  ): Promise<any[]> {
    try {
      const lookupPayload: any = {
        subscriber_id: subscriberId,
      };

      if (domain) lookupPayload.domain = domain;
      if (type) lookupPayload.type = type;
      lookupPayload.country = this.country;
      lookupPayload.city = this.city;

      const body = JSON.stringify(lookupPayload);
      const authHeader = this.signatureService.signRequest(body);

      const response = await firstValueFrom(
        this.httpService.post(`${this.registryUrl}/lookup`, lookupPayload, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
          },
          timeout: 10000,
        }),
      );

      const participants = response.data || [];
      this.logger.log(`ONDC lookup for ${subscriberId}: found ${participants.length} participants`);

      return participants;
    } catch (error) {
      this.logger.error(`ONDC lookup failed for ${subscriberId}: ${error.message}`, error.stack);
      return [];
    }
  }

  /**
   * Check our current registration status with the registry.
   */
  async getRegistrationStatus(): Promise<{
    isRegistered: boolean;
    subscriberId: string;
    subscriberUrl: string;
    subscriberType: string;
    domain: string;
    keyPairStatus: { hasPrivateKey: boolean; hasPublicKey: boolean };
    registryUrl: string;
  }> {
    const keyPairStatus = this.signatureService.getKeyPairStatus();

    let isRegistered = false;

    if (this.subscriberId) {
      try {
        const results = await this.lookup(this.subscriberId);
        isRegistered = results.length > 0;
      } catch (error) {
        this.logger.warn(`Could not verify registration status: ${error.message}`);
      }
    }

    return {
      isRegistered,
      subscriberId: this.subscriberId,
      subscriberUrl: this.subscriberUrl,
      subscriberType: this.subscriberType,
      domain: this.domain,
      keyPairStatus,
      registryUrl: this.registryUrl,
    };
  }

  /**
   * Handle the /on_subscribe callback from the ONDC registry.
   * The registry sends a challenge that we must sign and return.
   */
  async onSubscribe(challenge: string): Promise<{ answer: string }> {
    try {
      this.logger.log('Received ONDC /on_subscribe challenge');

      // Sign the challenge string with our private key
      const signedChallenge = this.signatureService.signRequest(challenge);

      this.logger.log('ONDC /on_subscribe challenge signed successfully');

      return {
        answer: signedChallenge,
      };
    } catch (error) {
      this.logger.error(`Failed to respond to /on_subscribe challenge: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Lookup a BPP by its subscriber ID to get its endpoint URI.
   * Used when we need to send requests to a specific BPP.
   */
  async getBppEndpoint(bppId: string): Promise<string | null> {
    try {
      const participants = await this.lookup(bppId, undefined, 'BPP');

      if (participants.length === 0) {
        this.logger.warn(`BPP ${bppId} not found in registry`);
        return null;
      }

      // Return the subscriber_url of the first matching BPP
      const bpp = participants[0];
      return bpp.subscriber_url || null;
    } catch (error) {
      this.logger.error(`Failed to get BPP endpoint for ${bppId}: ${error.message}`, error.stack);
      return null;
    }
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  private generateUuid(): string {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}
