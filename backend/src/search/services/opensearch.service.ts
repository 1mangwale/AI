import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { SearchResultDto, SearchHit } from '../dto/search-result.dto';
import { SearchFilter } from '../dto/search.dto';

/**
 * ⚠️ DEPRECATED for search operations
 * 
 * This service provides direct OpenSearch access and is now DEPRECATED
 * for read/search operations. Use the V3 Search API instead:
 * 
 * - For hybrid search: Use /search/hybrid/{module} endpoint
 * - For semantic search: Use /search/hybrid/{module} (includes KNN)
 * - For AI agent: Use AIAgentSearchService
 * 
 * KEEP FOR:
 * - Bulk indexing operations (admin)
 * - Document indexing (RAG, conversation memory)
 * - Direct cluster management
 * 
 * DO NOT USE FOR:
 * - User-facing searches
 * - Entity resolution
 * - Item/store lookups
 * 
 * Migration: Replace this.openSearchService.keywordSearch() 
 * with this.httpService.get('${SEARCH_API_URL}/search/hybrid/food')
 */
@Injectable()
export class OpenSearchService {
  private readonly logger = new Logger(OpenSearchService.name);
  private readonly opensearchUrl: string;
  private readonly username: string;
  private readonly password: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.opensearchUrl = this.config.get('OPENSEARCH_URL');
    this.username = this.config.get('OPENSEARCH_USERNAME', 'admin');
    this.password = this.config.get('OPENSEARCH_PASSWORD');
    
