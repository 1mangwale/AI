import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { DatabaseModule } from '../database/database.module';
import { FinanceModule } from '../finance/finance.module';
import { ReturnPolicyService } from './services/return-policy.service';
import { ReturnRequestService } from './services/return-request.service';
import { RefundProcessorService } from './services/refund-processor.service';
import { ReturnsController } from './controllers/returns.controller';
import { ReturnsAdminController } from './controllers/returns-admin.controller';
import { RefundProcessingProcessor } from './processors/refund-processing.processor';

@Module({
  imports: [
    DatabaseModule,
    HttpModule,
    FinanceModule,
    BullModule.registerQueue({ name: 'refund-processing' }),
  ],
  controllers: [ReturnsController, ReturnsAdminController],
  providers: [
    ReturnPolicyService,
    ReturnRequestService,
    RefundProcessorService,
    RefundProcessingProcessor,
  ],
  exports: [
    ReturnPolicyService,
    ReturnRequestService,
    RefundProcessorService,
  ],
})
export class ReturnsModule {}
