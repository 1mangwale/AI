import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OndcCatalogService } from '../services/ondc-catalog.service';

/**
 * ONDC Catalog Sync Processor
 *
 * BullMQ processor for asynchronous catalog operations:
 * - sync-catalog: Full catalog sync to ONDC network (scheduled daily / on-demand)
 * - build-catalog: Build catalog for a specific store (on-demand)
 *
 * Queue: 'ondc-catalog-sync'
 *
 * Job scheduling should be configured in the module or a scheduler service:
 *   queue.add('sync-catalog', {}, { repeat: { pattern: '0 3 * * *' } }) // 3 AM daily
 */
@Processor('ondc-catalog-sync')
export class OndcCatalogSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(OndcCatalogSyncProcessor.name);

  constructor(private readonly catalogService: OndcCatalogService) {
    super();
  }

  async process(job: Job): Promise<any> {
    this.logger.log(`Processing ONDC catalog job: ${job.name} (id: ${job.id})`);

    try {
      switch (job.name) {
        case 'sync-catalog':
          return await this.handleSyncCatalog(job);

        case 'build-catalog':
          return await this.handleBuildCatalog(job);

        default:
          this.logger.warn(`Unknown job type: ${job.name}`);
          return { success: false, error: `Unknown job type: ${job.name}` };
      }
    } catch (error) {
      this.logger.error(
        `ONDC catalog job ${job.name} failed: ${error.message}`,
        error.stack,
      );
      throw error; // Let BullMQ handle retries
    }
  }

  /**
   * Full catalog sync to ONDC network.
   * Fetches all items from Search API, builds Beckn catalog, and pushes to network.
   */
  private async handleSyncCatalog(job: Job): Promise<any> {
    this.logger.log('Starting full ONDC catalog sync');

    const startTime = Date.now();
    const result = await this.catalogService.syncToNetwork();
    const durationMs = Date.now() - startTime;

    this.logger.log(
      `Catalog sync completed in ${durationMs}ms: ` +
      `${result.providers} providers, ${result.items} items, ` +
      `success=${result.success}`,
    );

    return {
      success: result.success,
      providers: result.providers,
      items: result.items,
      durationMs,
    };
  }

  /**
   * Build catalog for a specific store.
   * Used when a store updates their menu and needs to push changes.
   */
  private async handleBuildCatalog(job: Job): Promise<any> {
    const { storeId } = job.data || {};

    this.logger.log(
      `Building ONDC catalog${storeId ? ` for store #${storeId}` : ' for all stores'}`,
    );

    const startTime = Date.now();
    const catalog = await this.catalogService.buildCatalog(storeId);
    const durationMs = Date.now() - startTime;

    const providerCount = catalog['bpp/providers']?.length || 0;
    let itemCount = 0;
    for (const provider of catalog['bpp/providers'] || []) {
      itemCount += provider.items?.length || 0;
    }

    this.logger.log(
      `Catalog built in ${durationMs}ms: ${providerCount} providers, ${itemCount} items`,
    );

    return {
      success: true,
      providers: providerCount,
      items: itemCount,
      durationMs,
    };
  }
}
