//backend/src/admin/admin.module.ts
import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminPasswordGuard } from './admin-password.guard';

@Module({
  imports: [SupabaseModule, CampaignsModule],
  controllers: [AdminController],
  providers: [AdminGuard, AdminPasswordGuard],
})
export class AdminModule {}
