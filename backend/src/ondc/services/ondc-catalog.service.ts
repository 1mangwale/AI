import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../database/prisma.service';
import {
  BecknCatalog,
  BecknProvider,
  BecknProviderLocation,
  BecknIntent,
  CatalogItem,
} from '../interfaces/ondc.interfaces';

/**
 * ONDC Catalog Service
 *
 * Manages catalog operations for the BPP (Seller Platform) side.
 * Responsible for:
 * - Building Beckn-compliant catalog from our Search API items
 * - Syncing catalog updates to the ONDC network
 * - Handling search requests from BAPs matching our inventory
 * - Formatting internal items to ONDC CatalogItem format
 *
 * Our catalog is sourced from the Search API (OpenSearch) which indexes
 * items from the PHP backend's MySQL database.
 */
@Injectable()
export class OndcCatalogService {
  private readonly logger = new Logger(OndcCatalogService.name);

  private readonly searchApiUrl: string;
  private readonly subscriberId: string;
  private readonly subscriberUrl: string;
  private readonly storeDomain: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.searchApiUrl = this.configService.get<string>('SEARCH_API_URL');
    this.subscriberId = this.configService.get<string>('ONDC_SUBSCRIBER_ID') || '';
    this.subscriberUrl = this.configService.get<string>('ONDC_SUBSCRIBER_URL') || '';
    this.storeDomain = this.configService.get<string>('ONDC_DOMAIN') || 'nic2004:52110';
  }

  // ============================================
  // CATALOG BUILDING
  // ============================================

  /**
   * Build a Beckn-compliant catalog from our Search API items.
   * Fetches items from the search service and formats them per ONDC spec.
   *
   * @param storeId - Optional specific store ID. If omitted, builds catalog for all stores.
   */
  async buildCatalog(storeId?: number): Promise<BecknCatalog> {
    try {
      this.logger.log(`Building ONDC catalog${storeId ? ` for store #${storeId}` : ' for all stores'}`);

      // Fetch items from Search API
      const items = await this.fetchItemsFromSearch(storeId);
      const stores = await this.fetchStoresFromSearch();

      // Group items by store
      const storeItemMap = new Map<number, any[]>();
      for (const item of items) {
        const sid = item.store_id;
        if (!storeItemMap.has(sid)) {
          storeItemMap.set(sid, []);
        }
        storeItemMap.get(sid)!.push(item);
      }

      // Build providers (one per store)
      const providers: BecknProvider[] = [];

      for (const store of stores) {
        if (storeId && store.id !== storeId) continue;

        const storeItems = storeItemMap.get(store.id) || [];
        if (storeItems.length === 0) continue;

        const catalogItems = storeItems.map((item) => this.formatItemAsBeckn(item));

        // Extract unique categories
        const categoryMap = new Map<string, string>();
        for (const item of storeItems) {
          if (item.category_id && item.category_name) {
            categoryMap.set(String(item.category_id), item.category_name);
          }
        }

        const categories = Array.from(categoryMap.entries()).map(([id, name]) => ({
          id,
          descriptor: { name },
        }));

        const provider: BecknProvider = {
          id: String(store.id),
          descriptor: {
            name: store.name || 'Unknown Store',
            short_desc: store.description || '',
            images: store.image ? [store.image] : [],
          },
          locations: [
            {
              id: `loc-${store.id}`,
              gps: `${store.latitude || 0},${store.longitude || 0}`,
              address: {
                city: store.city || '',
                state: store.state || '',
                country: 'IND',
                area_code: store.pincode || '',
                street: store.address || '',
              },
              time: {
                label: 'enable',
                range: {
                  start: store.opening_time || '09:00',
                  end: store.closing_time || '22:00',
                },
              },
            },
          ],
          items: catalogItems,
          categories,
          fulfillments: [
            {
              id: `ful-${store.id}-delivery`,
              type: 'Delivery',
              tracking: true,
            },
            {
              id: `ful-${store.id}-pickup`,
              type: 'Self-Pickup',
              tracking: false,
            },
          ],
        };

        providers.push(provider);
      }

      const catalog: BecknCatalog = {
        'bpp/descriptor': {
          name: 'Mangwale',
          short_desc: 'Local delivery and commerce platform',
          images: ['https://mangwale.com/logo.png'],
        },
        'bpp/providers': providers,
        'bpp/fulfillments': [
          { type: 'Delivery', tracking: true },
          { type: 'Self-Pickup', tracking: false },
        ],
      };

      this.logger.log(
        `Catalog built: ${providers.length} providers, ` +
        `${items.length} items total`,
      );

      return catalog;
    } catch (error) {
      this.logger.error(`Failed to build catalog: ${error.message}`, error.stack);
      return {
        'bpp/descriptor': {
          name: 'Mangwale',
          short_desc: 'Local delivery and commerce platform',
        },
        'bpp/providers': [],
      };
    }
  }

  /**
   * Sync the catalog to the ONDC network.
   * Called by the catalog sync processor on a schedule.
   */
  async syncToNetwork(): Promise<{ success: boolean; providers: number; items: number }> {
    try {
      const catalog = await this.buildCatalog();

      const providerCount = catalog['bpp/providers']?.length || 0;
      let itemCount = 0;

      for (const provider of catalog['bpp/providers'] || []) {
        itemCount += provider.items?.length || 0;
      }

      // In a real ONDC implementation, this would push incremental updates
      // to the ONDC network. For now, we just build and store the catalog.
      this.logger.log(
        `Catalog sync complete: ${providerCount} providers, ${itemCount} items`,
      );

      return {
        success: true,
        providers: providerCount,
        items: itemCount,
      };
    } catch (error) {
      this.logger.error(`Catalog sync failed: ${error.message}`, error.stack);
      return { success: false, providers: 0, items: 0 };
    }
  }

  /**
   * Handle an incoming search request from a BAP.
   * Matches the search intent against our catalog and returns matching items.
   */
  async handleSearchRequest(intent: BecknIntent): Promise<BecknCatalog> {
    try {
      this.logger.log(`Handling ONDC search: ${JSON.stringify(intent)}`);

      // Extract search parameters from intent
      const itemName = intent.item?.descriptor?.name;
      const categoryId = intent.category?.id;
      const gps = intent.fulfillment?.end?.location?.gps;
      const areaCode = intent.fulfillment?.end?.location?.address?.area_code;

      // Build search query for our Search API
      let searchUrl = `${this.searchApiUrl}/v2/search/items?`;
      const params: string[] = [];

      if (itemName) {
        params.push(`q=${encodeURIComponent(itemName)}`);
      }

      if (categoryId) {
        params.push(`category_id=${categoryId}`);
      }

      // Default to food module
      params.push('module_ids=4');

      // Zone ID - hardcoded for now, should be derived from GPS/area code
      const zoneId = this.configService.get<string>('DEFAULT_ZONE_ID') || '1';
      params.push(`zone_id=${zoneId}`);

      searchUrl += params.join('&');

      const response = await firstValueFrom(
        this.httpService.get(searchUrl, { timeout: 5000 }),
      );

      const searchResults = response.data?.data?.items || response.data?.items || [];

      // Build catalog from search results
      const catalog = await this.buildCatalog();

      // Filter providers/items based on search results
      if (itemName && catalog['bpp/providers']) {
        for (const provider of catalog['bpp/providers']) {
          if (provider.items) {
            provider.items = provider.items.filter((item) => {
              const name = item.descriptor.name.toLowerCase();
              return name.includes(itemName.toLowerCase());
            });
          }
        }

        // Remove providers with no matching items
        catalog['bpp/providers'] = catalog['bpp/providers'].filter(
          (p) => p.items && p.items.length > 0,
        );
      }

      this.logger.log(
        `Search matched ${catalog['bpp/providers']?.length || 0} providers`,
      );

      return catalog;
    } catch (error) {
      this.logger.error(`Failed to handle search request: ${error.message}`, error.stack);
      return {
        'bpp/descriptor': {
          name: 'Mangwale',
          short_desc: 'Local delivery and commerce platform',
        },
        'bpp/providers': [],
      };
    }
  }

  /**
   * Format an internal item (from Search API) as a Beckn CatalogItem.
   */
  formatItemAsBeckn(item: any): CatalogItem {
    const price = parseFloat(item.price || item.selling_price || '0').toFixed(2);
    const maxPrice = parseFloat(item.original_price || item.price || '0').toFixed(2);

    return {
      id: String(item.id),
      descriptor: {
        name: item.name || 'Unknown Item',
        short_desc: item.description || item.short_description || '',
        long_desc: item.long_description || '',
        images: item.image ? [item.image] : [],
        code: item.sku || item.slug || '',
      },
      price: {
        listed_value: maxPrice,
        currency: 'INR',
        value: price,
        offered_value: price,
        maximum_value: maxPrice,
      },
      category_id: String(item.category_id || ''),
      fulfillment_id: `ful-${item.store_id}-delivery`,
      location_id: `loc-${item.store_id}`,
      available: item.active !== false && item.in_stock !== false,
      quantity: {
        available: {
          count: item.stock_quantity || 99,
        },
        maximum: {
          count: item.max_order_quantity || 10,
        },
      },
      '@ondc/org/returnable': item.returnable || false,
      '@ondc/org/cancellable': true,
      '@ondc/org/return_window': item.return_window || 'P0D',
      '@ondc/org/time_to_ship': item.preparation_time
        ? `PT${item.preparation_time}M`
        : 'PT30M',
      '@ondc/org/available_on_cod': item.cod_available || false,
    };
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  /**
   * Fetch items from the Search API.
   */
  private async fetchItemsFromSearch(storeId?: number): Promise<any[]> {
    try {
      let url = `${this.searchApiUrl}/v2/search/items?module_ids=4&zone_id=1&limit=500`;
      if (storeId) {
        url += `&store_id=${storeId}`;
      }

      const response = await firstValueFrom(
        this.httpService.get(url, { timeout: 10000 }),
      );

      const items = response.data?.data?.items || response.data?.items || [];
      this.logger.debug(`Fetched ${items.length} items from Search API`);
      return items;
    } catch (error) {
      this.logger.error(`Failed to fetch items from Search API: ${error.message}`, error.stack);
      return [];
    }
  }

  /**
   * Fetch stores from the Search API.
   */
  private async fetchStoresFromSearch(): Promise<any[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.searchApiUrl}/v2/search/stores?module_ids=4&zone_id=1&limit=100`, {
          timeout: 10000,
        }),
      );

      const stores = response.data?.data?.stores || response.data?.stores || [];
      this.logger.debug(`Fetched ${stores.length} stores from Search API`);
      return stores;
    } catch (error) {
      this.logger.error(`Failed to fetch stores from Search API: ${error.message}`, error.stack);
      return [];
    }
  }
}
