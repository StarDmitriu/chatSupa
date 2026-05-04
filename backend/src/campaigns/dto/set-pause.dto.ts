import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class SetPauseDto {
  @IsOptional()
  @IsIn(['wa', 'tg'])
  channel?: 'wa' | 'tg';

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  paused?: boolean;
}
