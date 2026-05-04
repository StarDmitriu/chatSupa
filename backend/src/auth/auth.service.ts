//backend/src/auth/auth.service.ts
import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as jwt from 'jsonwebtoken';
import { SmsService } from '../sms/sms.service';
import { requireEnv } from '../config/env';
import { randomBytes } from 'crypto';
import { normalizePhoneForStorage } from '../utils/phone.util';

type ProfileUpdate = {
  full_name?: string;
  gender?: string;
  telegram?: string;
  birthday?: string | null;
  city?: string | null;
  timezone?: string | null;
  gsheet_url?: string | null;
};

type OtpRow = {
  phone: string;
  code: string;
  created_at?: string | null;
  expires_at?: string | null;
  attempts?: number | null;
  last_sent_at?: string | null;
  updated_at?: string | null;
};

@Injectable()
export class AuthService {
  private supabase: SupabaseClient;

  // можно переопределить через env при желании
  private readonly OTP_TTL_MIN = Number(process.env.OTP_TTL_MINUTES || 5); // 5 минут
  private readonly OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5); // 5 попыток
  private readonly OTP_RESEND_COOLDOWN_SEC = Number(
    process.env.OTP_RESEND_COOLDOWN_SEC || 60,
  ); // 60 секунд

  /** Таймаут запросов к Supabase (при 522/сетевых сбоях запрос висит) */
  private readonly SUPABASE_TIMEOUT_MS = Number(
    process.env.SUPABASE_TIMEOUT_MS || 15000,
  );

  constructor(private readonly smsService: SmsService) {
    this.supabase = createClient(
      requireEnv('SUPABASE_URL'),
      requireEnv('SUPABASE_KEY'),
    );
  }

  // -------------------------
  // helpers
  // -------------------------

  private nowIso() {
    return new Date().toISOString();
  }

  private addMinutesIso(minutes: number) {
    return new Date(Date.now() + minutes * 60_000).toISOString();
  }

  private safeFail(message: string) {
    return { success: false, message };
  }

  /** Нормализация телефона для хранения (общая утилита). */
  private normalizePhone(input: string): string {
    return normalizePhoneForStorage(input);
  }

  // ---------- users ----------

  private async findUserByPhone(phone: string) {
    const { data, error } = await this.supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();

    if (error) {
      console.error('Supabase findUserByPhone error:', error);
      throw error;
    }

    return data;
  }

  private async createUser(phone: string) {
    const referral_code = await this.ensureUniqueReferralCode();

    const { data, error } = await this.supabase
      .from('users')
      .insert({
        phone,
        is_verified: true,
        referral_code, // ✅
      })
      .select()
      .single();

    if (error) {
      console.error('Supabase createUser error:', error);
      throw error;
    }

    return data;
  }

  private async updateLastLogin(phone: string) {
    const { data, error } = await this.supabase
      .from('users')
      .update({
        last_login: this.nowIso(),
        is_verified: true,
      })
      .eq('phone', phone)
      .select()
      .single();

    if (error) {
      console.error('Supabase updateLastLogin error:', error);
      throw error;
    }

    return data;
  }

  async getUserById(id: string) {
    const { data, error } = await this.supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('Supabase getUserById error:', error);
      throw error;
    }

    return data;
  }

  async updateProfile(userId: string, update: ProfileUpdate) {
    const {
      full_name,
      gender,
      telegram,
      birthday,
      city,
      timezone,
      gsheet_url,
    } = update;

    if (
      full_name === undefined &&
      gender === undefined &&
      telegram === undefined &&
      birthday === undefined &&
      city === undefined &&
      timezone === undefined &&
      gsheet_url === undefined
    ) {
      return await this.getUserById(userId);
    }

    const payload: Record<string, unknown> = {};
    if (full_name !== undefined) payload.full_name = full_name;
    if (gender !== undefined) payload.gender = gender;
    if (telegram !== undefined) payload.telegram = telegram;
    if (birthday !== undefined) payload.birthday = birthday || null;
    if (city !== undefined) payload.city = city || null;
    if (timezone !== undefined)
      payload.timezone = (timezone && timezone.trim()) || null;
    if (gsheet_url !== undefined)
      payload.gsheet_url = (gsheet_url && String(gsheet_url).trim()) || null;

    const { data, error } = await this.supabase
      .from('users')
      .update(payload)
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      console.error('Supabase updateProfile error:', error);
      throw error;
    }

    return data;
  }

  private generateReferralCode(): string {
    // короткий и читабельный код (10 символов)
    return randomBytes(6)
      .toString('base64url')
      .replace(/[-_]/g, '')
      .slice(0, 10);
  }

  private async ensureUniqueReferralCode(): Promise<string> {
    // 10 попыток найти уникальный код
    for (let i = 0; i < 10; i++) {
      const code = this.generateReferralCode();

      const { data, error } = await this.supabase
        .from('users')
        .select('id')
        .eq('referral_code', code)
        .maybeSingle();

      if (error) {
        console.error('Supabase check referral_code error:', error);
        throw error;
      }

      if (!data) return code;
    }

    // на крайний случай — UUID кусок
    return (Date.now().toString(36) + this.generateReferralCode()).slice(0, 12);
  }

  private async findUserByReferralCode(code: string) {
    const ref = String(code || '').trim();
    if (!ref) return null;

    const { data, error } = await this.supabase
      .from('users')
      .select('id,referral_code')
      .eq('referral_code', ref)
      .maybeSingle();

    if (error) {
      console.error('Supabase findUserByReferralCode error:', error);
      throw error;
    }

    return data;
  }

  /** Выполняет promise с таймаутом; при истечении — reject с Error('SUPABASE_TIMEOUT') */
  private withTimeout<T>(
    p: Promise<T>,
    ms: number = this.SUPABASE_TIMEOUT_MS,
  ): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('SUPABASE_TIMEOUT')), ms),
      ),
    ]);
  }

  // ---------- SEND CODE ----------

  async sendCode(phone: string) {
    const normPhone = this.normalizePhone(phone);
    if (!normPhone) return this.safeFail('phone is required');

    try {
      // 1) анти-спам: смотрим last_sent_at (с таймаутом — при 522 Supabase запрос висит)
      const selectResult = (await this.withTimeout(
        Promise.resolve(
          this.supabase
            .from('otp_codes')
            .select('phone, last_sent_at')
            .eq('phone', normPhone)
            .maybeSingle(),
        ),
      )) as { data: any; error: any };
      const existing = selectResult.data;
      const exErr = selectResult.error;

      if (exErr) {
        console.error('Supabase select otp_codes (sendCode) error:', exErr);
        return this.safeFail('supabase_error');
      }

      if (existing?.last_sent_at) {
        const last = new Date(existing.last_sent_at).getTime();
        const diffSec = Math.floor((Date.now() - last) / 1000);
        if (Number.isFinite(last) && diffSec < this.OTP_RESEND_COOLDOWN_SEC) {
          return this.safeFail('too_many_requests');
        }
      }

      // 2) генерим код
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const now = this.nowIso();

      // 3) сохраняем код с TTL и attempts=0 (с таймаутом)
      const upsertResult = (await this.withTimeout(
        Promise.resolve(
          this.supabase.from('otp_codes').upsert(
            {
              phone: normPhone,
              code,
              attempts: 0,
              expires_at: this.addMinutesIso(this.OTP_TTL_MIN),
              last_sent_at: now,
              updated_at: now,
            },
            { onConflict: 'phone' },
          ),
        ),
      )) as { error: any };
      const upErr = upsertResult.error;

      if (upErr) {
        console.error('Supabase upsert otp_codes error:', upErr);
        return this.safeFail('supabase_error');
      }

      // 4) отправляем SMS
      const text = `Ваш код подтверждения: ${code}`;
      const smsResult = await this.smsService.sendSms(normPhone, text);

      if (!smsResult?.success) {
        console.warn('SMS send failed', smsResult);
        return this.safeFail('sms_send_failed');
      }

      return { success: true };
    } catch (e: any) {
      if (e?.message === 'SUPABASE_TIMEOUT') {
        console.warn('Supabase timeout in sendCode');
        return this.safeFail('supabase_timeout');
      }
      throw e;
    }
  }

  // ---------- VERIFY CODE + LOGIN/REGISTER ----------

  async verifyCode(
    phone: string,
    code: string,
    profile?: ProfileUpdate,
    ref?: string,
  ) {
    const normPhone = this.normalizePhone(phone);
    const normCode = String(code || '').trim();

    if (!normPhone || !normCode) {
      return this.safeFail('phone and code are required');
    }

    const { data, error } = await this.supabase
      .from('otp_codes')
      .select('phone, code, expires_at, attempts')
      .eq('phone', normPhone)
      .maybeSingle();

    if (error) {
      console.error('Supabase select otp_codes (verifyCode) error:', error);
      return this.safeFail('supabase_select_error');
    }

    const row = data as OtpRow | null;
    if (!row) {
      return this.safeFail('invalid_or_expired_code');
    }

    const attempts = Number.isFinite(row.attempts as any)
      ? Number(row.attempts)
      : 0;

    if (attempts >= this.OTP_MAX_ATTEMPTS) {
      return this.safeFail('too_many_attempts');
    }

    if (row.expires_at) {
      const exp = new Date(row.expires_at).getTime();
      if (Number.isFinite(exp) && exp < Date.now()) {
        return this.safeFail('invalid_or_expired_code');
      }
    }

    if (String(row.code || '').trim() !== normCode) {
      await this.supabase
        .from('otp_codes')
        .update({ attempts: attempts + 1, updated_at: this.nowIso() })
        .eq('phone', normPhone);

      return this.safeFail('invalid_or_expired_code');
    }

    // ✅ успех — удаляем OTP сразу
    await this.supabase.from('otp_codes').delete().eq('phone', normPhone);

    // --- логика логина/регистрации ---
    let user = await this.findUserByPhone(normPhone);

    if (!user) {
      if (
        profile &&
        (profile.full_name ||
          profile.gender ||
          profile.telegram ||
          profile.birthday)
      ) {
        user = await this.createUser(normPhone);
        user = await this.updateProfile(user.id, profile);
      } else {
        return this.safeFail('user_not_found');
      }
    } else {
      user = await this.updateLastLogin(normPhone);

      if (profile) {
        user = await this.updateProfile(user.id, profile);
      }
    }

    // --- рефералка (после того как user создан/найден) ---
    try {
      const refCode = String(ref || '').trim();

      if (refCode) {
        const referrer = await this.findUserByReferralCode(refCode);

        // нельзя сам себя
        if (referrer?.id && referrer.id !== user.id) {
          // привязываем только если ещё не привязан
          if (!user.referred_by_user_id) {
            // 1) обновляем user.referred_by_user_id
            const { data: updatedUser, error: upErr } = await this.supabase
              .from('users')
              .update({ referred_by_user_id: referrer.id })
              .eq('id', user.id)
              .select()
              .maybeSingle();

            if (upErr) {
              console.warn('referred_by_user_id update failed:', upErr);
            } else if (updatedUser) {
              user = updatedUser; // ✅ чтобы /auth/me видел поле
            }

            // 2) записываем referrals (если дубль — таблица сама не даст)
            const { error: refErr } = await this.supabase
              .from('referrals')
              .insert({
                referrer_user_id: referrer.id,
                referred_user_id: user.id,
                status: 'registered',
                reward_type: 'days',
                reward_value: 7, // награда по ТЗ: неделя
              });

            if (refErr) {
              // если уже есть запись — это нормально (unique ограничение)
              console.warn(
                'referrals insert failed:',
                refErr?.message || refErr,
              );
            }
          }
        }
      }
    } catch (e) {
      console.warn('referral logic skipped due to error:', e);
    }

    const payload = { userId: user.id, phone: user.phone };

    const token = jwt.sign(payload, requireEnv('JWT_SECRET'), {
      expiresIn: '30d', // месяц — чтобы не выкидывало из кабинета при редких заходах (списание подписки)
    });

    return { success: true, token, user };
  }

  // -------------------------
  // E2E / DEV helpers
  // -------------------------
  /**
   * Dev helper для Playwright E2E.
   * Возвращает текущий (не истёкший) OTP-код из Supabase `otp_codes`.
   *
   * Важно: контроллер дополнительно запрещает использование в production.
   */
  async devGetOtpCode(phone: string): Promise<string | null> {
    const normPhone = this.normalizePhone(phone);
    if (!normPhone) return null;

    const { data, error } = await this.supabase
      .from('otp_codes')
      .select('code, expires_at')
      .eq('phone', normPhone)
      .maybeSingle();

    if (error) {
      console.error('Supabase select otp_codes (devGetOtpCode) error:', error);
      return null;
    }

    const row = data as {
      code?: string | number;
      expires_at?: string | null;
    } | null;
    if (!row) return null;

    if (row.expires_at) {
      const exp = new Date(row.expires_at).getTime();
      if (Number.isFinite(exp) && exp < Date.now()) return null;
    }

    const code = String(row.code ?? '').trim();
    return code && code.length >= 4 ? code : null;
  }
}
