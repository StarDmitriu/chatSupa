import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  HttpCode,
  Res,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import * as jwt from 'jsonwebtoken';
import { requireEnv } from '../config/env';
import type { Response } from 'express';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('send-code')
  @HttpCode(200)
  sendCode(@Body('phone') phone: string) {
    return this.auth.sendCode(phone);
  }

  @Post('verify-code')
  @HttpCode(200)
  async verify(
    @Body() dto: VerifyCodeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { phone, code, full_name, gender, telegram, birthday, city, ref } =
      dto;

    const result = await this.auth.verifyCode(
      phone,
      code,
      {
        full_name,
        gender,
        telegram,
        birthday,
        city,
      },
      ref,
    );

    if ((result as any)?.success && (result as any)?.token) {
      const isProd = (process.env.NODE_ENV || '').trim() === 'production';
      res.cookie('token', (result as any).token, {
        httpOnly: false,
        secure: isProd,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней
        path: '/',
      });
    }

    return result;
  }

  @Get('me')
  async me(@Headers('authorization') authHeader?: string) {
    const token = this.extractBearerToken(authHeader);
    if (!token) return { success: false, message: 'No token provided' };

    try {
      const payload = jwt.verify(token, requireEnv('JWT_SECRET')) as {
        userId: string;
        phone: string;
      };

      if (!payload?.userId) {
        return { success: false, message: 'Invalid token payload' };
      }

      const user = await this.auth.getUserById(payload.userId);
      if (!user) return { success: false, message: 'User not found' };
      const { tg_session, ...safeUser } = user;
      return { success: true, user: safeUser };
    } catch (e) {
      console.error('JWT verify error:', e);
      return { success: false, message: 'Invalid token' };
    }
  }

  @Post('update-profile')
  async updateProfile(
    @Headers('authorization') authHeader?: string,
    @Body() body?: UpdateProfileDto,
  ) {
    const token = this.extractBearerToken(authHeader);
    if (!token) return { success: false, message: 'No token provided' };

    try {
      const payload = jwt.verify(token, requireEnv('JWT_SECRET')) as {
        userId: string;
        phone: string;
      };

      if (!payload?.userId) {
        return { success: false, message: 'Invalid token payload' };
      }

      const user = await this.auth.updateProfile(payload.userId, body || {});
      const { tg_session, ...safeUser } = user;
      return { success: true, user: safeUser };
    } catch (e) {
      console.error('JWT verify error (update-profile):', e);
      return { success: false, message: 'Invalid token' };
    }
  }

  /**
   * DEV endpoint для Playwright E2E.
   * Возвращает текущий OTP-код из Supabase `otp_codes` по телефону.
   *
   * Защита:
   * - запрещено в production
   * - требуется секрет env `E2E_DEV_CODE_SECRET` в заголовке `x-e2e-secret`
   */
  @Post('dev-get-otp-code')
  @HttpCode(200)
  async devGetOtpCode(
    @Body('phone') phone: string,
    @Headers('x-e2e-secret') xE2eSecret?: string,
  ) {
    const isProd = (process.env.NODE_ENV || '').trim() === 'production';
    if (isProd) return { success: false, message: 'forbidden' };

    const expectedSecret = (process.env.E2E_DEV_CODE_SECRET || '').trim();
    if (!expectedSecret) return { success: false, message: 'missing_secret' };

    if (!xE2eSecret || String(xE2eSecret).trim() !== expectedSecret) {
      return { success: false, message: 'invalid_secret' };
    }

    const code = await this.auth.devGetOtpCode(phone);
    if (!code) return { success: false, message: 'code_not_found_or_expired' };

    return { success: true, code };
  }

  private extractBearerToken(authHeader?: string): string | null {
    if (!authHeader || typeof authHeader !== 'string') return null;

    // допускаем "Bearer <token>" в любом регистре
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length !== 2) return null;

    const [scheme, token] = parts;
    if (!/^bearer$/i.test(scheme)) return null;

    const t = String(token || '').trim();
    return t ? t : null;
  }
}
