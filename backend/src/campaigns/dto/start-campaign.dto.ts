import {
  IsIn,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';

export class StartCampaignDto {
  @IsOptional()
  @IsIn(['wa', 'tg'])
  channel?: 'wa' | 'tg';

  @IsOptional()
  @IsString()
  timeFrom?: string;

  @IsOptional()
  @IsString()
  timeTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  betweenGroupsSecMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  betweenGroupsSecMax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  betweenTemplatesMinMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  betweenTemplatesMinMax?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  repeatEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  repeatMinMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  repeatMinMax?: number;

  /** minutes — случайный интервал repeatMinMin–repeatMinMax; next_day — следующий календарный день в timeFrom; clock_time — каждый раз в repeatClockTime (HH:mm). */
  @IsOptional()
  @IsIn(['minutes', 'next_day', 'clock_time'])
  repeatScheduleKind?: 'minutes' | 'next_day' | 'clock_time';

  @IsOptional()
  @IsString()
  repeatClockTime?: string;

  /** true (default): база сервера + коэффициент из шаблона; false: пауза только из betweenGroupsSecMin/Max. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  betweenGroupsScaleTemplate?: boolean;
}
