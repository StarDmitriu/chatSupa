import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

export class CreateLeadDto {
  @IsString()
  @IsNotEmpty()
  full_name!: string;

  @IsString()
  @IsNotEmpty()
  phone!: string;

  @IsString()
  @IsOptional()
  birth_date?: string; // 'YYYY-MM-DD' или пусто

  @IsString()
  @IsNotEmpty()
  city!: string;

  @IsString()
  @IsOptional()
  telegram?: string;

  @IsBoolean()
  consent_personal!: boolean;

  @IsBoolean()
  consent_marketing!: boolean;
}
