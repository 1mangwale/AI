import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { UnifiedEmbeddingService } from '../search/services/unified-embedding.service';

/**
 * Conversation Memory Entry stored in OpenSearch
 */
export interface ConversationMemoryEntry {
  id?: string;
  userId?: number;
  sessionId: string;
  phoneNumber?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  summary?: string;
  turnNumber: number;
  timestamp: Date;
  metadata?: {
    intent?: string;
    entities?: Record<string, any>;
    sentiment?: 'positive' | 'negative' | 'neutral';
    tenantId?: string;
  };
}

/**
 * Search result for similar memories
 */
export interface MemorySearchResult {
  entry: ConversationMemoryEntry;
  score: number;
}

/**
 * Conversation Memory Service
 * 
 * Provides long-term conversation memory with semantic search using:
 * - OpenSearch k-NN for vector storage and similarity search
 * - Unified Embedding Service for language-aware embeddings
 * 
 * Benefits:
 * - Retrieve relevant past conversations for context
 * - Personalized responses based on conversation history
 * - Cross-session memory for returning users
 */
@Injectable()
export class ConversationMemoryService {
  private readonly logger = new Logger(ConversationMemoryService.name);
  private readonly opensearchUrl: string;
  private readonly indexName = 'conversation_memory_vectors';
  private enabled = true;

