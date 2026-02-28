import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { OSRMService } from './services/osrm.service';
import { RiderAssignmentService } from './services/rider-assignment.service';
import { DeliveryTrackingService } from './services/delivery-tracking.service';
import { RoutingConfigController } from './controllers/routing-config.controller';
import { RoutingController } from './routing.controller';
import { StoresModule } from '../stores/stores.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';

/**
 * Routing Module
 *
 * Handles distance calculation, routing, delivery time estimation,
 * rider assignment, and real-time delivery tracking.
 *
 * Services:
 * - OSRMService: Distance/duration calculation via OSRM routing engine
 * - RiderAssignmentService: Rider-to-order assignment lifecycle
 * - DeliveryTrackingService: Real-time rider location tracking & ETA
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 5,
    }),
    ConfigModule,
    DatabaseModule,
    RedisModule,
    StoresModule,
  ],
  controllers: [RoutingConfigController, RoutingController],
  providers: [OSRMService, RiderAssignmentService, DeliveryTrackingService],
  exports: [OSRMService, RiderAssignmentService, DeliveryTrackingService],
})
export class RoutingModule {}
