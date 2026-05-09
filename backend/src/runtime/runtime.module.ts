import { Module } from '@nestjs/common';
import { RuntimeCoordinationService } from './runtime-coordination.service';

@Module({
  providers: [RuntimeCoordinationService],
  exports: [RuntimeCoordinationService],
})
export class RuntimeModule {}