  private consecutiveFailures = 0;
  private readonly maxConsecutiveFailures = 3;
  private circuitBreakerResetTime = 0;
  private readonly circuitBreakerCooldownMs = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    @Inject(forwardRef(() => UnifiedEmbeddingService))
    private readonly embeddingService: UnifiedEmbeddingService,
  ) {
    this.opensearchUrl = this.configService.get('OPENSEARCH_URL');
    // Disable via env toggle
    const enableMemory = this.configService.get('ENABLE_CONVERSATION_MEMORY', 'true');
    if (enableMemory === 'false' || enableMemory === '0' || !this.opensearchUrl) {
      this.enabled = false;
      this.logger.warn(`🧠 Conversation Memory Service DISABLED (ENABLE_CONVERSATION_MEMORY=${enableMemory}, OPENSEARCH_URL=${this.opensearchUrl || 'not set'})`);
    } else {
      this.logger.log(`🧠 Conversation Memory Service initialized`);
      this.logger.log(`   OpenSearch: ${this.opensearchUrl}`);
      this.logger.log(`   Index: ${this.indexName}`);
    }
  }

  /**
   * Circuit breaker: disable service after consecutive failures, re-enable after cooldown
   */
  private isCircuitOpen(): boolean {
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      if (Date.now() < this.circuitBreakerResetTime) {
        return true; // Circuit still open
      }
      // Cooldown expired — reset and allow one attempt
      this.consecutiveFailures = 0;
      this.logger.log('🧠 Circuit breaker reset — retrying OpenSearch connection');
    }
    return false;
  }

  private recordFailure(error: Error): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.circuitBreakerResetTime = Date.now() + this.circuitBreakerCooldownMs;
      this.logger.warn(`🧠 Circuit breaker OPEN — ${this.consecutiveFailures} consecutive failures. Will retry in 5 minutes. Last error: ${error.message}`);
    }
  }

  private recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.consecutiveFailures = 0;
      this.logger.log('🧠 OpenSearch connection restored');
    }
  }

  /**
   * Store a conversation turn in memory with embedding
   */
  async store(entry: ConversationMemoryEntry): Promise<string | null> {
    if (!this.enabled || this.isCircuitOpen()) return null;

    try {
      // Generate embedding for the content
      const embeddingResult = await this.embeddingService.embed(entry.content);

      // Prepare document for OpenSearch
      const doc: any = {
        user_id: entry.userId,
        session_id: entry.sessionId,
        phone_number: entry.phoneNumber,
        role: entry.role,
        content: entry.content,
        summary: entry.summary || this.summarizeContent(entry.content),
        turn_number: entry.turnNumber,
        timestamp: entry.timestamp || new Date(),
        metadata: entry.metadata || {},
      };

      // Add embedding based on dimension
      if (embeddingResult.dimensions === 384) {
        doc.embedding_384 = embeddingResult.embedding;
      } else {
        doc.embedding_768 = embeddingResult.embedding;
      }

      // Index to OpenSearch
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.opensearchUrl}/${this.indexName}/_doc`,
          doc,
          { timeout: 10000 }
        )
      );

      const docId = response.data?._id;
      this.logger.debug(`📝 Stored memory: ${docId} (${embeddingResult.dimensions}d, ${entry.role})`);
      this.recordSuccess();

      return docId;
    } catch (error) {
      this.recordFailure(error);
      return null;
    }
  }

  /**
   * Store multiple conversation turns efficiently
   */
  async storeBatch(entries: ConversationMemoryEntry[]): Promise<number> {
    if (!this.enabled || entries.length === 0) return 0;

    let stored = 0;
    
    // Process in batches of 10
    for (let i = 0; i < entries.length; i += 10) {
      const batch = entries.slice(i, i + 10);
      
      const results = await Promise.all(
        batch.map(entry => this.store(entry))
      );
      
      stored += results.filter(id => id !== null).length;
    }

    this.logger.log(`📦 Stored ${stored}/${entries.length} memory entries`);
    return stored;
  }

  /**
   * Search for similar conversations using semantic search
   */
  async searchSimilar(
    query: string,
    options: {
      userId?: number;
      sessionId?: string;
      tenantId?: string;
      limit?: number;
      minScore?: number;
    } = {}
  ): Promise<MemorySearchResult[]> {
    if (!this.enabled || this.isCircuitOpen()) return [];

    try {
      const { userId, sessionId, tenantId, limit = 5, minScore = 0.7 } = options;

      // Generate embedding for query
      const embeddingResult = await this.embeddingService.embed(query);
      const fieldName = embeddingResult.dimensions === 384 ? 'embedding_384' : 'embedding_768';

      // Build filter for user/session/tenant
      const filters: any[] = [];
      if (userId) filters.push({ term: { user_id: userId } });
      if (sessionId) filters.push({ term: { session_id: sessionId } });
      if (tenantId) filters.push({ term: { 'metadata.tenantId': tenantId } });

      // Build k-NN search query
      const searchQuery = {
        size: limit,
        query: {
          bool: {
            filter: filters.length > 0 ? filters : undefined,
            must: {
              knn: {
                [fieldName]: {
                  vector: embeddingResult.embedding,
                  k: limit,
                },
              },
            },
          },
        },
        _source: true,
      };

      // Execute search
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.opensearchUrl}/${this.indexName}/_search`,
          searchQuery,
          { timeout: 10000 }
        )
      );

      const hits = response.data?.hits?.hits || [];
      
      // Filter by minimum score and map to results
      const results: MemorySearchResult[] = hits
        .filter((hit: any) => hit._score >= minScore)
        .map((hit: any) => ({
          entry: {
            id: hit._id,
            userId: hit._source.user_id,
            sessionId: hit._source.session_id,
            phoneNumber: hit._source.phone_number,
            role: hit._source.role,
            content: hit._source.content,
            summary: hit._source.summary,
            turnNumber: hit._source.turn_number,
            timestamp: new Date(hit._source.timestamp),
            metadata: hit._source.metadata,
          },
          score: hit._score,
        }));

      this.logger.debug(`🔍 Found ${results.length} similar memories for query`);
      this.recordSuccess();
      return results;
    } catch (error) {
      this.recordFailure(error);
      return [];
    }
  }

  /**
   * Get recent conversation history for a session
   */
  async getRecentHistory(
    sessionId: string,
    limit: number = 10
  ): Promise<ConversationMemoryEntry[]> {
    if (!this.enabled || this.isCircuitOpen()) return [];

    try {
      const searchQuery = {
        size: limit,
        sort: [{ turn_number: { order: 'desc' } }],
        query: {
          term: { session_id: sessionId },
        },
        _source: true,
      };

      const response = await firstValueFrom(
        this.httpService.post(
          `${this.opensearchUrl}/${this.indexName}/_search`,
          searchQuery,
          { timeout: 10000 }
        )
      );

      const hits = response.data?.hits?.hits || [];
      
      return hits.map((hit: any) => ({
        id: hit._id,
        userId: hit._source.user_id,
        sessionId: hit._source.session_id,
        phoneNumber: hit._source.phone_number,
        role: hit._source.role,
        content: hit._source.content,
        summary: hit._source.summary,
        turnNumber: hit._source.turn_number,
        timestamp: new Date(hit._source.timestamp),
        metadata: hit._source.metadata,
      })).reverse(); // Return in chronological order
    } catch (error) {
      this.recordFailure(error);
      return [];
    }
  }

  /**
   * Get relevant past conversations for a user across sessions
   */
  async getRelevantMemories(
    query: string,
    userId: number,
    limit: number = 5
  ): Promise<MemorySearchResult[]> {
    return this.searchSimilar(query, { userId, limit });
  }

  /**
   * Build context from memories for LLM prompt
   */
  async buildContextFromMemories(
    query: string,
    options: {
      userId?: number;
      sessionId?: string;
      maxMemories?: number;
    } = {}
  ): Promise<string> {
    const { userId, sessionId, maxMemories = 3 } = options;

    // Get similar memories
    const memories = await this.searchSimilar(query, {
      userId,
      limit: maxMemories,
      minScore: 0.7,
    });

    if (memories.length === 0) {
      return '';
    }

    // Format memories for context
    const contextLines = memories.map(m => {
      const date = m.entry.timestamp.toLocaleDateString('en-IN');
      return `[${date}] ${m.entry.role === 'user' ? 'User' : 'You'}: ${m.entry.summary || m.entry.content.substring(0, 200)}`;
    });

    return `## Relevant Past Conversations\n${contextLines.join('\n')}\n`;
  }

  /**
   * Delete memories for a session
   */
  async deleteSessionMemories(sessionId: string): Promise<number> {
    if (!this.enabled || this.isCircuitOpen()) return 0;

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.opensearchUrl}/${this.indexName}/_delete_by_query`,
          {
            query: { term: { session_id: sessionId } },
          },
          { timeout: 30000 }
        )
      );

      const deleted = response.data?.deleted || 0;
      this.logger.log(`🗑️ Deleted ${deleted} memories for session ${sessionId}`);
      return deleted;
    } catch (error) {
      this.logger.error(`Failed to delete session memories: ${error.message}`);
      return 0;
    }
  }

  /**
   * Delete all memories for a user (GDPR compliance)
   */
  async deleteUserMemories(userId: number): Promise<number> {
    if (!this.enabled || this.isCircuitOpen()) return 0;

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.opensearchUrl}/${this.indexName}/_delete_by_query`,
          {
            query: { term: { user_id: userId } },
          },
          { timeout: 60000 }
        )
      );

      const deleted = response.data?.deleted || 0;
      this.logger.log(`🗑️ Deleted ${deleted} memories for user ${userId}`);
      return deleted;
    } catch (error) {
      this.logger.error(`Failed to delete user memories: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get memory statistics
   */
  async getStats(tenantId?: string): Promise<{
    totalMemories: number;
    uniqueUsers: number;
    uniqueSessions: number;
  }> {
    try {
      const query: any = tenantId 
        ? { query: { term: { 'metadata.tenantId': tenantId } } }
        : { query: { match_all: {} } };

      const response = await firstValueFrom(
        this.httpService.post(
          `${this.opensearchUrl}/${this.indexName}/_search`,
          {
            ...query,
            size: 0,
            aggs: {
              unique_users: { cardinality: { field: 'user_id' } },
              unique_sessions: { cardinality: { field: 'session_id' } },
            },
          },
          { timeout: 10000 }
        )
      );

      return {
        totalMemories: response.data?.hits?.total?.value || 0,
        uniqueUsers: response.data?.aggregations?.unique_users?.value || 0,
        uniqueSessions: response.data?.aggregations?.unique_sessions?.value || 0,
      };
    } catch (error) {
      this.logger.error(`Failed to get memory stats: ${error.message}`);
      return { totalMemories: 0, uniqueUsers: 0, uniqueSessions: 0 };
    }
  }

  /**
   * Simple content summarization (truncate with key info)
   */
  private summarizeContent(content: string, maxLength: number = 200): string {
    if (content.length <= maxLength) return content;
    
    // Try to end at a sentence boundary
    const truncated = content.substring(0, maxLength);
    const lastSentence = truncated.lastIndexOf('.');
    const lastQuestion = truncated.lastIndexOf('?');
    const breakPoint = Math.max(lastSentence, lastQuestion);
    
    if (breakPoint > maxLength * 0.5) {
      return truncated.substring(0, breakPoint + 1);
    }
    
    return truncated.substring(0, truncated.lastIndexOf(' ')) + '...';
  }

  /**
   * Check if service is available
   */
  isAvailable(): boolean {
    return this.enabled;
  }
}
