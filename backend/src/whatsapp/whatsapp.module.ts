// backend/src/whatsapp/whatsapp.module.ts
import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';

@Module({
  imports: [RuntimeModule],
  providers: [WhatsappService],
  controllers: [WhatsappController],
  exports: [WhatsappService],
})
export class WhatsappModule {}
