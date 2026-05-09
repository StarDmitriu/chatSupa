import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { TelegramModule } from '../telegram/telegram.module';
import { QueueModule } from '../queue/queue.module';
import { CampaignRepeatService } from './campaign-repeat.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SubscriptionGuard } from '../subscriptions/subscription.guard';
import { RuntimeModule } from '../runtime/runtime.module';

@Module({
  imports: [
    RuntimeModule,
    SupabaseModule,
    WhatsappModule,
    TelegramModule,
    QueueModule,
    SubscriptionsModule,
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignRepeatService, SubscriptionGuard],
  exports: [CampaignsService],
})
export class CampaignsModule {}
