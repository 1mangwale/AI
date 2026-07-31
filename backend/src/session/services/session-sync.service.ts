/**
 * Session Sync Service
 * 
 * GAP 4 Fix: Unify Session Management
 * 
 * This service ensures consistency between:
 * - Redis (fast, transient session storage)
 * - PostgreSQL FlowRun table (permanent execution records)
 * 
 * Responsibilities:
 * 1. Sync flow context between Redis ↔ DB on each message
 * 2. Handle Redis TTL expiry gracefully (recover from DB)
 * 3. Clean up orphaned FlowRun records
 * 4. Provide single source of truth for active flow status
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { SessionService } from '../session.service';
import { FlowContext } from '../../flow-engine/types/flow.types';

interface ActiveFlowInfo {
  flowRunId: string;
  flowId: string;
  currentState: string;
  context: FlowContext;
  source: 'redis' | 'db' | 'synced';
  outOfSync: boolean;
}

@Injectable()
export class SessionSyncService {
  private readonly logger = new Logger(SessionSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  /**
   * Get active flow info with sync check
   * 
   * This is the SINGLE SOURCE OF TRUTH for whether a user has an active flow.
   * It checks both Redis and DB, handles discrepancies, and returns consistent state.
   */
  async getActiveFlow(sessionId: string): Promise<ActiveFlowInfo | null> {
    // 1. Check Redis (primary source for running sessions)
    const session = await this.sessionService.getSession(sessionId);
    const redisFlowContext = session?.data?.flowContext;

    // 2. Check DB for active FlowRun
    // NOTE: Flow engine creates with status='active', then updates to 'running' after first execution.
    // We need to check BOTH statuses to find in-progress flows.
    const dbFlowRun = await this.prisma.flowRun.findFirst({
      where: {
        sessionId,
        status: { in: ['active', 'running'] },
      },
      orderBy: {
        startedAt: 'desc',
      },
    });

    // Case 1: Both have active flow - check if they match
    if (redisFlowContext?.flowRunId && dbFlowRun) {
      if (redisFlowContext.flowRunId === dbFlowRun.id) {
        const now = new Date();
        const flowContext: FlowContext = {
          _system: {
            flowId: redisFlowContext.flowId,
            flowRunId: redisFlowContext.flowRunId,
            sessionId,
            currentState: redisFlowContext.currentState,
            previousStates: [],
            startedAt: dbFlowRun.startedAt,
            lastUpdatedAt: now,
            attemptCount: 0,
            errorHistory: [],
          },
          data: redisFlowContext.data || {},
        };

        // ✅ In sync - return Redis (has fresher context)
        return {
          flowRunId: redisFlowContext.flowRunId,
          flowId: redisFlowContext.flowId,
          currentState: redisFlowContext.currentState,
          context: flowContext,
          source: 'synced',
          outOfSync: false,
        };
      } else {
        // ⚠️ Different flow runs - Redis has newer, mark DB one as abandoned
        this.logger.warn(`🔄 Session ${sessionId} has mismatched flows: Redis=${redisFlowContext.flowRunId}, DB=${dbFlowRun.id}`);
        
        // Mark the old DB flow as abandoned
        await this.markFlowAbandoned(dbFlowRun.id, 'Superseded by new flow');
        
        const now = new Date();
        const flowContext: FlowContext = {
          _system: {
            flowId: redisFlowContext.flowId,
            flowRunId: redisFlowContext.flowRunId,
            sessionId,
            currentState: redisFlowContext.currentState,
            previousStates: [],
            startedAt: now,
            lastUpdatedAt: now,
            attemptCount: 0,
            errorHistory: [],
          },
          data: redisFlowContext.data || {},
        };

        return {
          flowRunId: redisFlowContext.flowRunId,
          flowId: redisFlowContext.flowId,
          currentState: redisFlowContext.currentState,
          context: flowContext,
          source: 'redis',
          outOfSync: true,
        };
      }
    }

    // Case 2: Only Redis has active flow (DB record missing/completed)
    if (redisFlowContext?.flowRunId && !dbFlowRun) {
      this.logger.debug(`📝 Session ${sessionId} has flow in Redis but not in DB - checking if DB record exists`);
      
      // Check if the flow run exists at all (might be completed)
      const existingRun = await this.prisma.flowRun.findUnique({
        where: { id: redisFlowContext.flowRunId },
      });

      if (existingRun) {
        if (existingRun.status === 'completed' || existingRun.status === 'failed') {
          // DB says flow is done but Redis still has it - clear Redis
          this.logger.warn(`🧹 Clearing stale flow from Redis: ${redisFlowContext.flowRunId} (DB status: ${existingRun.status})`);
          await this.clearFlowFromRedis(sessionId);
          return null;
        }
      }

      // Redis has valid context, trust it
      const now = new Date();
      const flowContext: FlowContext = {
        _system: {
          flowId: redisFlowContext.flowId,
          flowRunId: redisFlowContext.flowRunId,
          sessionId,
          currentState: redisFlowContext.currentState,
          previousStates: [],
          startedAt: now,
          lastUpdatedAt: now,
          attemptCount: 0,
          errorHistory: [],
        },
        data: redisFlowContext.data || {},
      };

      return {
        flowRunId: redisFlowContext.flowRunId,
        flowId: redisFlowContext.flowId,
        currentState: redisFlowContext.currentState,
        context: flowContext,
        source: 'redis',
        outOfSync: !existingRun,
      };
    }

    // Case 3: Only DB has active flow (Redis expired)
    if (!redisFlowContext?.flowRunId && dbFlowRun) {
      // Stale-flow guard (2026-07-31): Redis expiry is the liveness signal.
      // A DB flow started >24h ago is a dead conversation — abandon it instead
      // of resuming (a Jan 7 parcel flow once resumed mid-message in July).
      const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;
      const flowAgeMs = Date.now() - new Date(dbFlowRun.startedAt).getTime();
      if (flowAgeMs > MAX_RECOVERY_AGE_MS) {
        const ageHours = Math.round(flowAgeMs / 3600000);
        this.logger.warn(`🧹 Not resuming stale flow ${dbFlowRun.id} (started ${ageHours}h ago) — marking abandoned`);
        await this.markFlowAbandoned(dbFlowRun.id, `Stale flow not resumed (started ${ageHours}h ago)`);
        return null;
      }

      this.logger.warn(`🔄 Recovering flow from DB for session ${sessionId}: ${dbFlowRun.id}`);
      
      // Recover context from DB
      const dbContext = dbFlowRun.context as any || {};
      const now = new Date();
      const context: FlowContext = {
        _system: {
          flowId: dbFlowRun.flowId,
          flowRunId: dbFlowRun.id,
          sessionId,
          currentState: dbFlowRun.currentState || 'unknown',
          previousStates: [],
          startedAt: dbFlowRun.startedAt,
          lastUpdatedAt: now,
          attemptCount: 0,
          errorHistory: [],
        },
        data: dbContext.data || dbContext || {},
      };

      // Restore to Redis
      await this.saveFlowToRedis(sessionId, {
        flowId: dbFlowRun.flowId,
        flowRunId: dbFlowRun.id,
        currentState: dbFlowRun.currentState || 'unknown',
        data: context.data,
      });

      return {
        flowRunId: dbFlowRun.id,
        flowId: dbFlowRun.flowId,
        currentState: dbFlowRun.currentState || 'unknown',
        context,
        source: 'db',
        outOfSync: true, // Was recovered from DB
      };
    }

    // Case 4: No active flow anywhere
    return null;
  }

  /**
   * Sync context from Redis to DB
   * Called after each message processing to persist state
   */
  async syncToDatabase(
    flowRunId: string,
    currentState: string,
    context: FlowContext,
    status: 'active' | 'completed' | 'failed' | 'abandoned' = 'active'
  ): Promise<void> {
    try {
      await this.prisma.flowRun.update({
        where: { id: flowRunId },
        data: {
          currentState,
          context: context as any,
          status,
          completedAt: ['completed', 'failed', 'abandoned'].includes(status) 
            ? new Date() 
            : undefined,
        },
      });
      
      this.logger.debug(`💾 Synced flow ${flowRunId} to DB: state=${currentState}, status=${status}`);
    } catch (error) {
      this.logger.error(`Failed to sync flow ${flowRunId} to DB: ${error.message}`);
    }
  }

  /**
   * Mark a flow run as abandoned
   */
  async markFlowAbandoned(flowRunId: string, reason: string): Promise<void> {
    try {
      await this.prisma.flowRun.update({
        where: { id: flowRunId },
        data: {
          status: 'abandoned',
          error: reason,
          completedAt: new Date(),
        },
      });
      this.logger.log(`🗑️ Marked flow ${flowRunId} as abandoned: ${reason}`);
    } catch (error) {
      this.logger.warn(`Could not mark flow ${flowRunId} as abandoned: ${error.message}`);
    }
  }

  /**
   * Clear flow context from Redis session
   */
  async clearFlowFromRedis(sessionId: string): Promise<void> {
    const session = await this.sessionService.getSession(sessionId);
    if (session) {
      // Preserve conversation history
      const history = session.data?._conversation_history || 
                     session.data?.flowContext?.data?._conversation_history || [];
      
      await this.sessionService.saveSession(sessionId, {
        data: {
          ...session.data,
          flowContext: null,
          _conversation_history: Array.isArray(history) ? history.slice(-40) : [],
        },
      });
    }
  }

  /**
   * Save flow context to Redis
   */
  async saveFlowToRedis(
    sessionId: string, 
    flowContext: { flowId: string; flowRunId: string; currentState: string; data: any }
  ): Promise<void> {
    const session = await this.sessionService.getSession(sessionId);
    await this.sessionService.saveSession(sessionId, {
      data: {
        ...session?.data,
        flowContext,
      },
    });
  }

  /**
   * Clean up orphaned flow runs for a session
   * Called when starting a new flow or after long inactivity
   */
  async cleanupOrphanedFlows(sessionId: string, excludeFlowRunId?: string): Promise<number> {
    const whereClause: any = {
      sessionId,
      status: { in: ['active', 'running'] },
    };

    if (excludeFlowRunId) {
      whereClause.id = { not: excludeFlowRunId };
    }

    const result = await this.prisma.flowRun.updateMany({
      where: whereClause,
      data: {
        status: 'abandoned',
        error: 'Orphaned flow cleanup',
        completedAt: new Date(),
      },
    });

    if (result.count > 0) {
      this.logger.log(`🧹 Cleaned up ${result.count} orphaned flows for session ${sessionId}`);
    }

    return result.count;
  }

  /**
   * Global cleanup of old abandoned flows (run periodically)
   */
  async cleanupStaleFlows(maxAgeMinutes: number = 30): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);

    const result = await this.prisma.flowRun.updateMany({
      where: {
        status: { in: ['active', 'running'] },
        startedAt: { lt: cutoff },
      },
      data: {
        status: 'abandoned',
        error: `Stale flow (>${maxAgeMinutes} mins inactive)`,
        completedAt: new Date(),
      },
    });

    if (result.count > 0) {
      this.logger.log(`🧹 Cleaned up ${result.count} stale flows older than ${maxAgeMinutes} minutes`);
    }

    return result.count;
  }

  /**
   * Ensure flow completion is recorded in both Redis and DB
   */
  async completeFlow(
    sessionId: string,
    flowRunId: string,
    finalState: string,
    context: FlowContext
  ): Promise<void> {
    // 1. Update DB
    await this.syncToDatabase(flowRunId, finalState, context, 'completed');
    
    // 2. Clear from Redis (preserving history)
    await this.clearFlowFromRedis(sessionId);
    
    this.logger.log(`✅ Flow ${flowRunId} completed and synced`);
  }
}
