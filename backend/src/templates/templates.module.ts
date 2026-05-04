import { Module } from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { TemplatesController } from './templates.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [SupabaseModule, TelegramModule],
  providers: [TemplatesService],
  controllers: [TemplatesController],
  exports: [TemplatesService],
})
export class TemplatesModule {}
