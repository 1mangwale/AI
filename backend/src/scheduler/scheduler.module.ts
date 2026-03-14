import { Module, forwardRef } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { AutoActionService } from './services/auto-action.service';
import { SchedulerController } from './scheduler.controller';
import { PersonalizationModule } from '../personalization/personalization.module';
import { GamificationModule } from '../gamification/gamification.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { DemandModule } from '../demand/demand.module';
import { BroadcastModule } from '../broadcast/broadcast.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { OrderFlowModule } from '../order-flow/order-flow.module';
import { SmartDiscountService } from '../demand/services/smart-discount.service';
import { LearningModule } from '../learning/learning.module';
import { NluModule } from '../nlu/nlu.module';

@Module({
  imports: [
    PersonalizationModule,
    GamificationModule,
    AnalyticsModule,
    DemandModule,
    BroadcastModule,
    LearningModule,
    NluModule,
    forwardRef(() => WhatsAppModule),
    forwardRef(() => OrderFlowModule),
  ],
  controllers: [SchedulerController],
  providers: [SchedulerService, AutoActionService, SmartDiscountService],
  exports: [SchedulerService, AutoActionService],
})
export class SchedulerModule {}
