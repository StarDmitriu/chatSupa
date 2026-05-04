import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { LeadsController } from './leads.controller';

@Module({
  imports: [SupabaseModule],
  controllers: [LeadsController],
})
export class LeadsModule {}
