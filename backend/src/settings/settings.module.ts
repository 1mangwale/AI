import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  // PrismaService provided by @Global() DatabaseModule — no need to register here
  exports: [SettingsService],
})
export class SettingsModule {}
