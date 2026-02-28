import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { DatabaseModule } from '../database/database.module';
import { CommissionService } from './services/commission.service';
import { SettlementService } from './services/settlement.service';
import { FeeCalculatorService } from './services/fee-calculator.service';
import { PayoutService } from './services/payout.service';
import { FinanceAdminController } from './controllers/finance-admin.controller';
import { SettlementProcessor } from './processors/settlement.processor';

@Module({
  imports: [
    DatabaseModule,
    HttpModule,
    BullModule.registerQueue({ name: 'settlement-processing' }),
  ],
  controllers: [FinanceAdminController],
  providers: [
    CommissionService,
    SettlementService,
    FeeCalculatorService,
    PayoutService,
    SettlementProcessor,
  ],
  exports: [
    CommissionService,
    SettlementService,
    FeeCalculatorService,
    PayoutService,
  ],
})
export class FinanceModule {}
