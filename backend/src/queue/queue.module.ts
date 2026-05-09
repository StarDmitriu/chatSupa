import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';
import { CampaignVipService } from './campaign-vip.service';
import { CampaignBullWorker } from './campaign.worker';
import { CampaignQueueMetricsController } from './campaign-queue-metrics.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { TelegramModule } from '../telegram/telegram.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { RuntimeModule } from '../runtime/runtime.module';

@Module({
  imports: [
    RuntimeModule,
    SupabaseModule,
    WhatsappModule,
    TelegramModule,
    SubscriptionsModule,
  ],
  controllers: [CampaignQueueMetricsController],
  providers: [QueueService, CampaignVipService, CampaignBullWorker],
  exports: [QueueService, CampaignVipService],
})
export class QueueModule {}
