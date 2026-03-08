import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BroadcastService } from './services/broadcast.service';
import { NotificationTimingService } from './services/notification-timing.service';
import { ReorderService } from './services/reorder.service';
import { WeatherCampaignTriggerService } from './services/weather-campaign-trigger.service';
import { FestivalCampaignService } from './services/festival-campaign.service';
import { EventTriggerService } from './services/event-trigger.service';
import { MealSuggestionService } from './services/meal-suggestion.service';
import { ProactiveMessagingService } from './services/proactive-messaging.service';
import { CartRecoveryService } from './services/cart-recovery.service';
import { BroadcastController } from './controllers/broadcast.controller';
import { CampaignTriggerController } from './controllers/campaign-trigger.controller';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [
    HttpModule,
    SessionModule,
    forwardRef(() => require('../whatsapp/whatsapp.module').WhatsAppModule),
  ],
  controllers: [BroadcastController, CampaignTriggerController],
  providers: [
    BroadcastService,
    NotificationTimingService,
    ReorderService,
    WeatherCampaignTriggerService,
    FestivalCampaignService,
    EventTriggerService,
    MealSuggestionService,
    ProactiveMessagingService,
    CartRecoveryService,
  ],
  exports: [
    BroadcastService,
    NotificationTimingService,
    ReorderService,
    WeatherCampaignTriggerService,
    FestivalCampaignService,
    EventTriggerService,
    MealSuggestionService,
    ProactiveMessagingService,
    CartRecoveryService,
  ],
})
export class BroadcastModule {}
