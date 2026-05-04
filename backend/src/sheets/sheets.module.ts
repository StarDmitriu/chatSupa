import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { SheetsController } from './sheets.controller';
import { SheetsService } from './sheets.service';

@Module({
  imports: [SupabaseModule],
  controllers: [SheetsController],
  providers: [SheetsService],
  exports: [SheetsService],
})
export class SheetsModule {}
