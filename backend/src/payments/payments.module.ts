import { Module, forwardRef } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { ProdamusController } from './prodamus.controller';
import { ProdamusService } from './prodamus.service';

@Module({
  imports: [SupabaseModule, forwardRef(() => CampaignsModule)],
  controllers: [ProdamusController],
  providers: [ProdamusService],
  exports: [ProdamusService],
})
export class PaymentsModule {}
