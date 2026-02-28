import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { DatabaseModule } from '../database/database.module';

// Services
import { OndcSignatureService } from './services/ondc-signature.service';
import { OndcRegistryService } from './services/ondc-registry.service';
import { OndcSearchService } from './services/ondc-search.service';
import { OndcOrderService } from './services/ondc-order.service';
import { OndcCatalogService } from './services/ondc-catalog.service';

// Controllers
import { OndcBuyerController } from './controllers/ondc-buyer.controller';
import { OndcSellerController } from './controllers/ondc-seller.controller';

// Processors
import { OndcCatalogSyncProcessor } from './processors/ondc-catalog-sync.processor';

/**
 * ONDC Module
 *
 * Open Network for Digital Commerce integration using Beckn protocol v1.1.0.
 *
 * Operates as both:
 * - BAP (Buyer Application Platform): Sends searches, places orders on the network
 * - BPP (Buyer Platform Provider): Exposes our catalog, receives orders from the network
 *
 * Configuration (env vars):
 * - ONDC_SUBSCRIBER_ID, ONDC_SUBSCRIBER_URL, ONDC_REGISTRY_URL
 * - ONDC_PRIVATE_KEY, ONDC_PUBLIC_KEY (Ed25519, base64 DER)
 * - ONDC_DOMAIN, ONDC_CITY, ONDC_COUNTRY
 * - ONDC_GATEWAY_URL
 */
@Module({
  imports: [
    DatabaseModule,
    HttpModule.register({
      timeout: 15000,
      maxRedirects: 5,
    }),
    BullModule.registerQueue({
      name: 'ondc-catalog-sync',
    }),
  ],
  controllers: [OndcBuyerController, OndcSellerController],
  providers: [
    OndcSignatureService,
    OndcRegistryService,
    OndcSearchService,
    OndcOrderService,
    OndcCatalogService,
    OndcCatalogSyncProcessor,
  ],
  exports: [
    OndcRegistryService,
    OndcSearchService,
    OndcOrderService,
    OndcCatalogService,
  ],
})
export class OndcModule {}
