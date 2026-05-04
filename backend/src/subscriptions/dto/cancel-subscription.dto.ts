import { IsBoolean, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class CancelSubscriptionDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  cancel?: boolean;
}
