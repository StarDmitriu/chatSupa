import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class VerifyCodeDto {
  @IsString()
  @MinLength(10, { message: 'phone_too_short' })
  @MaxLength(32)
  phone: string;

  @IsString()
  @MinLength(4, { message: 'code_too_short' })
  @MaxLength(10)
  code: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  full_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  gender?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  telegram?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  birthday?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ref?: string;

  @IsOptional()
  @IsBoolean()
  consent_personal?: boolean;

  @IsOptional()
  @IsBoolean()
  consent_marketing?: boolean;
}
