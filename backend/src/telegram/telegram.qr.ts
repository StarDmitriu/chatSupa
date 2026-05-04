import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { TelegramService } from './telegram.service';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import { Raw } from 'telegram/events';
import { computeCheck } from 'telegram/Password';
import { Buffer } from 'buffer';

export type TgQrStatus =
  | 'not_connected'
  | 'pending_qr'
  | 'awaiting_password'
  | 'connected'
  | 'error';

type PendingQr = {
  client: TelegramClient;
  createdAt: number;

  status: TgQrStatus;
  lastError?: string;

  // QR
  qrUrl?: string; // tg://login?token=...
  expiresAt?: number; // ms epoch
  lastExportAt?: number; // ms epoch
  exporting?: Promise<void>;

  // служебное
  handlerAttached?: boolean;
  destroyed?: boolean;
};

function base64UrlEncode(buf: Buffer) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

@Injectable()
export class TelegramQrService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramQrService.name);

  private pending = new Map<string, PendingQr>();
  private locks = new Map<string, Promise<void>>();

  // Проверяем реальность `tg_session` не на каждом полле (TelegramQrConnect опрашивает часто),
  // а с небольшим TTL, чтобы не поднимать коннект к Telegram на каждый запрос.
  private tgStatusCache = new Map<string, { status: TgQrStatus; expiresAt: number }>();
  private readonly TG_STATUS_VALIDATE_TTL_MS = 30_000;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly telegramService: TelegramService,
  ) {}

  // ---------------- basics ----------------

  private apiId(): number {
    const v = Number(process.env.TG_API_ID);
    if (!Number.isFinite(v)) throw new Error('TG_API_ID is not set');
    return v;
  }

  private apiHash(): string {
    const v = String(process.env.TG_API_HASH || '').trim();
    if (!v) throw new Error('TG_API_HASH is not set');
    return v;
  }

  private newClient(sessionStr = '') {
    return new TelegramClient(
      new StringSession(sessionStr),
      this.apiId(),
      this.apiHash(),
      {
        connectionRetries: 3,
        retryDelay: 1000,
      } as any,
    );
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();

    let release!: () => void;
    const cur = new Promise<void>((r) => (release = r));
    this.locks.set(
      key,
      prev.then(() => cur),
    );

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === cur) this.locks.delete(key);
    }
  }

  async onModuleDestroy() {
    for (const p of this.pending.values()) {
      p.destroyed = true;
      await p.client.disconnect().catch(() => undefined);
    }
    this.pending.clear();
  }

  // ---------------- public API ----------------

  async start(userId: string) {
    return this.withLock(userId, async () => {
      // если уже есть сохранённая сессия — подключено
      const supabase = this.supabaseService.getClient();
      const { data: user, error } = await supabase
        .from('users')
        .select('id, tg_session')
        .eq('id', userId)
        .maybeSingle();

      if (!error && (user as any)?.tg_session) {
        return { success: true, status: 'connected' as TgQrStatus };
      }

      // если уже есть pending — просто обновим QR при необходимости
      const existing = this.pending.get(userId);
      if (existing && Date.now() - existing.createdAt < 5 * 60_000) {
        await this.ensureQrUpToDate(userId, existing).catch((e: any) => {
          existing.status = 'error';
          existing.lastError = String(e?.message ?? e);
        });

        return {
          success: true,
          status: existing.status,
          qr: existing.qrUrl ?? null,
          expiresAt: existing.expiresAt ?? null,
          lastError: existing.lastError ?? null,
        };
      }

      // новый клиент
      const client = this.newClient('');
      await client.connect();

      const p: PendingQr = {
        client,
        createdAt: Date.now(),
        status: 'pending_qr',
      };

      this.pending.set(userId, p);

      this.attachUpdateHandler(userId, p);

      await this.ensureQrUpToDate(userId, p).catch((e: any) => {
        p.status = 'error';
        p.lastError = String(e?.message ?? e);
      });

      return {
        success: true,
        status: p.status,
        qr: p.qrUrl ?? null,
        expiresAt: p.expiresAt ?? null,
        lastError: p.lastError ?? null,
      };
    });
  }

  async status(userId: string) {
    return this.withLock(userId, async () => {
      const supabase = this.supabaseService.getClient();
      const { data: user, error } = await supabase
        .from('users')
        .select('id, tg_session')
        .eq('id', userId)
        .maybeSingle();

      if (!error && (user as any)?.tg_session) {
        const cached = this.tgStatusCache.get(userId);
        if (cached && cached.expiresAt > Date.now()) {
          return { success: true, status: cached.status };
        }

        // Валидация через TelegramService: один клиент и один lock на userId,
        // иначе второй connect с тем же tg_session даёт AUTH_KEY_DUPLICATED.
        const sessionStr = String((user as any).tg_session);
        try {
          const v = await this.telegramService.validateSavedSessionForQrPoll(
            userId,
            sessionStr,
          );

          if (v.connected) {
            this.tgStatusCache.set(userId, {
              status: 'connected',
              expiresAt: Date.now() + this.TG_STATUS_VALIDATE_TTL_MS,
            });
            return { success: true, status: 'connected' as TgQrStatus };
          }

          if (v.errorDetail) {
            this.logger.warn(
              `[TG-QR] status validate not connected userId=${userId}: ${v.errorDetail}`,
            );
          }

          this.tgStatusCache.set(userId, {
            status: 'not_connected',
            expiresAt: Date.now() + this.TG_STATUS_VALIDATE_TTL_MS,
          });
          return { success: true, status: 'not_connected' as TgQrStatus };
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          this.logger.warn(`[TG-QR] status validate failed userId=${userId}: ${msg}`);

          this.tgStatusCache.set(userId, {
            status: 'not_connected',
            expiresAt: Date.now() + this.TG_STATUS_VALIDATE_TTL_MS,
          });

          return { success: true, status: 'not_connected' as TgQrStatus };
        }
      }

      const p = this.pending.get(userId);
      if (!p) return { success: true, status: 'not_connected' as TgQrStatus };

      if (p.status === 'awaiting_password') {
        return {
          success: true,
          status: 'awaiting_password' as TgQrStatus,
          lastError: p.lastError ?? null,
        };
      }

      // QR обновляем редко и аккуратно
      await this.ensureQrUpToDate(userId, p).catch((e: any) => {
        p.status = 'error';
        p.lastError = String(e?.message ?? e);
      });

      // проверим, не залогинились ли уже
      const me = await p.client.getMe().catch((e: any) => {
        const msg = String(e?.message ?? e);
        if (msg.includes('SESSION_PASSWORD_NEEDED')) {
          p.status = 'awaiting_password';
          p.lastError = '2fa_required';
        }
        return null;
      });

      if (me) {
        await this.saveAndFinish(userId, p);
        return { success: true, status: 'connected' as TgQrStatus };
      }

      return {
        success: true,
        status: p.status,
        qr: p.qrUrl ?? null,
        expiresAt: p.expiresAt ?? null,
        lastError: p.lastError ?? null,
      };
    });
  }

  async confirmPassword(userId: string, password: string) {
    return this.withLock(userId, async () => {
      const p = this.pending.get(userId);
      if (!p) return { success: false, message: 'qr_auth_not_started' };

      const pass = String(password || '').trim();
      if (!pass) return { success: false, message: 'password_required' };

      try {
        // 1) параметры пароля
        const pwd: any = await p.client.invoke(new Api.account.GetPassword());

        // 2) вычисляем check
        const check = await computeCheck(pwd, pass);

        // 3) подтверждаем пароль
        await p.client.invoke(new Api.auth.CheckPassword({ password: check }));

        // 4) проверим вход
        const me = await p.client.getMe().catch(() => null);
        if (!me) {
          p.status = 'awaiting_password';
          p.lastError = '2fa_failed_try_again';
          return { success: true, status: p.status, lastError: p.lastError };
        }

        await this.saveAndFinish(userId, p);
        return { success: true, status: 'connected' as TgQrStatus };
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        p.status = 'awaiting_password';
        p.lastError = msg.includes('PASSWORD_HASH_INVALID')
          ? 'invalid_2fa_password'
          : msg;
        return { success: false, message: p.lastError };
      }
    });
  }

  /** Сбросить незавершённую попытку QR (pending) без изменения БД. Позволяет начать заново. */
  async abort(userId: string) {
    return this.withLock(userId, async () => {
      const p = this.pending.get(userId);
      if (p) {
        p.destroyed = true;
        await p.client.disconnect().catch(() => undefined);
        this.pending.delete(userId);
        this.logger.log(`[TG-QR] aborted pending for user=${userId}`);
      }
      return { success: true };
    });
  }

  async disconnect(userId: string) {
    return this.withLock(userId, async () => {
      const p = this.pending.get(userId);
      if (p) {
        p.destroyed = true;
        await p.client.disconnect().catch(() => undefined);
        this.pending.delete(userId);
      }

      const supabase = this.supabaseService.getClient();
      await supabase
        .from('users')
        .update({ tg_session: null })
        .eq('id', userId);

      return { success: true };
    });
  }

  // ---------------- internal ----------------

  private attachUpdateHandler(userId: string, p: PendingQr) {
    if (p.handlerAttached) return;
    p.handlerAttached = true;

    p.client.addEventHandler(async (ev: any) => {
      if (p.destroyed) return;

      const upd = ev?.update;
      const ctor = upd?.className || upd?._ || upd?.constructor?.name;

      if (ctor !== 'UpdateLoginToken') return;

      this.logger.log(`[TG-QR] UpdateLoginToken for user=${userId}`);

      // После принятия на телефоне — надо завершить логин:
      // делаем ExportLoginToken ещё раз и обрабатываем результат (success / migrate / 2fa)
      try {
        const res = await this.exportTokenSmart(p);
        const rctor =
          res?.className || res?._ || res?.constructor?.name || 'unknown';
        this.logger.log(`[TG-QR] export(after accept) ctor=${rctor}`);

        // успех
        if (rctor === 'auth.LoginTokenSuccess' || res?.authorization) {
          const me = await p.client.getMe().catch((e: any) => {
            const msg = String(e?.message ?? e);
            if (msg.includes('SESSION_PASSWORD_NEEDED')) {
              p.status = 'awaiting_password';
              p.lastError = '2fa_required';
            }
            return null;
          });

          if (me) {
            await this.saveAndFinish(userId, p);
          }
          return;
        }

        // иногда после accept может вернуться обычный LoginToken — просто обновим QR (редко)
        if (res?.token && res?.expires) {
          const b64 = base64UrlEncode(Buffer.from(res.token));
          p.qrUrl = `tg://login?token=${b64}`;
          p.expiresAt = Number(res.expires) * 1000; // !!! ms
          p.status = 'pending_qr';
          p.lastError = undefined;
          this.logger.log(
            `[TG-QR] QR emitted for userId=${userId}, urlLength=${p.qrUrl?.length ?? 0}`,
          );
          return;
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        this.logger.warn(`[TG-QR] after accept failed: ${msg}`);

        if (msg.includes('SESSION_PASSWORD_NEEDED')) {
          p.status = 'awaiting_password';
          p.lastError = '2fa_required';
          return;
        }

        p.status = 'error';
        p.lastError = msg;
      }
    }, new Raw({}));
  }

  private async saveAndFinish(userId: string, p: PendingQr) {
    const sessionStr = (p.client.session as any).save() as string;

    const supabase = this.supabaseService.getClient();
    await supabase
      .from('users')
      .update({ tg_session: sessionStr })
      .eq('id', userId);

    p.destroyed = true;
    await p.client.disconnect().catch(() => undefined);
    this.pending.delete(userId);

    this.logger.log(`[TG-QR] saved session & finished for user=${userId}`);
  }

  private async ensureQrUpToDate(userId: string, p: PendingQr) {
    if (p.status === 'awaiting_password' || p.status === 'connected') return;

    if (p.exporting) {
      await p.exporting;
      return;
    }

    const now = Date.now();

    // ВАЖНО: не обновляем слишком часто, иначе пользователь сканирует старый QR.
    // QR живёт ~30 секунд. Обновляем только когда:
    // - ещё нет qr
    // - до истечения осталось < 8 сек
    // - или давно не обновляли (> 15 сек) (на случай подвисаний)
    const shouldRefresh =
      !p.qrUrl ||
      !p.expiresAt ||
      now > p.expiresAt - 8000 ||
      !p.lastExportAt ||
      now - p.lastExportAt > 15_000;

    if (!shouldRefresh) return;

    p.exporting = (async () => {
      p.lastExportAt = Date.now();

      const res = await this.exportTokenSmart(p);
      const ctor =
        res?.className || res?._ || res?.constructor?.name || 'unknown';

      this.logger.log(
        `[TG-QR] export ctor=${ctor} expires=${res?.expires ?? 'n/a'}`,
      );

      if (ctor === 'auth.LoginTokenSuccess' || res?.authorization) {
        p.status = 'connected';
        p.lastError = undefined;
        return;
      }

      if (res?.token && res?.expires) {
        const b64 = base64UrlEncode(Buffer.from(res.token));
        p.qrUrl = `tg://login?token=${b64}`;
        p.expiresAt = Number(res.expires) * 1000; // !!! ms
        p.status = 'pending_qr';
        p.lastError = undefined;
        this.logger.log(
          `[TG-QR] QR emitted for userId=${userId}, urlLength=${p.qrUrl?.length ?? 0}`,
        );
        return;
      }

      p.status = 'error';
      p.lastError = `unexpected_export_login_token_response:${ctor}`;
    })().finally(() => {
      p.exporting = undefined;
    });

    await p.exporting;
  }

  // Делает ExportLoginToken, а если нужно — правильно обрабатывает migrateTo:
  // switch DC + ImportLoginToken (на нужном DC)
  private async exportTokenSmart(p: PendingQr): Promise<any> {
    const doExport = async () => {
      return p.client.invoke(
        new Api.auth.ExportLoginToken({
          apiId: this.apiId(),
          apiHash: this.apiHash(),
          exceptIds: [],
        }),
      );
    };

    const res: any = await doExport();
    const ctor =
      res?.className || res?._ || res?.constructor?.name || 'unknown';

    // обычный кейс
    if (ctor === 'auth.LoginToken' || (res?.token && res?.expires)) return res;

    // migrateTo: надо на нужном DC сделать ImportLoginToken
    if ((ctor === 'auth.LoginTokenMigrateTo' || res?.dcId) && res?.token) {
      const dcId = Number(res?.dcId);
      const token = Buffer.from(res.token);

      this.logger.warn(
        `[TG-QR] migrateTo dcId=${dcId}, switching & importing...`,
      );

      await this.switchClientDc(p, dcId);

      // ВАЖНО: ImportLoginToken должен вызываться на правильном DC
      const imported: any = await p.client.invoke(
        new Api.auth.ImportLoginToken({ token }),
      );

      return imported;
    }

    return res;
  }

  // Переключаем DC корректно:
  // - берём ip/port из help.getConfig
  // - создаём новый клиент и делаем session.setDC(dcId, ip, port)
  private async switchClientDc(p: PendingQr, dcId: number) {
    const cfg: any = await p.client.invoke(new Api.help.GetConfig());
    const opts: any[] = Array.isArray(cfg?.dcOptions) ? cfg.dcOptions : [];

    const filtered = opts.filter((o) => Number(o?.id) === Number(dcId));
    const pick =
      filtered.find((o) => !o.ipv6 && !o.mediaOnly && Number(o.port) === 443) ||
      filtered.find((o) => !o.ipv6 && !o.mediaOnly) ||
      filtered[0];

    if (!pick?.ipAddress || !pick?.port) {
      throw new Error(`dc_option_not_found_for_${dcId}`);
    }

    const ip = String(pick.ipAddress);
    const port = Number(pick.port);

    this.logger.warn(`[TG-QR] switching DC id=${dcId} ip=${ip} port=${port}`);

    const newClient = this.newClient('');
    try {
      (newClient.session as any).setDC?.(dcId, ip, port);
    } catch {
      // если вдруг setDC недоступен — тогда оставим как есть (но обычно он есть)
    }

    await newClient.connect();

    // отключаем старый
    try {
      await p.client.disconnect().catch(() => undefined);
    } catch {}

    p.client = newClient;

    // после смены клиента — снова повесим update handler (иначе UpdateLoginToken может прийти в “новый”)
    p.handlerAttached = false;
    this.attachUpdateHandler('__reused__', p);
  }
}
