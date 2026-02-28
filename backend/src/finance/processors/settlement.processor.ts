/**
 * Settlement Processor
 *
 * BullMQ processor for asynchronous settlement jobs:
 *
 * - generate-batch: Generates settlements for all stores with active
 *   commissions in a given period. Used for scheduled bulk settlement runs.
 *
 * - process-payout: Processes a single payout for a confirmed settlement.
 *   Calls PayoutService which handles the actual bank transfer (stubbed).
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SettlementService } from '../services/settlement.service';
import { PayoutService } from '../services/payout.service';

@Processor('settlement-processing')
export class SettlementProcessor extends WorkerHost {
  private readonly logger = new Logger(SettlementProcessor.name);

  constructor(
    private readonly settlementService: SettlementService,
    private readonly payoutService: PayoutService,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    this.logger.log(
      `Processing job ${job.name} (id=${job.id}, attempt=${job.attemptsMade + 1})`,
    );

    try {
      switch (job.name) {
        case 'generate-batch':
          return await this.handleGenerateBatch(job);
        case 'process-payout':
          return await this.handleProcessPayout(job);
        default:
          this.logger.warn(`Unknown settlement job type: ${job.name}`);
          return { success: false, reason: `Unknown job type: ${job.name}` };
      }
    } catch (error) {
      this.logger.error(
        `Job ${job.name} failed: ${error.message}`,
        error.stack,
      );
      throw error; // Let BullMQ handle retries
    }
  }

  /**
   * Generate settlements for all stores that have active commissions
   * in the specified period.
   *
   * Job data: { periodStart: string, periodEnd: string }
   */
  private async handleGenerateBatch(
    job: Job<{ periodStart: string; periodEnd: string }>,
  ): Promise<{ generated: number; failed: number; storeIds: number[] }> {
    const { periodStart, periodEnd } = job.data;
    const start = new Date(periodStart);
    const end = new Date(periodEnd);

    this.logger.log(
      `Generating batch settlements for period ${periodStart} to ${periodEnd}`,
    );

    // Get all stores with commissions in the period
    const storeIds =
      await this.settlementService.getStoresWithCommissions(start, end);

    if (storeIds.length === 0) {
      this.logger.log('No stores with commissions found for the period');
      return { generated: 0, failed: 0, storeIds: [] };
    }

    this.logger.log(
      `Found ${storeIds.length} stores with commissions, generating settlements...`,
    );

    let generated = 0;
    let failed = 0;
    const successStoreIds: number[] = [];

    for (const storeId of storeIds) {
      try {
        const settlement = await this.settlementService.generateSettlement(
          storeId,
          start,
          end,
        );

        if (settlement) {
          generated++;
          successStoreIds.push(storeId);
          this.logger.debug(
            `Settlement generated for store=${storeId}: ${settlement.id}`,
          );
        }

        // Update job progress
        await job.updateProgress(
          Math.round(((generated + failed) / storeIds.length) * 100),
        );
      } catch (error) {
        failed++;
        this.logger.error(
          `Failed to generate settlement for store=${storeId}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `Batch settlement complete: ${generated} generated, ${failed} failed out of ${storeIds.length} stores`,
    );

    return { generated, failed, storeIds: successStoreIds };
  }

  /**
   * Process a single payout for a confirmed settlement.
   *
   * Job data: { settlementId: string, storeId: number, amount: number }
   */
  private async handleProcessPayout(
    job: Job<{
      settlementId: string;
      storeId: number;
      amount: number;
      payoutId?: string;
    }>,
  ): Promise<{ success: boolean; payoutId?: string; reference?: string }> {
    const { settlementId, storeId, amount, payoutId } = job.data;

    this.logger.log(
      `Processing payout for settlement=${settlementId}, store=${storeId}, amount=${amount}`,
    );

    try {
      // Create payout record if not already created
      let currentPayoutId = payoutId;
      if (!currentPayoutId) {
        const payout = await this.payoutService.createPayout(
          settlementId,
          storeId,
          amount,
        );
        if (!payout) {
          this.logger.error(
            `Failed to create payout for settlement=${settlementId}`,
          );
          return { success: false };
        }
        currentPayoutId = payout.id;
      }

      // Process the payout (calls payment gateway — currently stubbed)
      const result = await this.payoutService.processPayout(currentPayoutId);

      if (result && result.status === 'completed') {
        this.logger.log(
          `Payout completed: ${currentPayoutId}, ref=${result.paymentReference}`,
        );
        return {
          success: true,
          payoutId: currentPayoutId,
          reference: result.paymentReference ?? undefined,
        };
      }

      this.logger.warn(
        `Payout not completed: ${currentPayoutId}, status=${result?.status}`,
      );
      return { success: false, payoutId: currentPayoutId };
    } catch (error) {
      this.logger.error(
        `Payout processing failed for settlement=${settlementId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
