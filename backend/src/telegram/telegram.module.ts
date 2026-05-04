//backend/src/telegram/telegram.module.ts
import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { TelegramQrService } from './telegram.qr';

@Module({
  imports: [SupabaseModule],
  controllers: [TelegramController],
  providers: [TelegramService, TelegramQrService],
  exports: [TelegramService, TelegramQrService],
})
export class TelegramModule {}
