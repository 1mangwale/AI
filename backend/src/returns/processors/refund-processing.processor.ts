/**
 * Refund Processing Processor
 *
 * BullMQ processor for asynchronous refund jobs:
 *
 * - process-refund: Calls RefundProcessorService to execute the refund
 *   (either via Razorpay refund or wallet credit through PHP backend).
 *
 * Retries: 3 attempts with exponential backoff (5s, 10s, 20s).
 * On final failure, the return request status reverts to 'approved'
 * so it can be manually retried by an admin.
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RefundProcessorService } from '../services/refund-processor.service';

@Processor('refund-processing')
export class RefundProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(RefundProcessingProcessor.name);

  constructor(
    private readonly refundProcessorService: RefundProcessorService,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    this.logger.log(
      `Processing job ${job.name} (id=${job.id}, attempt=${job.attemptsMade + 1})`,
    );

    try {
      switch (job.name) {
        case 'process-refund':
          return await this.handleProcessRefund(job);
        default:
          this.logger.warn(`Unknown refund job type: ${job.name}`);
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
   * Handle the process-refund job.
   *
   * Job data: { returnRequestId: string }
   */
  private async handleProcessRefund(
    job: Job<{ returnRequestId: string }>,
  ): Promise<{ success: boolean; reference?: string; error?: string }> {
    const { returnRequestId } = job.data;

    this.logger.log(`Processing refund for return request ${returnRequestId}`);

    const result =
      await this.refundProcessorService.processRefund(returnRequestId);

    if (result.success) {
      this.logger.log(
        `Refund completed for ${returnRequestId}: ref=${result.reference}`,
      );
    } else {
      this.logger.error(
        `Refund failed for ${returnRequestId}: ${result.error}`,
      );

      // If this is the last attempt, log a critical error
      if (job.attemptsMade + 1 >= (job.opts?.attempts ?? 3)) {
        this.logger.error(
          `CRITICAL: All refund attempts exhausted for return request ${returnRequestId}. ` +
            `Manual intervention required.`,
        );
      }

      // Throw to trigger BullMQ retry
      if (!result.success) {
        throw new Error(
          `Refund failed: ${result.error}`,
        );
      }
    }

    return result;
  }
}