    if (!this.password) {
      throw new Error('OPENSEARCH_PASSWORD environment variable is required');
    }
  }

  async keywordSearch(
    query: string,
    index: string = '_all',
    limit: number = 10,
    offset: number = 0,
    filters?: SearchFilter[],
  ): Promise<SearchResultDto> {
    const startTime = Date.now();

    try {
      const searchBody = {
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query,
                  fields: ['name^3', 'title^3', 'description^2', 'content', 'tags'],
                  type: 'best_fields',
                  fuzziness: 'AUTO',
                },
              },
            ],
            filter: this.buildFilters(filters),
          },
        },
        from: offset,
        size: limit,
        highlight: {
          fields: {
            name: {},
            description: {},
            content: {},
          },
        },
      };

      const response = await firstValueFrom(
        this.httpService.post(`${this.opensearchUrl}/${index}/_search`, searchBody, {
          auth: {
            username: this.username,
            password: this.password,
          },
        }),
      );

      const data = response.data;

      return {
        results: data.hits?.hits?.map((hit: any) => ({
          id: hit._id,
          index: hit._index,
          score: hit._score,
          source: hit._source,
          highlights: hit.highlight,
        })) || [],
        total: data.hits?.total?.value || 0,
        took: Date.now() - startTime,
        searchType: 'keyword',
        query,
      };
    } catch (error) {
      this.logger.error(`OpenSearch keyword search failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Vector search with automatic field selection based on embedding dimension
   * - 384-dim: Uses embedding_384 field (MiniLM for English)
   * - 768-dim: Uses embedding_768 field (IndicBERT for Hindi/Indic)
   * - Falls back to 'embedding' field for legacy indices
   */
  async vectorSearch(
    embedding: number[],
    index: string = '_all',
    limit: number = 10,
    offset: number = 0,
    filters?: SearchFilter[],
  ): Promise<SearchResultDto> {
    const startTime = Date.now();

    // Determine which embedding field to use based on vector dimension and index
    const embeddingField = this.getEmbeddingField(embedding.length, index);
    this.logger.debug(`Vector search using field: ${embeddingField} (${embedding.length}-dim) in index: ${index}`);

    // Build filters for filtering
    const builtFilters = this.buildFilters(filters);
    if (builtFilters.length > 0) {
      this.logger.log(`📋 Vector search filters: ${JSON.stringify(builtFilters)}`);
    }

    try {
      let searchBody: any;
      
      if (builtFilters.length > 0) {
        // When filters exist, use bool query with pre-filtering
        // This ensures filters are applied before/during KNN search
        // OpenSearch 2.x approach: filter inside knn or use hybrid query
        const filterQuery = builtFilters.length === 1 
          ? builtFilters[0] 
          : { bool: { must: builtFilters } };

        searchBody = {
          query: {
            knn: {
              [embeddingField]: {
                vector: embedding,
                k: limit * 10, // Request more candidates when filtering
                filter: filterQuery, // Pre-filter in KNN (OpenSearch 2.x)
              },
            },
          },
          size: limit,
        };

        this.logger.debug(`OpenSearch KNN query with filter: k=${limit * 10}, filter=${JSON.stringify(filterQuery)}`);
      } else {
        // No filters - simple KNN search
        searchBody = {
          query: {
            knn: {
              [embeddingField]: {
                vector: embedding,
                k: limit,
              },
            },
          },
          from: offset,
          size: limit,
        };
        
        this.logger.debug(`OpenSearch KNN query: k=${limit}`);
      }

      const response = await firstValueFrom(
        this.httpService.post(`${this.opensearchUrl}/${index}/_search`, searchBody, {
          auth: {
            username: this.username,
            password: this.password,
          },
        }),
      );

      const data = response.data;

      return {
        results: data.hits?.hits?.map((hit: any) => ({
          id: hit._id,
          index: hit._index,
          score: hit._score,
          source: hit._source,
        })) || [],
        total: data.hits?.total?.value || 0,
        took: Date.now() - startTime,
        searchType: 'semantic',
        query: '<vector>',
      };
    } catch (error) {
      this.logger.error(`OpenSearch vector search failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Determine embedding field based on vector dimension and index
   * Different indices may have different field names:
   * - food_items_v3: item_vector (768-dim)
   * - ecom_items_v3: item_vector (384-dim)
   * - Other indices: embedding_384 or embedding_768
   */
  private getEmbeddingField(dimension: number, index?: string): string {
    // Food and ecom items use 'item_vector' field
    if (index && (index.includes('food_items_v3') || index.includes('ecom_items_v3'))) {
      return 'item_vector';
    }
    
    switch (dimension) {
      case 384:
        return 'embedding_384';
      case 768:
        return 'embedding_768';
      default:
        // Legacy fallback
        return 'embedding';
    }
  }

  async indexDocument(index: string, id: string, document: Record<string, any>): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.put(
          `${this.opensearchUrl}/${index}/_doc/${id}`,
          document,
          {
            auth: {
              username: this.username,
              password: this.password,
            },
          },
        ),
      );

      this.logger.log(`Document ${id} indexed in ${index}`);
    } catch (error) {
      this.logger.error(`Failed to index document: ${error.message}`, error.stack);
      throw error;
    }
  }

  private buildFilters(filters?: SearchFilter[]): any[] {
    if (!filters || filters.length === 0) {
      return [];
    }

    return filters.map((filter) => {
      switch (filter.operator) {
        case 'equals':
          return { term: { [filter.field]: filter.value } };
        case 'contains':
          // Use fuzzy match for partial/misspelled matching of store names
          // This allows "inyat" to match "Inayat Cafe" (handles typos + case-insensitive)
          const searchValue = String(filter.value);
          return { 
            match: { 
              [filter.field]: {
                query: searchValue,
                fuzziness: 'AUTO'  // Allows 1-2 character differences based on word length
              }
            } 
          };
        case 'range':
          return { range: { [filter.field]: filter.value } };
        case 'geo_distance':
          // Expects value: { lat, lon, distance }
          return {
            geo_distance: {
              distance: filter.value.distance || '5km',
              [filter.field]: {
                lat: filter.value.lat,
                lon: filter.value.lon,
              },
            },
          };
        default:
          return { term: { [filter.field]: filter.value } };
      }
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.opensearchUrl}/_cluster/health`, {
          auth: {
            username: this.username,
            password: this.password,
          },
        }),
      );
      return response.data.status !== 'red';
    } catch (error) {
      return false;
    }
  }

  async rawSearch(
    index: string,
    body: any,
  ): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.opensearchUrl}/${index}/_search`, body, {
          auth: {
            username: this.username,
            password: this.password,
          },
        }),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`OpenSearch raw search failed: ${error.message}`, error.stack);
      throw error;
    }
  }
}
