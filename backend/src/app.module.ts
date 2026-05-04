//backend/src/app.module.ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { SupabaseModule } from './supabase/supabase.module';
import { SmsService } from './sms/sms.service';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { TemplatesModule } from './templates/templates.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { QueueModule } from './queue/queue.module';
import { SheetsModule } from './sheets/sheets.module';
import { TelegramModule } from './telegram/telegram.module';
import { AdminModule } from './admin/admin.module';
import { PaymentsModule } from './payments/payments.module';
import { LeadsModule } from './leads/leads.module';

@Module({
  imports: [
    AuthModule,
    SupabaseModule,
    WhatsappModule,
    TemplatesModule,
    CampaignsModule,
    QueueModule,
    SheetsModule,
    TelegramModule,
    AdminModule,
    PaymentsModule,
    LeadsModule,
  ],
  controllers: [AppController],
  providers: [AppService, SmsService],
})
export class AppModule {}
