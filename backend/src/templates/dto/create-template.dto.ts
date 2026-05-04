import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  media_url?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  send_media_as_file?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  order?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  wa_speed_factor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  tg_speed_factor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  wa_between_groups_sec_min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  wa_between_groups_sec_max?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  tg_between_groups_sec_min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  tg_between_groups_sec_max?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  wa_default_send_time?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tg_default_send_time?: string;
}
