// backend/src/telegram/telegram.service.ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SupabaseService } from '../supabase/supabase.service';
import {
  normalizePhoneE164,
  normalizePhoneForStorage,
} from '../utils/phone.util';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import { CustomFile } from 'telegram/client/uploads';
import { applyTelegramGroupsTgPhoneScope } from './telegram-groups-phone-scope';
import { Buffer } from 'buffer';
import bigInt from 'big-integer';
import {
  RuntimeCoordinationService,
  type MessengerChannel,
} from '../runtime/runtime-coordination.service';
import {
  runtimeCapabilitiesLabel,
  runtimeHasCapability,
} from '../runtime/runtime-role';

type TgStatus =
  | 'not_connected'
  | 'awaiting_code'
  | 'awaiting_password'
  | 'connected'
  | 'error';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: any) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SEND_INTERVAL_KEYS = new Set([
  '2-5m',
  '5-15m',
  '15-30m',
  '30-60m',
  '1-2h',
  '2-4h',
  '6h',
  '6-12h',
  '12h',
  '24h',
]);

function normalizeSendInterval(v: any): string | null {
  const s = String(v || '').trim();
  if (!s) return null;
  return SEND_INTERVAL_KEYS.has(s) ? s : null;
}

type PendingAuth = {
  client: TelegramClient;
  phone: string;
  createdAt: number;
  status: TgStatus;
  lastError?: string;

  phoneCode: Deferred<string>;
  password: Deferred<string>;
  startPromise: Promise<void>;

  cooldownUntil?: number; // timestamp ms
};

function isProbablyVideo(contentType: string, url: string) {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('video/')) return true;
  const u = (url || '').toLowerCase().split('?')[0];
  return (
    u.endsWith('.mp4') ||
    u.endsWith('.mov') ||
    u.endsWith('.webm') ||
    u.endsWith('.mkv') ||
    u.endsWith('.avi') ||
    u.endsWith('.flv') ||
    u.endsWith('.wmv') ||
    u.endsWith('.m4v') ||
    u.endsWith('.3gp')
  );
}

function isProbablyImage(contentType: string, url: string) {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return true;
  const u = (url || '').toLowerCase().split('?')[0];
  return (
    u.endsWith('.jpg') ||
    u.endsWith('.jpeg') ||
    u.endsWith('.png') ||
    u.endsWith('.webp') ||
    u.endsWith('.gif') ||
    u.endsWith('.bmp') ||
    u.endsWith('.svg') ||
    u.endsWith('.ico') ||
    u.endsWith('.tiff') ||
    u.endsWith('.tif') ||
    u.endsWith('.heic') ||
    u.endsWith('.heif')
  );
}

function isProbablyAudio(contentType: string, url: string) {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('audio/')) return true;
  const u = (url || '').toLowerCase().split('?')[0];
  return (
    u.endsWith('.mp3') ||
    u.endsWith('.m4a') ||
    u.endsWith('.ogg') ||
    u.endsWith('.wav') ||
    u.endsWith('.opus') ||
    u.endsWith('.aac') ||
    u.endsWith('.flac') ||
    u.endsWith('.wma') ||
    u.endsWith('.amr')
  );
}

/**
 * Голый Buffer в GramJS почти всегда уходит как «документ» без атрибутов видео/фото.
 * Нужно имя с расширением (.mp4, .jpg, …) — через CustomFile или путь.
 */
function inferTelegramUploadName(
  mediaUrl: string,
  contentType: string,
  kind: 'video' | 'image' | 'audio' | 'generic',
): string {
  const pathPart = (mediaUrl || '').split('?')[0].split('/').pop() || '';
  if (
    pathPart.includes('.') &&
    /^[a-zA-Z0-9._-]+\.[a-zA-Z0-9]{2,8}$/.test(pathPart)
  ) {
    return pathPart.slice(0, 200);
  }
  const ct = (contentType || '').toLowerCase();
  if (kind === 'video') {
    if (ct.includes('webm')) return 'video.webm';
    if (ct.includes('quicktime')) return 'video.mov';
    if (ct.includes('x-matroska') || ct.includes('mkv')) return 'video.mkv';
    return 'video.mp4';
  }
  if (kind === 'image') {
    if (ct.includes('png')) return 'photo.png';
    if (ct.includes('webp')) return 'photo.webp';
    if (ct.includes('gif')) return 'photo.gif';
    return 'photo.jpg';
  }
  if (kind === 'audio') {
    if (ct.includes('ogg')) return 'audio.ogg';
    if (ct.includes('mpeg') || ct.includes('mp3')) return 'audio.mp3';
    return 'audio.m4a';
  }
  if (ct.includes('pdf')) return 'file.pdf';
  return 'file.bin';
}

function bufferAsTelegramUpload(
  buf: Buffer,
  mediaUrl: string,
  contentType: string,
  kind: 'video' | 'image' | 'audio' | 'generic',
): CustomFile {
  const name = inferTelegramUploadName(mediaUrl, contentType, kind);
  return new CustomFile(name, buf.length, '', buf);
}

function videoSupportsStreaming(filename: string): boolean {
  const f = filename.toLowerCase();
  return f.endsWith('.mp4') || f.endsWith('.mov');
}

function extractTelegramGroupTitle(...values: any[]): string | null {
  const seen = new Set<any>();
  const queue = [...values];

  while (queue.length > 0) {
    const value = queue.shift();
    if (value == null || seen.has(value)) continue;
    seen.add(value);

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value !== 'object') continue;

    const nestedCandidates = [
      (value as any).title,
      (value as any).name,
      (value as any).displayName,
      (value as any).formattedTitle,
      (value as any).formattedName,
      (value as any).chat,
      (value as any).entity,
      (value as any).dialog,
    ];

    for (const candidate of nestedCandidates) {
      if (candidate != null) queue.push(candidate);
    }
  }

  return null;
}

/** Конвертирует разметку шаблона в Telegram HTML: *жирный* _курсив_ ~подчёркнутый~ ~~зачёркнутый~~ `код`. */
function templateMarkdownToTelegramHtml(text: string): string {
  if (!text) return '';

  // Нормализуем переводы строк, чтобы \r\n и \r не ломали разметку
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  let s = normalized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Порядок важен: ***, **, *, _, затем ~~ (зачёркивание), затем ~ (подчёркивание), затем `
  s = s
    .replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
    .replace(/\*([\s\S]+?)\*/g, '<b>$1</b>') // одиночные *...* тоже считаем жирным
    .replace(/_([\s\S]+?)_/g, '<i>$1</i>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>')
    .replace(/~([\s\S]+?)~/g, '<u>$1</u>')
    .replace(/`([\s\S]+?)`/g, '<code>$1</code>');
  return s;
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(
        `tg_media_fetch_failed_${res.status}: ${txt.slice(0, 140)}`,
      );
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);

    // если это html/ошибка — обычно contentType text/html
    if (contentType.includes('text/html') || buf.length < 800) {
      throw new Error(
        `tg_media_not_a_file contentType=${contentType} size=${buf.length}`,
      );
    }

    return { buf, contentType };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('tg_media_fetch_timeout');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

@Injectable()
export class TelegramService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly channel: MessengerChannel = 'tg';
  private readonly sessionLeaseTtlMs = Math.max(
    Number(process.env.TG_SESSION_LEASE_TTL_MS || 45_000) || 45_000,
    15_000,
  );
  private readonly sessionLeaseRenewEveryMs = Math.max(
    Number(process.env.TG_SESSION_LEASE_RENEW_MS || 15_000) || 15_000,
    5_000,
  );
  private readonly sessionIdleReleaseMs = Math.max(
    Number(process.env.TG_SESSION_IDLE_RELEASE_MS || 5 * 60_000) ||
      5 * 60_000,
    60_000,
  );
  private readonly pendingAuthIdleReleaseMs = Math.max(
    Number(process.env.TG_AUTH_PENDING_IDLE_RELEASE_MS || 15 * 60_000) ||
      15 * 60_000,
    120_000,
  );

  private sessions = new Map<string, TelegramClient>(); // userId -> connected client
  private pending = new Map<string, PendingAuth>(); // userId -> auth flow
  private sessionLeaseTimers = new Map<string, NodeJS.Timeout>();
  private sessionLeaseTouchedAt = new Map<string, number>();

  /** Кэш счётчиков списка: ключ = userId + selected + tgPhone; rowCount — строки БД (пагинация), chatCount — уникальные чаты */
  private groupsCountCache = new Map<
    string,
    { rowCount: number; chatCount: number; timestamp: number }
  >();
  private readonly CACHE_TTL_MS = 30_000; // 30 секунд кэш
  private tgMetricsColumnsAvailable: boolean | null = null;
  private activeTgAccountCache = new Map<
    string,
    { key: string | null; expiresAt: number }
  >();
  private readonly ACTIVE_TG_ACCOUNT_CACHE_TTL_MS = 30_000;
  private readonly tgAccountPhoneBackfillDone = new Set<string>();

  // --- lock per userId (prevents AUTH_KEY_DUPLICATED races) ---
  private locks = new Map<string, Promise<void>>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly moduleRef: ModuleRef,
    private readonly runtimeCoordinationService: RuntimeCoordinationService,
  ) {}

  private stopSessionLeaseTimer(userId: string) {
    const timer = this.sessionLeaseTimers.get(userId);
    if (timer) {
      clearInterval(timer);
      this.sessionLeaseTimers.delete(userId);
    }
    this.sessionLeaseTouchedAt.delete(userId);
  }

  private touchSessionLease(userId: string) {
    this.sessionLeaseTouchedAt.set(userId, Date.now());
  }

  private async releaseConnectedSessionOwnership(
    userId: string,
    reason: string,
  ): Promise<void> {
    const client = this.sessions.get(userId);
    this.sessions.delete(userId);
    this.stopSessionLeaseTimer(userId);
    if (client) {
      await client.disconnect().catch(() => undefined);
    }
    await this.runtimeCoordinationService
      .releaseMessengerLease(this.channel, userId)
      .catch(() => undefined);
    this.logger.log(`[TG lease] released owner userId=${userId} reason=${reason}`);
  }

  private async publishRuntimeState(params: {
    userId: string;
    status: TgStatus;
    lastError?: string | null;
    cooldownSeconds?: number | null;
  }) {
    await this.runtimeCoordinationService
      .writeMessengerState(this.channel, params.userId, {
        success: true,
        status: params.status,
        lastError: params.lastError ?? null,
        cooldownSeconds: params.cooldownSeconds ?? null,
        runtimeRole: runtimeCapabilitiesLabel(),
      })
      .catch(() => undefined);
  }

  private async ensureSessionLease(
    userId: string,
    reason: string,
  ): Promise<boolean> {
    const lease = await this.runtimeCoordinationService.acquireMessengerLease({
      channel: this.channel,
      userId,
      ttlMs: this.sessionLeaseTtlMs,
    });
    if (!lease.acquired) {
      this.logger.warn(
        `[TG lease] busy userId=${userId} reason=${reason} owner=${lease.ownerInstanceId ?? 'unknown'}`,
      );
      return false;
    }

    this.touchSessionLease(userId);
    if (!this.sessionLeaseTimers.has(userId)) {
      const timer = setInterval(() => {
        const client = this.sessions.get(userId);
        const pending = this.pending.get(userId);
        const touchedAt = this.sessionLeaseTouchedAt.get(userId) ?? 0;
        const idleForMs = Date.now() - touchedAt;

        if (!client && !pending) {
          this.stopSessionLeaseTimer(userId);
          void this.runtimeCoordinationService
            .releaseMessengerLease(this.channel, userId)
            .catch(() => undefined);
          return;
        }

        if (idleForMs >= this.pendingAuthIdleReleaseMs && pending) {
          this.logger.log(
            `[TG lease] idle pending-auth release userId=${userId} idleMs=${idleForMs}`,
          );
          this.stopSessionLeaseTimer(userId);
          void pending.client.disconnect().catch(() => undefined);
          this.pending.delete(userId);
          void this.publishRuntimeState({
            userId,
            status: 'not_connected',
          });
          void this.runtimeCoordinationService
            .releaseMessengerLease(this.channel, userId)
            .catch(() => undefined);
          return;
        }

        if (idleForMs >= this.sessionIdleReleaseMs && client) {
          this.logger.log(
            `[TG lease] idle release userId=${userId} idleMs=${idleForMs}`,
          );
          this.stopSessionLeaseTimer(userId);
          void client.disconnect().catch(() => undefined);
          this.sessions.delete(userId);
          // Idle release only frees the socket. The saved TG session is still valid
          // and can be re-opened by the next send, so do not poison shared status.
          void this.publishRuntimeState({
            userId,
            status: 'connected',
          });
          void this.runtimeCoordinationService
            .releaseMessengerLease(this.channel, userId)
            .catch(() => undefined);
          return;
        }

        void this.runtimeCoordinationService
          .acquireMessengerLease({
            channel: this.channel,
            userId,
            ttlMs: this.sessionLeaseTtlMs,
          })
          .catch(() => undefined);
      }, this.sessionLeaseRenewEveryMs);
      this.sessionLeaseTimers.set(userId, timer);
    }

    return true;
  }

  /**
   * После успешного TG-соединения — вернуть в очередь paused jobs (без CAMPAIGN_REPEAT_*).
   * Dynamic import — иначе цикл campaigns↔telegram ломает DI.
   * Задержка как у WA: TG_POST_CONNECT_RESUME_DELAY_MS (2000–15000), по умолчанию 3000.
   */
  private scheduleCampaignResumeAfterTgConnected(userId: string) {
    const raw = Number(process.env.TG_POST_CONNECT_RESUME_DELAY_MS);
    const delayMs = Number.isFinite(raw)
      ? Math.min(15_000, Math.max(2_000, Math.floor(raw)))
      : 3_000;

    setTimeout(() => {
      void import('../campaigns/campaigns.service.js')
        .then(({ CampaignsService }) => {
          try {
            const campaigns = this.moduleRef.get(CampaignsService, {
              strict: false,
            });
            if (!campaigns) return;
            void campaigns
              .autoResumeDisconnectedJobsForUser(userId, { channelHint: 'tg' })
              .then((r) => {
                if (r.resumed > 0) {
                  this.logger.log(
                    `[TG] post-connect auto-resume: ${r.resumed} job(s), ${r.campaigns} campaign(s) userId=${userId}`,
                  );
                }
              })
              .catch((e: any) =>
                this.logger.warn(
                  `[TG] autoResumeDisconnectedJobsForUser failed userId=${userId}: ${e?.message ?? e}`,
                ),
              );

            void campaigns
              .autoWakeConnectivityRetryJobsForUser(userId, {
                channelHint: 'tg',
              })
              .then((r) => {
                if (r.woken > 0) {
                  this.logger.log(
                    `[TG] post-connect fast-wake: ${r.woken} retry job(s), ${r.campaigns} campaign(s) userId=${userId}`,
                  );
                }
              })
              .catch((e: any) =>
                this.logger.warn(
                  `[TG] autoWakeConnectivityRetryJobsForUser failed userId=${userId}: ${e?.message ?? e}`,
                ),
              );
          } catch (e: any) {
            this.logger.debug(
              `[TG] CampaignsService not available for auto-resume: ${e?.message ?? e}`,
            );
          }
        })
        .catch((e: any) =>
          this.logger.warn(
            `[TG] campaigns.module load failed (auto-resume) userId=${userId}: ${e?.message ?? e}`,
          ),
        );
    }, delayMs);
  }

  private clearGroupsCountCacheForUser(userId: string) {
    const prefix = `${userId}_`;
    for (const key of [...this.groupsCountCache.keys()]) {
      if (key === userId || key.startsWith(prefix)) {
        this.groupsCountCache.delete(key);
      }
    }
  }

  private buildTgAccountKey(params: {
    phone?: string | null;
    meId?: string | null;
  }): string | null {
    const meId = String(params.meId || '').trim();
    if (meId) return `tgid:${meId}`;
    return null;
  }

  private parseProvidedTgAccountFilter(v?: string | null): string | null {
    const raw = String(v ?? '').trim();
    if (!raw) return null;
    if (raw.startsWith('tgid:')) return raw.toLowerCase();
    return null;
  }

  private async maybeBackfillLegacyPhoneAccountKey(params: {
    userId: string;
    tgAccountKey: string | null;
    tgPhone: string | null;
  }): Promise<void> {
    const accountKey = String(params.tgAccountKey || '').trim().toLowerCase();
    if (!accountKey.startsWith('tgid:')) return;
    const normalizedPhone = String(params.tgPhone || '').trim();
    if (!normalizedPhone || !normalizedPhone.startsWith('+')) return;
    const marker = `${params.userId}:${accountKey}`;
    if (this.tgAccountPhoneBackfillDone.has(marker)) return;

    const supabase = this.supabaseService.getClient();
    const aliases = new Set<string>([normalizedPhone]);
    aliases.add(normalizedPhone.replace(/^\+/, ''));

    for (const fromPhone of aliases) {
      const { error } = await supabase
        .from('telegram_groups')
        .update({
          tg_phone: accountKey,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', params.userId)
        .eq('tg_phone', fromPhone);
      if (error) {
        this.logger.warn(
          `[TG backfillPhoneAccountKey] failed userId=${params.userId} from=${fromPhone} -> ${accountKey}: ${error.message}`,
        );
      }
    }

    this.tgAccountPhoneBackfillDone.add(marker);
    this.logger.log(
      `[TG backfillPhoneAccountKey] completed userId=${params.userId} -> ${accountKey}`,
    );
  }

  async getActiveTgAccountKey(userId: string): Promise<string | null> {
    const cached = this.activeTgAccountCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    const client = this.sessions.get(userId) ?? null;
    if (!client) {
      const dbKey = await this.getLastKnownTgAccountKeyFromDb(userId);
      this.activeTgAccountCache.set(userId, {
        key: dbKey,
        expiresAt: Date.now() + this.ACTIVE_TG_ACCOUNT_CACHE_TTL_MS,
      });
      return dbKey;
    }
    try {
      const me: any = await client.getMe();
      const key = this.buildTgAccountKey({
        phone: (me as any)?.phone ?? (me as any)?.phoneNumber ?? null,
        meId:
          (me as any)?.id != null
            ? String((me as any).id)
            : (me as any)?.userId != null
              ? String((me as any).userId)
              : null,
      });
      this.activeTgAccountCache.set(userId, {
        key,
        expiresAt: Date.now() + this.ACTIVE_TG_ACCOUNT_CACHE_TTL_MS,
      });
      return key;
    } catch (e: any) {
      this.logger.debug(
        `[TG] getActiveTgAccountKey failed userId=${userId}: ${e?.message ?? e}`,
      );
      const dbKey = await this.getLastKnownTgAccountKeyFromDb(userId);
      this.activeTgAccountCache.set(userId, {
        key: dbKey,
        expiresAt: Date.now() + this.ACTIVE_TG_ACCOUNT_CACHE_TTL_MS,
      });
      return dbKey;
    }
  }

  private async getLastKnownTgAccountKeyFromDb(
    userId: string,
  ): Promise<string | null> {
    try {
      const supabase = this.supabaseService.getClient();
      const { data, error } = await supabase
        .from('telegram_groups')
        .select('tg_phone, updated_at')
        .eq('user_id', userId)
        .like('tg_phone', 'tgid:%')
        .order('updated_at', { ascending: false })
        .limit(1);
      if (error) return null;
      const key = String((data?.[0] as any)?.tg_phone || '')
        .trim()
        .toLowerCase();
      return key.startsWith('tgid:') ? key : null;
    } catch {
      return null;
    }
  }

  /** Фильтр по аккаунту: только key или key + строки с tg_phone IS NULL (legacy). */
  private applyTgPhoneAccountFilter(
    q: any,
    accountKey: string,
    includeUnassigned: boolean,
  ) {
    if (!accountKey) return q;
    if (includeUnassigned) {
      return applyTelegramGroupsTgPhoneScope(q, accountKey);
    }
    return q.eq('tg_phone', accountKey);
  }

  private tgStaleNotInDialogsReasonPrefix(): string {
    return 'stale_not_in_dialogs';
  }

  private tgStaleNotInDialogsQuarantineMs(): number {
    const raw = Number(
      (process.env.TG_STALE_NOT_IN_DIALOGS_QUARANTINE_MS ||
        String(24 * 60 * 60 * 1000)).trim(),
    );
    if (!Number.isFinite(raw)) return 24 * 60 * 60 * 1000;
    return Math.max(10 * 60 * 1000, Math.min(30 * 24 * 60 * 60 * 1000, raw));
  }

  private tgStaleKeepSelected(): boolean {
    return String(process.env.TG_STALE_KEEP_SELECTED || 'true')
      .toLowerCase()
      .trim() !== 'false';
  }

  /**
   * Счётчики для списка TG: строки в telegram_groups и уникальные tg_chat_id.
   * RPC telegram_groups_list_stats (см. migrations/telegram_groups_list_stats_rpc.sql); при отсутствии — null.
   */
  /** Список групп без OFFSET (ключ updated_at + tg_chat_id). */
  private isSupabaseRpcSignatureMismatch(error: any): boolean {
    const msg = String(error?.message ?? '');
    return (
      msg.includes('Could not find the function') ||
      msg.includes('schema cache') ||
      String(error?.code ?? '') === '42883'
    );
  }

  private async fetchTelegramGroupsKeysetPage(
    userId: string,
    limit: number,
    selectedOnly: boolean,
    tgPhone: string | null,
    after: { updatedAt: string; chatId: string } | null,
    includeUnassignedTgPhone = false,
  ): Promise<{ rows: any[]; error: any }> {
    const supabase = this.supabaseService.getClient();
    const baseArgs = {
      p_user_id: userId,
      p_limit: limit,
      p_selected_only: selectedOnly,
      p_tg_phone: tgPhone,
      p_after_updated: after?.updatedAt ?? null,
      p_after_chat: after?.chatId ?? null,
    };
    const args =
      includeUnassignedTgPhone
        ? { ...baseArgs, p_include_unassigned: true as const }
        : baseArgs;
    let { data, error } = await supabase.rpc('telegram_groups_keyset_page', args);
    if (error && includeUnassignedTgPhone && this.isSupabaseRpcSignatureMismatch(error)) {
      const r2 = await supabase.rpc('telegram_groups_keyset_page', baseArgs);
      data = r2.data;
      error = r2.error;
    }
    return { rows: Array.isArray(data) ? data : [], error };
  }

  private isKeysetRpcMissingError(error: any): boolean {
    const msg = String(error?.message ?? '');
    const code = String(error?.code ?? '');
    return (
      msg.includes('telegram_groups_keyset_page') ||
      msg.includes('42883') ||
      code === '42883'
    );
  }

  private async fetchTelegramGroupsListStats(
    userId: string,
    selectedOnly: boolean,
    tgPhoneNorm: string | null,
    tgPhoneColumnMissing: boolean,
    includeUnassignedTgPhone = false,
  ): Promise<{ rowCount: number; chatCount: number } | null> {
    const supabase = this.supabaseService.getClient();
    const phoneArg =
      tgPhoneNorm && !tgPhoneColumnMissing ? tgPhoneNorm : null;
    try {
      const wantsUnassigned =
        Boolean(phoneArg) &&
        includeUnassignedTgPhone &&
        !tgPhoneColumnMissing;
      const listStatsPayload: Record<string, unknown> = {
        p_user_id: userId,
        p_selected_only: selectedOnly,
        p_tg_phone: phoneArg,
      };
      if (wantsUnassigned) {
        listStatsPayload.p_include_unassigned = true;
      }
      let { data, error } = await supabase.rpc(
        'telegram_groups_list_stats',
        listStatsPayload as any,
      );
      if (
        error &&
        wantsUnassigned &&
        this.isSupabaseRpcSignatureMismatch(error)
      ) {
        const r2 = await supabase.rpc('telegram_groups_list_stats', {
          p_user_id: userId,
          p_selected_only: selectedOnly,
          p_tg_phone: phoneArg,
        } as any);
        data = r2.data;
        error = r2.error;
      }
      if (error) {
        const msg = String(error.message ?? '');
        if (msg.includes('tg_phone') && phoneArg) {
          return this.fetchTelegramGroupsListStats(
            userId,
            selectedOnly,
            null,
            true,
            false,
          );
        }
        this.logger.debug(
          `[TG telegram_groups_list_stats] ${msg || 'rpc_failed'} — fallback на count(*)`,
        );
        return null;
      }
      const row = Array.isArray(data) ? data[0] : data;
      const rowCount = Number((row as any)?.row_count ?? 0);
      const chatCount = Number((row as any)?.chat_count ?? 0);
      if (!Number.isFinite(rowCount) || !Number.isFinite(chatCount)) return null;
      return { rowCount, chatCount };
    } catch (e: any) {
      this.logger.debug(
        `[TG telegram_groups_list_stats] ${e?.message ?? e} — fallback`,
      );
      return null;
    }
  }

  private isMissingTgMetricsColumnsError(error: any) {
    const msg = String(error?.message ?? '');
    return (
      msg.includes('views_count') ||
      msg.includes('forwards_count') ||
      msg.includes('replies_count')
    );
  }

  /**
   * Нормализует ошибку Supabase/PostgREST для логов и ответа API.
   * Возвращает короткое пояснение для пользователя и полные данные для логов.
   */
  private formatSupabaseError(error: any): {
    logLine: string;
    userMessage: string;
    code?: string;
  } {
    const code = error?.code ?? '';
    const message = String(error?.message ?? '');
    const details = error?.details != null ? String(error.details) : '';
    const hint = error?.hint != null ? String(error.hint) : '';
    const logLine = `[TG syncGroups] Supabase upsert error code=${code} message=${message}${details ? ` details=${details}` : ''}${hint ? ` hint=${hint}` : ''}`;

    let userMessage = 'Не удалось сохранить список групп. Попробуйте ещё раз.';
    if (message.includes('does not exist') || code === '42703') {
      userMessage =
        'В базе нет нужных колонок для групп. Обратитесь в поддержку (миграция telegram_groups).';
    } else if (message.includes('duplicate') || code === '23505') {
      userMessage = 'Конфликт записей. Нажмите «Синхронизировать» ещё раз.';
    } else if (
      message.includes('violates') ||
      code === '23503' ||
      code === '23514'
    ) {
      userMessage = 'Ошибка ограничений базы. Обратитесь в поддержку.';
    } else if (
      message.includes('permission') ||
      message.includes('policy') ||
      code === '42501'
    ) {
      userMessage = 'Нет доступа к записи групп. Обратитесь в поддержку.';
    } else if (message || code) {
      userMessage = `Ошибка базы (${code || 'unknown'}): ${message.slice(0, 120)}`;
    }
    return { logLine, userMessage, code: code || undefined };
  }

  private stripTgMetricsColumns(rows: any[]) {
    return rows.map(
      ({ views_count, forwards_count, replies_count, ...rest }: any) => rest,
    );
  }

  private stripTgPhoneColumn(rows: any[]) {
    return rows.map(({ tg_phone, ...rest }: any) => rest);
  }

  private stripTgQuarantineColumns(rows: any[]) {
    return rows.map(
      ({ quarantine_until, quarantine_reason, ...rest }: any) => rest,
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
      // cleanup: only delete if still the latest in chain
      if (this.locks.get(key) === cur) this.locks.delete(key);
    }
  }

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

  private newTelegramClient(session: StringSession, options: any = {}) {
    const client = new TelegramClient(
      session,
      this.apiId(),
      this.apiHash(),
      options,
    );
    (client as any).setLogLevel?.('none');
    return client;
  }

  // Graceful shutdown
  async onModuleDestroy() {
    for (const userId of this.sessionLeaseTimers.keys()) {
      this.stopSessionLeaseTimer(userId);
    }

    // disconnect connected clients
    for (const [userId, c] of this.sessions.entries()) {
      await c.disconnect().catch(() => undefined);
      await this.runtimeCoordinationService
        .releaseMessengerLease(this.channel, userId)
        .catch(() => undefined);
    }
    this.sessions.clear();
    this.sessionLeaseTouchedAt.clear();

    // disconnect pending auth clients
    for (const [userId, p] of this.pending.entries()) {
      await p.client.disconnect().catch(() => undefined);
      await this.runtimeCoordinationService
        .releaseMessengerLease(this.channel, userId)
        .catch(() => undefined);
    }
    this.pending.clear();
  }

  // ---------- get premium status ----------
  async getPremiumStatus(
    userId: string,
  ): Promise<{ success: boolean; isPremium: boolean; maxFileSize: number }> {
    try {
      const client = this.sessions.get(userId) ?? null;
      if (!client) {
        // Если не подключен - возвращаем консервативный лимит (без премиума)
        return {
          success: true,
          isPremium: false,
          maxFileSize: 2 * 1024 * 1024 * 1024,
        }; // 2GB
      }

      const me = await client.getMe().catch(() => null);
      if (!me) {
        return {
          success: true,
          isPremium: false,
          maxFileSize: 2 * 1024 * 1024 * 1024,
        }; // 2GB
      }

      // Проверяем премиум статус из объекта пользователя
      const isPremium =
        (me as any).premium === true || (me as any).isPremium === true;
      const maxFileSize = isPremium
        ? 4 * 1024 * 1024 * 1024
        : 2 * 1024 * 1024 * 1024; // 4GB для премиума, 2GB для обычных

      this.logger.log(
        `[TG] Premium status for userId=${userId}: isPremium=${isPremium}, maxFileSize=${maxFileSize / (1024 * 1024 * 1024)}GB`,
      );

      return { success: true, isPremium, maxFileSize };
    } catch (e: any) {
      this.logger.warn(
        `[TG] Failed to get premium status for userId=${userId}: ${e?.message || e}`,
      );
      // В случае ошибки возвращаем консервативный лимит
      return {
        success: false,
        isPremium: false,
        maxFileSize: 2 * 1024 * 1024 * 1024,
      }; // 2GB
    }
  }

  private readonly accountAvatarCache = new Map<
    string,
    { url: string | null; ts: number }
  >();
  private readonly ACCOUNT_AVATAR_TTL_MS = 60 * 60 * 1000; // 1 час

  /** URL аватарки подключённого TG-аккаунта (для отображения в ЛК) */
  async getAccountAvatarUrl(
    userId: string,
  ): Promise<{ success: boolean; url?: string | null; message?: string }> {
    try {
      const key = userId;
      const cached = this.accountAvatarCache.get(key);
      const now = Date.now();
      if (cached && now - cached.ts < this.ACCOUNT_AVATAR_TTL_MS) {
        return { success: true, url: cached.url };
      }

      const supabase = this.supabaseService.getClient();
      const bucket = 'template-media';
      const path = `tg-avatars/${userId}/me.jpg`;

      const signExisting = async (): Promise<string | null> => {
        const { data, error } = await supabase.storage
          .from(bucket)
          .createSignedUrl(path, 3600);
        if (error || !data?.signedUrl) return null;
        return data.signedUrl;
      };

      let signedUrl = await signExisting();

      if (!signedUrl) {
        const client = this.sessions.get(userId) ?? null;
        if (!client) return { success: false, message: 'telegram_not_connected' };

        const me = await client.getMe().catch(() => null);
        if (!me) {
          this.accountAvatarCache.set(key, { url: null, ts: Date.now() });
          return { success: true, url: null };
        }

        let buf = await client
          .downloadProfilePhoto(me as any, { isBig: false })
          .catch(() => null);
        if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
          buf = await client
            .downloadProfilePhoto(me as any, { isBig: true })
            .catch(() => null);
        }
        if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
          this.accountAvatarCache.set(key, { url: null, ts: Date.now() });
          return { success: true, url: null };
        }

        const { error: upErr } = await supabase.storage
          .from(bucket)
          .upload(path, buf, {
            contentType: 'image/jpeg',
            upsert: true,
          });
        if (upErr) {
          this.logger.warn(
            `[TG] avatar upload failed userId=${userId}: ${upErr.message}`,
          );
          this.accountAvatarCache.set(key, { url: null, ts: Date.now() });
          return { success: true, url: null };
        }

        signedUrl = await signExisting();
        if (!signedUrl) {
          this.logger.warn(
            `[TG] avatar createSignedUrl failed after upload userId=${userId}`,
          );
          this.accountAvatarCache.set(key, { url: null, ts: Date.now() });
          return { success: true, url: null };
        }
      }

      this.accountAvatarCache.set(key, { url: signedUrl, ts: Date.now() });
      return { success: true, url: signedUrl };
    } catch (e: any) {
      this.logger.warn(
        `[TG] getAccountAvatarUrl failed for userId=${userId}: ${e?.message ?? e}`,
      );
      return { success: false, message: e?.message ?? 'unknown' };
    }
  }

  /** Данные подключённого аккаунта Telegram (id, username, имя) для отображения в кабинете */
  async getAccountInfo(userId: string): Promise<{
    success: boolean;
    message?: string;
    id?: number;
    username?: string | null;
    first_name?: string;
    last_name?: string | null;
    phone?: string | null;
    is_premium?: boolean;
  }> {
    try {
      const client = this.sessions.get(userId) ?? null;

      if (client) {
        const me = await client.getMe().catch(() => null);
        if (me) {
          const u = me as any;
          return {
            success: true,
            id: u.id ?? undefined,
            username: u.username ?? null,
            first_name: u.firstName ?? u.first_name ?? '',
            last_name: u.lastName ?? u.last_name ?? null,
            phone: u.phone ?? null,
            is_premium: u.premium === true || u.isPremium === true,
          };
        }
      }

      // Фоллбэк: хотя бы вернём номер телефона пользователя из таблицы users,
      // чтобы в кабинете было видно, с каким номером связан Telegram.
      const supabase = this.supabaseService.getClient();
      const { data: userRow } = await supabase
        .from('users')
        .select('phone')
        .eq('id', userId)
        .maybeSingle();

      return {
        success: true,
        phone: (userRow as any)?.phone ?? null,
      };
    } catch (e: any) {
      this.logger.warn(
        `[TG] getAccountInfo failed for userId=${userId}: ${e?.message ?? e}`,
      );
      return { success: false, message: e?.message ?? 'unknown' };
    }
  }

  // ---------- status ----------
  private async hasSavedSession(userId: string): Promise<boolean> {
    const supabase = this.supabaseService.getClient();
    const { data: user, error } = await supabase
      .from('users')
      .select('id, tg_session')
      .eq('id', userId)
      .maybeSingle();

    return !error && Boolean((user as any)?.tg_session);
  }

  private isHardNotConnectedState(lastError?: string | null): boolean {
    if (!lastError) return false;
    return /tg_saved_session_invalid|AUTH_KEY|SESSION_REVOKED|SESSION_PASSWORD_NEEDED|USER_DEACTIVATED|PHONE_NUMBER/i.test(
      lastError,
    );
  }

  async getStatus(userId: string) {
    if (this.sessions.has(userId)) {
      await this.publishRuntimeState({
        userId,
        status: 'connected',
      });
      return { success: true, status: 'connected' as TgStatus };
    }

    const p = this.pending.get(userId);
    if (p) {
      const left =
        p.cooldownUntil && Date.now() < p.cooldownUntil
          ? Math.ceil((p.cooldownUntil - Date.now()) / 1000)
          : 0;

      await this.publishRuntimeState({
        userId,
        status: p.status,
        lastError: p.lastError || null,
        cooldownSeconds: left || null,
      });
      return {
        success: true,
        status: p.status,
        lastError: p.lastError || null,
        cooldownSeconds: left || null,
      };
    }

    const shared = await this.runtimeCoordinationService.readMessengerState<{
      success?: boolean;
      status?: TgStatus;
      lastError?: string | null;
      cooldownSeconds?: number | null;
    }>(this.channel, userId);
    if (shared?.status) {
      if (
        shared.status === 'not_connected' &&
        !this.isHardNotConnectedState(shared.lastError) &&
        (await this.hasSavedSession(userId))
      ) {
        await this.publishRuntimeState({
          userId,
          status: 'connected',
        });
        return { success: true, status: 'connected' as TgStatus };
      }

      return {
        success: shared.success !== false,
        status: shared.status,
        lastError: shared.lastError ?? null,
        cooldownSeconds: shared.cooldownSeconds ?? null,
      };
    }

    // если есть сохранённая сессия — пробуем авто-коннект
    if (await this.hasSavedSession(userId)) {
      return { success: true, status: 'connected' as TgStatus };
    }

    return { success: true, status: 'not_connected' as TgStatus };
  }

  private async connectFromSavedSession(userId: string, sessionStr: string) {
    return this.withLock(userId, async () => {
      await this.connectFromSavedSessionNoLock(userId, sessionStr);
    });
  }

  private async connectFromSavedSessionNoLock(
    userId: string,
    sessionStr: string,
  ) {
    // maybe already connected while we waited for lock
    if (this.sessions.has(userId)) return;
    if (!(await this.ensureSessionLease(userId, 'connect_saved_session'))) {
      throw new Error('telegram_session_busy');
    }

    const session = new StringSession(sessionStr);
    const client = this.newTelegramClient(session, {
      connectionRetries: 5,
      retryDelay: 1000,
    });

    await client.connect();
    const me = await client.getMe().catch(() => null);
    if (!me) {
      await client.disconnect().catch(() => undefined);
      await this.publishRuntimeState({
        userId,
        status: 'not_connected',
        lastError: 'tg_saved_session_invalid',
      });
      await this.runtimeCoordinationService
        .releaseMessengerLease(this.channel, userId)
        .catch(() => undefined);
      throw new Error('tg_saved_session_invalid');
    }

    this.sessions.set(userId, client);
    this.touchSessionLease(userId);
    await this.publishRuntimeState({
      userId,
      status: 'connected',
    });
    this.scheduleCampaignResumeAfterTgConnected(userId);
  }

  /**
   * Проверка сохранённой сессии для частого поллинга QR/status из кабинета.
   * Критично: не поднимать второй TelegramClient с тем же tg_session параллельно основному —
   * Telegram отвечает AUTH_KEY_DUPLICATED и сессию приходится сбрасывать.
   * Здесь используется тот же per-user lock и при необходимости уже существующий клиент из {@link sessions}.
   */
  async validateSavedSessionForQrPoll(
    userId: string,
    sessionStr: string,
  ): Promise<{
    connected: boolean;
    errorDetail?: string;
  }> {
    return this.withLock(userId, async () => {
      const supabase = this.supabaseService.getClient();
      const existing = this.sessions.get(userId);
      const shared =
        await this.runtimeCoordinationService.readMessengerState<{
          status?: TgStatus;
        }>(this.channel, userId);

      if (existing) {
        try {
          const me = await existing.getMe().catch(() => null);
          if (me) {
            this.touchSessionLease(userId);
            await this.publishRuntimeState({
              userId,
              status: 'connected',
            });
            return { connected: true };
          }
          await existing.disconnect().catch(() => undefined);
          this.sessions.delete(userId);
          this.stopSessionLeaseTimer(userId);
          await supabase
            .from('users')
            .update({ tg_session: null })
            .eq('id', userId);
          await this.publishRuntimeState({
            userId,
            status: 'not_connected',
          });
          await this.runtimeCoordinationService
            .releaseMessengerLease(this.channel, userId)
            .catch(() => undefined);
          return {
            connected: false,
            errorDetail: 'getMe_null_existing_client',
          };
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          this.logger.warn(
            `[TG] validateSavedSessionForQrPoll existing client userId=${userId}: ${msg}`,
          );
          if (
            msg.includes('AUTH_KEY_DUPLICATED') ||
            msg.includes('AUTH_KEY_UNREGISTERED')
          ) {
            await existing.disconnect().catch(() => undefined);
            this.sessions.delete(userId);
            this.stopSessionLeaseTimer(userId);
            await supabase
              .from('users')
              .update({ tg_session: null })
              .eq('id', userId);
            await this.publishRuntimeState({
              userId,
              status: 'not_connected',
              lastError: msg,
            });
            await this.runtimeCoordinationService
              .releaseMessengerLease(this.channel, userId)
              .catch(() => undefined);
          }
          return { connected: false, errorDetail: msg };
        }
      }

      if (shared?.status === 'connected') {
        return { connected: true };
      }

      if (
        !(await this.ensureSessionLease(
          userId,
          'validate_saved_session_for_qr_poll',
        ))
      ) {
        return {
          connected: false,
          errorDetail: 'session_owned_by_other_runtime',
        };
      }

      try {
        await this.connectFromSavedSessionNoLock(userId, sessionStr);
        return { connected: true };
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        this.logger.warn(
          `[TG] validateSavedSessionForQrPoll connect userId=${userId}: ${msg}`,
        );
        if (
          msg.includes('AUTH_KEY_DUPLICATED') ||
          msg.includes('AUTH_KEY_UNREGISTERED') ||
          msg.includes('tg_saved_session_invalid')
        ) {
          await supabase
            .from('users')
            .update({ tg_session: null })
            .eq('id', userId);
        }
        await this.publishRuntimeState({
          userId,
          status: 'not_connected',
          lastError: msg,
        });
        await this.runtimeCoordinationService
          .releaseMessengerLease(this.channel, userId)
          .catch(() => undefined);
        return { connected: false, errorDetail: msg };
      }
    });
  }

  // ---------- auth start (send code) ----------
  async startAuth(userId: string) {
    return this.withLock(userId, async () => {
      this.logger.log(`[TG] startAuth userId=${userId}`);
      if (!(await this.ensureSessionLease(userId, 'start_auth'))) {
        const shared =
          await this.runtimeCoordinationService.readMessengerState<{
            success?: boolean;
            status?: TgStatus;
            lastError?: string | null;
            cooldownSeconds?: number | null;
          }>(this.channel, userId);
        return (
          shared ?? {
            success: false,
            message: 'telegram_session_busy',
          }
        );
      }

      const supabase = this.supabaseService.getClient();
      const { data: user, error } = await supabase
        .from('users')
        .select('id, phone')
        .eq('id', userId)
        .maybeSingle();

      if (error || !user) {
        await this.runtimeCoordinationService
          .releaseMessengerLease(this.channel, userId)
          .catch(() => undefined);
        return { success: false, message: 'user_not_found' };
      }

      const phone = normalizePhoneE164(String((user as any).phone || ''));
      if (!phone.startsWith('+')) {
        await this.runtimeCoordinationService
          .releaseMessengerLease(this.channel, userId)
          .catch(() => undefined);
        return { success: false, message: 'user_phone_invalid_format' };
      }
      this.logger.log(`[TG] normalized phone for ${userId}: ${phone}`);

      // если уже подключён — ок
      if (this.sessions.has(userId)) {
        await this.publishRuntimeState({
          userId,
          status: 'connected',
        });
        return {
          success: true,
          status: 'connected' as TgStatus,
          message: 'already_connected',
        };
      }

      // если pending уже есть — не создаём заново (5 минут), а если floodwait — возвращаем его
      const existing = this.pending.get(userId);
      if (existing?.cooldownUntil && Date.now() < existing.cooldownUntil) {
        const left = Math.ceil((existing.cooldownUntil - Date.now()) / 1000);
        await this.publishRuntimeState({
          userId,
          status: existing.status,
          lastError: existing.lastError || null,
          cooldownSeconds: left,
        });
        return {
          success: false,
          status: existing.status,
          message: 'tg_flood_wait',
          seconds: left,
        };
      }

      if (existing && Date.now() - existing.createdAt < 5 * 60_000) {
        await this.publishRuntimeState({
          userId,
          status: existing.status,
          lastError: existing.lastError || null,
        });
        return {
          success: true,
          status: existing.status,
          message: 'already_started',
        };
      }

      const session = new StringSession('');
      const client = this.newTelegramClient(session, {
        connectionRetries: 2,
      });

      try {
        await client.connect();
      } catch (e) {
        await this.publishRuntimeState({
          userId,
          status: 'error',
          lastError: String((e as any)?.message ?? e),
        });
        await this.runtimeCoordinationService
          .releaseMessengerLease(this.channel, userId)
          .catch(() => undefined);
        throw e;
      }

      const sendCode = (client as any).sendCode?.bind(client);
      if (sendCode) {
        (client as any).sendCode = async (...args: any[]) => {
          const res = await sendCode(...args);
          const typeClass =
            res?.type?.className ||
            res?.type?._ ||
            res?.type?.constructor?.name ||
            '';
          const nextTypeClass =
            res?.nextType?.className ||
            res?.nextType?._ ||
            res?.nextType?.constructor?.name ||
            '';
          const timeout = res?.timeout;
          this.logger.log(
            `[TG] sendCode type=${typeClass || 'unknown'} nextType=${
              nextTypeClass || 'none'
            } timeout=${timeout ?? 'n/a'}`,
          );
          const isCodeViaApp = res?.isCodeViaApp;
          const hashLen = String(res?.phoneCodeHash || '').length;
          this.logger.log(
            `[TG] sendCode keys=${Object.keys(res || {}).join(',')} typeKeys=${Object.keys(
              res?.type || {},
            ).join(',')}`,
          );
          this.logger.log(
            `[TG] sendCode isCodeViaApp=${String(isCodeViaApp)} phoneCodeHashLen=${hashLen}`,
          );
          return res;
        };
      }

      const phoneCode = deferred<string>();
      const password = deferred<string>();

      const p: PendingAuth = {
        client,
        phone,
        createdAt: Date.now(),
        status: 'awaiting_code',
        phoneCode,
        password,
        startPromise: Promise.resolve(),
      };

      // ВАЖНО: НЕ вызываем auth.SendCode вручную.
      // client.start сам отправит код и будет ждать ввода через phoneCode().
      p.startPromise = client.start({
        phoneNumber: async () => phone,

        phoneCode: async () => {
          this.logger.log(
            '[TG] phoneCode() callback entered (code was sent by Telegram)',
          );
          const code = await p.phoneCode.promise;
          p.phoneCode = deferred<string>(); // allow retries if code wrong
          return code;
        },

        password: async () => {
          p.status = 'awaiting_password';
          p.lastError = undefined;
          this.pending.set(userId, p);
          void this.publishRuntimeState({
            userId,
            status: p.status,
          });

          const pass = await p.password.promise;
          p.password = deferred<string>(); // allow retries
          return pass;
        },

        onError: (err) => {
          const msg = String((err as any)?.message ?? err);
          this.logger.warn(`[TG] start onError: ${msg}`);

          // TIMEOUT — шум gramjs, не считаем фатальным
          if (msg.includes('TIMEOUT')) {
            this.logger.warn(`[TG] TIMEOUT ignored: ${msg}`);
            return;
          }

          // FLOOD_WAIT
          const m = msg.match(/A wait of (\d+) seconds is required/i);
          if (m) {
            const seconds = Number(m[1] || 0);
            p.status = 'awaiting_code';
            p.lastError = `flood_wait_${seconds}`;
            p.cooldownUntil = Date.now() + seconds * 1000;
            this.pending.set(userId, p);
            void this.publishRuntimeState({
              userId,
              status: p.status,
              lastError: p.lastError,
              cooldownSeconds: seconds,
            });
            void p.client.disconnect().catch(() => undefined);
            return;
          }

          // AUTH_KEY_DUPLICATED — this session is poisoned, disconnect and keep error
          if (msg.includes('AUTH_KEY_DUPLICATED')) {
            p.status = 'error';
            p.lastError = 'auth_key_duplicated';
            this.pending.set(userId, p);
            void this.publishRuntimeState({
              userId,
              status: p.status,
              lastError: p.lastError,
            });
            void p.client.disconnect().catch(() => undefined);
            return;
          }

          p.status = 'error';
          p.lastError = msg;
          this.pending.set(userId, p);
          void this.publishRuntimeState({
            userId,
            status: p.status,
            lastError: p.lastError,
          });
        },
      });

      // если startPromise упал (не через onError) — зафиксируем
      p.startPromise.catch((e: any) => {
        const msg = String(e?.message ?? e);

        if (msg.includes('TIMEOUT')) {
          this.logger.warn(`[TG] startPromise TIMEOUT ignored: ${msg}`);
          return;
        }

        const m = msg.match(/A wait of (\d+) seconds is required/i);
        if (m) {
          const seconds = Number(m[1] || 0);
          p.status = 'awaiting_code';
          p.lastError = `flood_wait_${seconds}`;
          p.cooldownUntil = Date.now() + seconds * 1000;
          this.pending.set(userId, p);
          void this.publishRuntimeState({
            userId,
            status: p.status,
            lastError: p.lastError,
            cooldownSeconds: seconds,
          });
          void p.client.disconnect().catch(() => undefined);
          return;
        }

        if (msg.includes('AUTH_KEY_DUPLICATED')) {
          p.status = 'error';
          p.lastError = 'auth_key_dupliclicated';
          this.pending.set(userId, p);
          void this.publishRuntimeState({
            userId,
            status: p.status,
            lastError: p.lastError,
          });
          void p.client.disconnect().catch(() => undefined);
          return;
        }

        p.status = 'error';
        p.lastError = msg;
        this.pending.set(userId, p);
        void this.publishRuntimeState({
          userId,
          status: p.status,
          lastError: p.lastError,
        });
        this.logger.warn(`[TG] startPromise failed: ${msg}`);
      });

      this.pending.set(userId, p);
      await this.publishRuntimeState({
        userId,
        status: 'awaiting_code',
      });
      return { success: true, status: 'awaiting_code' as TgStatus };
    });
  }

  // ---------- auth confirm code ----------
  async confirmCode(userId: string, code: string) {
    return this.withLock(userId, async () => {
      if (!(await this.ensureSessionLease(userId, 'confirm_code'))) {
        const shared =
          await this.runtimeCoordinationService.readMessengerState<{
            success?: boolean;
            status?: TgStatus;
            lastError?: string | null;
            cooldownSeconds?: number | null;
          }>(this.channel, userId);
        return (
          shared ?? {
            success: false,
            message: 'telegram_session_busy',
          }
        );
      }

      const p = this.pending.get(userId);
      if (!p) {
        await this.runtimeCoordinationService
          .releaseMessengerLease(this.channel, userId)
          .catch(() => undefined);
        return { success: false, message: 'auth_not_started' };
      }

      // если floodwait ещё активен — не принимаем код и не дёргаем start
      if (p.cooldownUntil && Date.now() < p.cooldownUntil) {
        const left = Math.ceil((p.cooldownUntil - Date.now()) / 1000);
        await this.publishRuntimeState({
          userId,
          status: p.status,
          lastError: p.lastError || null,
          cooldownSeconds: left,
        });
        return {
          success: false,
          message: 'tg_flood_wait',
          seconds: left,
          status: p.status,
        };
      }

      const c = String(code || '').trim();
      if (!c) {
        return { success: false, message: 'code_required' };
      }

      try {
        p.phoneCode.resolve(c);

        // даём start() шанс завершиться / переключить статус на пароль
        await Promise.race([
          p.startPromise,
          new Promise((res) => setTimeout(res, 400)),
        ]);

        const me = await p.client.getMe().catch(() => null);
        if (me) {
          const sessionStr = (p.client.session as any).save() as string;

          const supabase = this.supabaseService.getClient();
          await supabase
            .from('users')
            .update({ tg_session: sessionStr })
            .eq('id', userId);

          this.sessions.set(userId, p.client);
          this.pending.delete(userId);
          this.touchSessionLease(userId);
          await this.publishRuntimeState({
            userId,
            status: 'connected',
          });
          this.scheduleCampaignResumeAfterTgConnected(userId);

          return { success: true, status: 'connected' as TgStatus };
        }

        await this.publishRuntimeState({
          userId,
          status: p.status,
          lastError: p.lastError || null,
        });
        return {
          success: true,
          status: p.status,
          lastError: p.lastError || null,
        };
      } catch (e: any) {
        const msg = String(e?.message ?? e);

        if (msg.includes('PHONE_CODE_INVALID')) {
          p.lastError = 'invalid_code';
          this.pending.set(userId, p);
          await this.publishRuntimeState({
            userId,
            status: p.status,
            lastError: p.lastError,
          });
          return { success: false, message: 'invalid_code' };
        }
        if (msg.includes('PHONE_CODE_EXPIRED')) {
          p.lastError = 'code_expired';
          this.pending.set(userId, p);
          await this.publishRuntimeState({
            userId,
            status: p.status,
            lastError: p.lastError,
          });
          return { success: false, message: 'code_expired' };
        }

        const m = msg.match(/A wait of (\d+) seconds is required/i);
        if (m) {
          const seconds = Number(m[1] || 0);
          p.status = 'awaiting_code';
          p.lastError = `flood_wait_${seconds}`;
          p.cooldownUntil = Date.now() + seconds * 1000;
          this.pending.set(userId, p);
          await this.publishRuntimeState({
            userId,
            status: p.status,
            lastError: p.lastError,
            cooldownSeconds: seconds,
          });
          return { success: false, message: 'tg_flood_wait', seconds };
        }

        if (msg.includes('AUTH_KEY_DUPLICATED')) {
          p.lastError = 'auth_key_duplicated';
          p.status = 'error';
          this.pending.set(userId, p);

          // burn saved session so it won't auto-connect into a broken key
          const supabase = this.supabaseService.getClient();
          await supabase
            .from('users')
            .update({ tg_session: null })
            .eq('id', userId);

          await this.publishRuntimeState({
            userId,
            status: p.status,
            lastError: p.lastError,
          });
          return { success: false, message: 'tg_auth_key_duplicated' };
        }

        p.lastError = msg;
        this.pending.set(userId, p);
        await this.publishRuntimeState({
          userId,
          status: p.status,
          lastError: p.lastError,
        });
        return {
          success: false,
          message: 'tg_confirm_code_failed',
          error: msg,
        };
      }
    });
  }

  // ---------- auth confirm password (2FA) ----------
  async confirmPassword(userId: string, password: string) {
    return this.withLock(userId, async () => {
      if (!(await this.ensureSessionLease(userId, 'confirm_password'))) {
        const shared =
          await this.runtimeCoordinationService.readMessengerState<{
            success?: boolean;
            status?: TgStatus;
            lastError?: string | null;
            cooldownSeconds?: number | null;
          }>(this.channel, userId);
        return (
          shared ?? {
            success: false,
            message: 'telegram_session_busy',
          }
        );
      }

      const p = this.pending.get(userId);
      if (!p) {
        await this.runtimeCoordinationService
          .releaseMessengerLease(this.channel, userId)
          .catch(() => undefined);
        return { success: false, message: 'auth_not_started' };
      }

      const pass = String(password || '').trim();
      if (!pass) return { success: false, message: 'password_required' };

      try {
        p.password.resolve(pass);

        await p.startPromise;

        const me = await p.client.getMe().catch(() => null);
        if (!me) throw new Error('tg_password_auth_failed');

        const sessionStr = (p.client.session as any).save() as string;

        const supabase = this.supabaseService.getClient();
        await supabase
          .from('users')
          .update({ tg_session: sessionStr })
          .eq('id', userId);

        this.sessions.set(userId, p.client);
        this.pending.delete(userId);
        this.touchSessionLease(userId);
        await this.publishRuntimeState({
          userId,
          status: 'connected',
        });
        this.scheduleCampaignResumeAfterTgConnected(userId);

        return { success: true, status: 'connected' as TgStatus };
      } catch (e: any) {
        const msg = String(e?.message ?? e);

        const m = msg.match(/A wait of (\d+) seconds is required/i);
        if (m) {
          const seconds = Number(m[1] || 0);
          p.status = 'awaiting_code';
          p.lastError = `flood_wait_${seconds}`;
          p.cooldownUntil = Date.now() + seconds * 1000;
          this.pending.set(userId, p);
          await this.publishRuntimeState({
            userId,
            status: p.status,
            lastError: p.lastError,
            cooldownSeconds: seconds,
          });
          return { success: false, message: 'tg_flood_wait', seconds };
        }

        if (msg.includes('AUTH_KEY_DUPLICATED')) {
          p.lastError = 'auth_key_duplicated';
          p.status = 'error';
          this.pending.set(userId, p);

          const supabase = this.supabaseService.getClient();
          await supabase
            .from('users')
            .update({ tg_session: null })
            .eq('id', userId);

          await this.publishRuntimeState({
            userId,
            status: p.status,
            lastError: p.lastError,
          });
          return { success: false, message: 'tg_auth_key_duplicated' };
        }

        p.lastError = msg;
        p.status = 'awaiting_password';
        this.pending.set(userId, p);
        await this.publishRuntimeState({
          userId,
          status: p.status,
          lastError: p.lastError,
        });
        return { success: false, message: 'tg_password_failed', error: msg };
      }
    });
  }

  async disconnect(userId: string) {
    return this.withLock(userId, async () => {
      await this.ensureSessionLease(userId, 'disconnect').catch(() => false);
      const c = this.sessions.get(userId);
      if (c) {
        await c.disconnect().catch(() => undefined);
        this.sessions.delete(userId);
      }

      const p = this.pending.get(userId);
      if (p) {
        await p.client.disconnect().catch(() => undefined);
        this.pending.delete(userId);
      }

      // важно: иначе status() сразу подключит обратно
      const supabase = this.supabaseService.getClient();
      await supabase
        .from('users')
        .update({ tg_session: null })
        .eq('id', userId);

      this.stopSessionLeaseTimer(userId);
      this.sessionLeaseTouchedAt.delete(userId);
      await this.publishRuntimeState({
        userId,
        status: 'not_connected',
      });
      await this.runtimeCoordinationService
        .releaseMessengerLease(this.channel, userId)
        .catch(() => undefined);
      return { success: true };
    });
  }

  // ---------- sync groups ----------
  async syncGroups(userId: string) {
    const startTime = Date.now();
    this.logger.log(`[TG syncGroups] START for userId=${userId}`);
    const shouldReleaseOwnershipAfterSync = !runtimeHasCapability('worker');
    const finish = async <T>(result: T): Promise<T> => {
      if (shouldReleaseOwnershipAfterSync) {
        await this.releaseConnectedSessionOwnership(
          userId,
          `sync_groups_complete_${runtimeCapabilitiesLabel()}`,
        ).catch(() => undefined);
      }
      return result;
    };

    if (!(await this.ensureSessionLease(userId, 'sync_groups'))) {
      return finish({
        success: false,
        message: 'telegram_session_busy',
      });
    }

    let client = await this.getConnectedClient(userId);
    if (!client)
      return finish({ success: false, message: 'telegram_not_connected' });

    const supabase = this.supabaseService.getClient();
    let { data: existingTimes, error: timeErr } = await supabase
      .from('telegram_groups')
      .select(
        'tg_chat_id, send_time, avatar_url, is_selected, quarantine_until, quarantine_reason',
      )
      .eq('user_id', userId);
    if (
      timeErr &&
      /quarantine_until|quarantine_reason/i.test(
        String((timeErr as any)?.message ?? timeErr),
      )
    ) {
      const retry = await supabase
        .from('telegram_groups')
        .select('tg_chat_id, send_time, avatar_url, is_selected')
        .eq('user_id', userId);
      existingTimes = retry.data as any;
      timeErr = retry.error as any;
    }

    if (timeErr) {
      this.logger.error(
        'Supabase select telegram_groups send_time error',
        timeErr as any,
      );
      return finish({
        success: false,
        message: 'supabase_select_error',
        error: timeErr,
      });
    }

    const sendTimeMap = new Map(
      (existingTimes ?? []).map((r: any) => [
        String(r.tg_chat_id),
        r.send_time,
      ]),
    );
    const avatarMap = new Map(
      (existingTimes ?? []).map((r: any) => [
        String(r.tg_chat_id),
        r.avatar_url,
      ]),
    );
    /** Не затирать ручной снятый выбор при повторном синке — только для чатов, которые снова в диалогах. */
    const selectedMap = new Map(
      (existingTimes ?? []).map((r: any) => [
        String(r.tg_chat_id),
        r.is_selected !== false,
      ]),
    );
    const quarantineMap = new Map(
      (existingTimes ?? []).map((r: any) => [String(r.tg_chat_id), r]),
    );

    let dialogs;
    let apiTime = 0;
    try {
      const apiStartTime = Date.now();
      dialogs = await client.getDialogs({});
      apiTime = Date.now() - apiStartTime;
      this.logger.log(`[TG syncGroups] Telegram API call took ${apiTime}ms`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('TIMEOUT')) {
        this.logger.warn(`TG getDialogs TIMEOUT: ${msg}`);
        return finish({
          success: false,
          message: 'telegram_timeout',
          error: msg,
        });
      }
      if (msg.includes('AUTH_KEY_UNREGISTERED')) {
        this.logger.warn(`TG getDialogs AUTH_KEY_UNREGISTERED: ${msg}`);
        await this.withLock(userId, async () => {
          const existing = this.sessions.get(userId);
          if (existing) {
            await existing.disconnect().catch(() => undefined);
            this.sessions.delete(userId);
            this.stopSessionLeaseTimer(userId);
          }
        });
        await this.publishRuntimeState({
          userId,
          status: 'not_connected',
          lastError: msg,
        });
        await this.runtimeCoordinationService
          .releaseMessengerLease(this.channel, userId)
          .catch(() => undefined);
        client = await this.getConnectedClient(userId);
        if (!client) {
          return finish({ success: false, message: 'telegram_not_connected' });
        }
        try {
          dialogs = await client.getDialogs({});
        } catch (e2: any) {
          const msg2 = String(e2?.message ?? e2);
          if (msg2.includes('TIMEOUT')) {
            this.logger.warn(`TG getDialogs TIMEOUT: ${msg2}`);
            return finish({
              success: false,
              message: 'telegram_timeout',
              error: msg2,
            });
          }
          this.logger.error(`TG getDialogs failed(after reset): ${msg2}`);
          return finish({
            success: false,
            message: 'telegram_get_dialogs_failed',
            error: msg2,
          });
        }
      } else {
        this.logger.error(`TG getDialogs failed: ${msg}`);
        return finish({
          success: false,
          message: 'telegram_get_dialogs_failed',
          error: msg,
        });
      }
    }

    // Номер текущего TG-аккаунта для фильтра при нескольких подключённых аккаунтах
    let tgPhone: string | null = null;
    let tgMeId: string | null = null;
    let tgAccountKey: string | null = null;
    try {
      const me: any = await client.getMe();
      const raw = (me as any)?.phone ?? (me as any)?.phoneNumber ?? '';
      tgPhone = raw
        ? normalizePhoneForStorage(String(raw)) ||
          normalizePhoneE164(String(raw)) ||
          null
        : null;
      if (tgPhone && !tgPhone.startsWith('+')) tgPhone = '+' + tgPhone;
      tgMeId =
        (me as any)?.id != null
          ? String((me as any).id)
          : (me as any)?.userId != null
            ? String((me as any).userId)
            : null;
      tgAccountKey = this.buildTgAccountKey({ phone: tgPhone, meId: tgMeId });
      this.activeTgAccountCache.set(userId, {
        key: tgAccountKey,
        expiresAt: Date.now() + this.ACTIVE_TG_ACCOUNT_CACHE_TTL_MS,
      });
      await this.maybeBackfillLegacyPhoneAccountKey({
        userId,
        tgAccountKey,
        tgPhone,
      });
    } catch (e: any) {
      this.logger.debug(`[TG syncGroups] getMe phone skip: ${e?.message ?? e}`);
    }

    const nowIso = new Date().toISOString();
    const rows: any[] = [];
    const liveChatIds = new Set<string>();
    let revivedStaleCount = 0;
    // Dialog: isUser = личный чат 1-1, isGroup = группа/супергруппа, isChannel = канал (супергруппа или broadcast).
    // Выгружаем группы, супергруппы и каналы (в т.ч. broadcast). Личные чаты (User) не выгружаем.
    const dialogList = Array.isArray(dialogs)
      ? dialogs
      : dialogs && typeof dialogs[Symbol.iterator] === 'function'
        ? [...dialogs]
        : [];

    // Из topMessage (последнее сообщение в диалоге) берём просмотры, пересылки, ответы — в основном у каналов (-100)
    const topMsg = (d: any) =>
      d && typeof d.message !== 'undefined' ? d.message : null;
    const toInt = (v: any): number | null => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const maxAvatarDownloads = 15; // за один синк не более 15 аватарок, чтобы не перегружать API
    let avatarDownloads = 0;

    for (const d of dialogList) {
      const ent: any = d.entity;
      if (d.isUser) continue;
      const includeDialog = d.isGroup || d.isChannel;
      if (!includeDialog) continue;

      const chatIdStr = d.id != null ? String(d.id) : ent && String(ent.id);
      if (!chatIdStr || chatIdStr === '0') continue;
      liveChatIds.add(chatIdStr);

      const accessHashStr =
        ent?.accessHash != null ? String(ent.accessHash) : null;
      const entityClass = String(
        ent?.className || ent?.constructor?.name || '',
      ).toLowerCase();
      const type =
        d.isChannel ||
        accessHashStr != null ||
        entityClass.includes('channel')
          ? 'channel'
          : 'chat';

      // Аватарки есть в основном у супергрупп/каналов (-100). Используем уже сохранённые; при отсутствии — пробуем скачать для канала (лимит за синк).
      let avatarUrl = avatarMap.get(chatIdStr) ?? null;
      if (
        type === 'channel' &&
        !avatarUrl &&
        ent &&
        avatarDownloads < maxAvatarDownloads
      ) {
        try {
          const buf = await client.downloadProfilePhoto(ent, { isBig: false });
          if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
            const supabase = this.supabaseService.getClient();
            const bucket = 'template-media';
            const path = `tg-avatars/${userId}/${chatIdStr.replace(/[^0-9-]/g, '_')}.jpg`;
            const { error: upErr } = await supabase.storage
              .from(bucket)
              .upload(path, buf, {
                contentType: 'image/jpeg',
                upsert: true,
              });
            if (!upErr) {
              const { data } = supabase.storage.from(bucket).getPublicUrl(path);
              avatarUrl = data.publicUrl;
              avatarDownloads += 1;
            }
          }
        } catch (e) {
          this.logger.debug(
            `TG syncGroups: avatar for ${chatIdStr} skip: ${(e as Error)?.message ?? e}`,
          );
        }
      }

      const msg = topMsg(d);
      const viewsCount = msg ? toInt(msg.views) : null;
      const forwardsCount = msg ? toInt(msg.forwards) : null;
      const repliesCount =
        msg?.replies != null ? toInt(msg.replies?.replies) : null;

      const rawTitle = extractTelegramGroupTitle(d, ent, d?.entity, ent?.entity);
      const title =
        String(rawTitle || '').trim() || `Без названия (${chatIdStr})`;
      const prevSel = selectedMap.get(chatIdStr);
      const prevRow: any = quarantineMap.get(chatIdStr) ?? null;
      const wasAutoQuarantined = String(prevRow?.quarantine_reason || '').startsWith(
        'auto_',
      );
      const wasStaleByDialogs = String(prevRow?.quarantine_reason || '').startsWith(
        this.tgStaleNotInDialogsReasonPrefix(),
      );
      const hadQuarantine =
        prevRow?.quarantine_until != null || wasAutoQuarantined;
      if (wasStaleByDialogs) revivedStaleCount += 1;
      // Группа снова резолвится через getDialogs -> снимаем авто-карантин.
      const isSelected = hadQuarantine
        ? true
        : prevSel !== undefined
          ? prevSel
          : true;
      rows.push({
        user_id: userId,
        tg_chat_id: chatIdStr,
        tg_type: type,
        tg_access_hash: accessHashStr,
        tg_phone: tgAccountKey,
        title,
        participants_count: null,
        is_selected: isSelected,
        updated_at: nowIso,
        send_time: sendTimeMap.get(chatIdStr) ?? null,
        avatar_url: avatarUrl,
        views_count: viewsCount,
        forwards_count: forwardsCount,
        replies_count: repliesCount,
        quarantine_until: hadQuarantine ? null : prevRow?.quarantine_until ?? null,
        quarantine_reason: hadQuarantine ? null : prevRow?.quarantine_reason ?? null,
      });
    }

    const dbStartTime = Date.now();
    let metricsMissing = this.tgMetricsColumnsAvailable === false;
    let tgPhoneMissing = false;
    let quarantineMissing = false;
    let error: any = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      let upsertRows = rows;
      if (metricsMissing) upsertRows = this.stripTgMetricsColumns(upsertRows);
      if (tgPhoneMissing) upsertRows = this.stripTgPhoneColumn(upsertRows);
      if (quarantineMissing) {
        upsertRows = this.stripTgQuarantineColumns(upsertRows);
      }

      const result = await supabase
        .from('telegram_groups')
        .upsert(upsertRows, { onConflict: 'user_id,tg_chat_id' });
      error = result.error;

      if (!error) {
        this.tgMetricsColumnsAvailable = !metricsMissing;
        break;
      }

      if (!metricsMissing && this.isMissingTgMetricsColumnsError(error)) {
        this.logger.warn(
          '[TG syncGroups] views_count/forwards_count/replies_count missing in telegram_groups, retrying upsert without these columns',
        );
        metricsMissing = true;
        this.tgMetricsColumnsAvailable = false;
        continue;
      }

      if (
        !tgPhoneMissing &&
        String((error as any)?.message ?? '').includes('tg_phone')
      ) {
        this.logger.warn(
          '[TG syncGroups] tg_phone column missing in telegram_groups, retrying upsert without tg_phone',
        );
        tgPhoneMissing = true;
        continue;
      }

      if (
        !quarantineMissing &&
        /quarantine_until|quarantine_reason/i.test(
          String((error as any)?.message ?? ''),
        )
      ) {
        this.logger.warn(
          '[TG syncGroups] quarantine columns missing in telegram_groups, retrying upsert without quarantine fields',
        );
        quarantineMissing = true;
        continue;
      }

      break;
    }

    if (error) {
      const { logLine, userMessage, code } = this.formatSupabaseError(error);
      this.logger.error(logLine);
      this.logger.error(`[TG syncGroups] Для пользователя: ${userMessage}`);
      return finish({
        success: false,
        message: 'supabase_upsert_error',
        error: error as any,
        userMessage,
        errorCode: code,
      });
    }

    const staleCandidates = (existingTimes ?? [])
      .filter((r: any) => r?.is_selected === true)
      .map((r: any) => String(r?.tg_chat_id || '').trim())
      .filter((id) => id && !liveChatIds.has(id));
    const staleChatIds = [...new Set(staleCandidates)];
    if (staleChatIds.length > 0) {
      const staleUntilIso = new Date(
        Date.now() + this.tgStaleNotInDialogsQuarantineMs(),
      ).toISOString();
      const staleReason = `${this.tgStaleNotInDialogsReasonPrefix()}_sync`;
      const keepSelected = this.tgStaleKeepSelected();
      const chunkSize = 200;
      for (let i = 0; i < staleChatIds.length; i += chunkSize) {
        const chunk = staleChatIds.slice(i, i + chunkSize);
        const basePayload: Record<string, any> = {
          updated_at: nowIso,
        };
        if (!keepSelected) basePayload.is_selected = false;
        let payload: Record<string, any> = {
          ...basePayload,
          quarantine_until: staleUntilIso,
          quarantine_reason: staleReason,
        };
        let upd = await supabase
          .from('telegram_groups')
          .update(payload)
          .eq('user_id', userId)
          .in('tg_chat_id', chunk);
        if (
          upd.error &&
          /quarantine_until|quarantine_reason/i.test(
            String((upd.error as any)?.message ?? upd.error),
          )
        ) {
          payload = { ...basePayload };
          if (!keepSelected) payload.is_selected = false;
          upd = await supabase
            .from('telegram_groups')
            .update(payload)
            .eq('user_id', userId)
            .in('tg_chat_id', chunk);
        }
        if (upd.error) {
          this.logger.warn(
            `[TG syncGroups] stale mark failed for ${chunk.length} groups (userId=${userId}): ${
              (upd.error as any)?.message ?? upd.error
            }`,
          );
        }
        // Чаты не из live dialogs больше не считаем принадлежащими текущему tgid:
        // снимаем tg_phone только где он совпадал с активным ключом синка, чтобы
        // строки других аккаунтов (другой tgid:) не трогать — они останутся в профиле.
        if (tgAccountKey) {
          const detach = await supabase
            .from('telegram_groups')
            .update({ tg_phone: null, updated_at: nowIso })
            .eq('user_id', userId)
            .in('tg_chat_id', chunk)
            .eq('tg_phone', tgAccountKey);
          if (detach.error) {
            this.logger.warn(
              `[TG syncGroups] detach stale tg_phone for current account failed (userId=${userId}): ${
                (detach.error as any)?.message ?? detach.error
              }`,
            );
          }
        }
      }
      await this.persistLimitLearningEvent({
        userId,
        eventType: 'tg_group_marked_stale',
        label: `count=${staleChatIds.length}`,
      });
      this.logger.warn(
        `[TG syncGroups] stale reconciliation marked ${staleChatIds.length} group(s) not present in live dialogs (userId=${userId}, keepSelected=${keepSelected})`,
      );
    }
    // NOTE: intentionally do not reset is_selected for unassigned (tg_phone=null) rows.
    // Unassigned rows may belong to another connected account history and should stay selectable.
    if (revivedStaleCount > 0) {
      await this.persistLimitLearningEvent({
        userId,
        eventType: 'tg_group_revived_after_sync',
        label: `count=${revivedStaleCount}`,
      });
      this.logger.log(
        `[TG syncGroups] revived stale groups after live dialogs sync: ${revivedStaleCount} (userId=${userId})`,
      );
    }

    this.clearGroupsCountCacheForUser(userId);

    const totalTime = Date.now() - startTime;
    const dbTime = Date.now() - dbStartTime;
    this.logger.log(
      `[TG syncGroups] COMPLETE: total=${totalTime}ms, API=${apiTime}ms, DB=${dbTime}ms, groups=${rows.length}`,
    );

    // Предупреждение для медленных операций
    if (totalTime > 10000) {
      this.logger.warn(
        `[TG syncGroups] SLOW OPERATION: ${totalTime}ms for ${rows.length} groups (userId=${userId})`,
      );
    }

    return finish({ success: true, count: rows.length });
  }

  async getGroupsFromDb(
    userId: string,
    limit?: number,
    offset?: number,
    selectedOnly?: boolean,
    tgPhone?: string | null,
    cursor?: { updatedAt: string; chatId: string } | null,
    templateList = false,
  ) {
    const startTime = Date.now();
    const supabase = this.supabaseService.getClient();
    const parsedExplicit = this.parseProvidedTgAccountFilter(tgPhone ?? null);
    const hadExplicitTgPhoneQuery =
      tgPhone != null && String(tgPhone).trim() !== '';

    let tgAccountFilter = parsedExplicit;
    /** Для аккаунта из сессии (не из query) подмешиваем строки без tg_phone — иначе пустой список до синка. */
    let includeUnassignedTgPhone = false;

    if (tgAccountFilter == null) {
      tgAccountFilter = await this.getActiveTgAccountKey(userId);
      if (tgAccountFilter) {
        includeUnassignedTgPhone = true;
      }
    }

    if (hadExplicitTgPhoneQuery && !parsedExplicit) {
      this.logger.debug(
        `[TG getGroupsFromDb] tgPhone filter ignored (invalid): ${String(tgPhone).slice(0, 20)}`,
      );
    }

    if (!tgAccountFilter) {
      this.logger.warn(
        `[TG getGroupsFromDb] active tg account key unknown userId=${userId} — list without tg_phone filter`,
      );
      includeUnassignedTgPhone = false;
    }

    const wantFullList = templateList === true;
    const effectiveLimit = wantFullList ? undefined : limit;
    const effectiveOffset = wantFullList ? undefined : offset;
    const effectiveCursor = wantFullList ? undefined : cursor;

    let data: any[] = [];
    let error: any = null;
    let tgPhoneColumnMissing = false;
    let usedKeyset = false;

    const legacyOffsetPaging =
      effectiveLimit !== undefined &&
      effectiveOffset !== undefined &&
      effectiveOffset > 0 &&
      effectiveCursor == null;

    const queryStartTime = Date.now();

    if (effectiveLimit !== undefined && !legacyOffsetPaging) {
      let phoneArg: string | null = tgAccountFilter;
      let kr = await this.fetchTelegramGroupsKeysetPage(
        userId,
        effectiveLimit,
        Boolean(selectedOnly),
        phoneArg,
        effectiveCursor ?? null,
        includeUnassignedTgPhone,
      );
      if (
        kr.error &&
        String(kr.error.message ?? '').includes('tg_phone') &&
        phoneArg
      ) {
        tgPhoneColumnMissing = true;
        phoneArg = null;
        kr = await this.fetchTelegramGroupsKeysetPage(
          userId,
          effectiveLimit,
          Boolean(selectedOnly),
          null,
          effectiveCursor ?? null,
          false,
        );
      }
      if (!kr.error) {
        data = kr.rows;
        if (tgPhoneColumnMissing) {
          data = data.map((r: any) => ({ ...r, tg_phone: null }));
        }
        usedKeyset = true;
        error = null;
      } else if (this.isKeysetRpcMissingError(kr.error)) {
        if (effectiveCursor != null) {
          this.logger.error(
            '[TG getGroupsFromDb] keyset RPC missing but cursor sent',
            kr.error,
          );
          return {
            success: false,
            message: 'telegram_keyset_rpc_required',
            error: kr.error,
            userMessage:
              'Нужна миграция БД (telegram_groups_keyset_page.sql). Обратитесь к администратору.',
          };
        }
        this.logger.warn(
          `[TG getGroupsFromDb] keyset RPC unavailable, using OFFSET: ${kr.error?.message}`,
        );
      } else {
        return {
          success: false,
          message: 'supabase_select_error',
          error: kr.error,
        };
      }
    }

    // Оптимизация: выбираем только нужные колонки вместо select('*')
    const selectFieldsFull =
      'tg_chat_id, title, participants_count, tg_type, tg_access_hash, tg_phone, is_selected, send_time, updated_at, avatar_url, views_count, forwards_count, replies_count, last_send_error, last_send_error_at';
    const selectFieldsMin =
      'tg_chat_id, title, participants_count, tg_type, tg_access_hash, is_selected, send_time, updated_at, avatar_url';

    const runQuery = async (
      fields: string,
      filterByTgPhone: string | null = null,
      mergeUnassignedTgPhone = false,
    ) => {
      let q = supabase
        .from('telegram_groups')
        .select(fields)
        .eq('user_id', userId);
      if (selectedOnly) q = q.eq('is_selected', true);
      if (filterByTgPhone) {
        q = this.applyTgPhoneAccountFilter(
          q,
          filterByTgPhone,
          mergeUnassignedTgPhone,
        );
      }
      q = q.order('updated_at', { ascending: false });
      if (wantFullList) {
        q = q.limit(10000);
      } else {
        if (effectiveLimit !== undefined) q = q.limit(effectiveLimit);
        if (effectiveOffset !== undefined)
          q = q.range(
            effectiveOffset,
            effectiveOffset + (effectiveLimit || 1000) - 1,
          );
      }
      return await q;
    };

    if (!usedKeyset) {
      let result = await runQuery(
        selectFieldsFull,
        tgAccountFilter ?? null,
        includeUnassignedTgPhone,
      );
      data = result.data ?? [];
      error = result.error;

      const errMsg = String(error?.message ?? '');
      if (
        error &&
        (errMsg.includes('views_count') ||
          errMsg.includes('forwards_count') ||
          errMsg.includes('replies_count') ||
          errMsg.includes('last_send_error'))
      ) {
        this.logger.warn(
          '[TG getGroupsFromDb] some columns missing, using minimal select',
        );
        result = await runQuery(
          selectFieldsMin,
          tgAccountFilter ?? null,
          includeUnassignedTgPhone,
        );
        data = result.data ?? [];
        error = result.error;
        if (!error && Array.isArray(data)) {
          data = data.map((r: any) => ({
            ...r,
            views_count: null,
            forwards_count: null,
            replies_count: null,
            last_send_error: null,
            last_send_error_at: null,
          }));
        }
      }
      const err2 = String(error?.message ?? '');
      if (error && err2.includes('tg_phone')) {
        this.logger.warn(
          '[TG getGroupsFromDb] tg_phone column missing, using minimal select without tg_phone filter',
        );
        tgPhoneColumnMissing = true;
        result = await runQuery(selectFieldsMin, null);
        data = result.data ?? [];
        error = result.error;
        if (!error && Array.isArray(data)) {
          data = data.map((r: any) => ({ ...r, tg_phone: null }));
        }
      }
    }

    const queryTime = Date.now() - queryStartTime;

    if (error) {
      this.logger.error('Supabase select telegram_groups error', error as any);
      return { success: false, message: 'supabase_select_error', error };
    }

    // Дедупликация на уровне бэкенда на случай дубликатов в БД.
    // При дублях предпочитаем запись с avatar_url, чтобы в списке отображалась картинка.
    const groups: any[] = Array.isArray(data) ? data : [];
    const byId = new Map<string, any>();
    for (const group of groups) {
      const groupId = String(group.tg_chat_id);
      const existing = byId.get(groupId);
      if (!existing) {
        byId.set(groupId, group);
      } else {
        const hasAvatar = !!String(group.avatar_url || '').trim();
        const existingHasAvatar = !!String(existing.avatar_url || '').trim();
        if (hasAvatar && !existingHasAvatar) {
          byId.set(groupId, group);
        }
        if (hasAvatar !== existingHasAvatar || !hasAvatar) {
          this.logger.warn(
            `Дубликат группы в БД: tg_chat_id=${groupId}, user_id=${userId}, title="${group.title}", оставлена запись ${hasAvatar && !existingHasAvatar ? 'с аватаром' : 'первая'}`,
          );
        }
      }
    }
    const uniqueGroups = Array.from(byId.values());
    /** Строк из ответа Supabase до дедупа — именно по ним должен сдвигаться offset пагинации */
    const rawBatchLength = Array.isArray(data) ? data.length : 0;

    // Если запрашиваем с пагинацией - возвращаем также общее количество
    if (effectiveLimit !== undefined) {
      const countStartTime = Date.now();

      // Проверяем кэш перед запросом к БД (учёт selectedOnly и tgPhone)
      const cacheKey = [
        userId,
        selectedOnly ? 'selected' : 'all',
        tgAccountFilter ? `tg_${tgAccountFilter}` : '',
        includeUnassignedTgPhone && tgAccountFilter ? 'un' : '',
      ]
        .filter(Boolean)
        .join('_');
      const cached = this.groupsCountCache.get(cacheKey);
      const now = Date.now();
      let rowCount = 0;
      let chatCount = 0;
      let countTime = 0;

      if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
        rowCount = cached.rowCount;
        chatCount = cached.chatCount;
        countTime = Date.now() - countStartTime;
        this.logger.log(
          `[TG getGroupsFromDb] Using cached stats: rows=${rowCount} chats=${chatCount} (userId=${userId}, selectedOnly=${selectedOnly})`,
        );
      } else {
        const stats = await this.fetchTelegramGroupsListStats(
          userId,
          Boolean(selectedOnly),
          tgAccountFilter,
          tgPhoneColumnMissing,
          includeUnassignedTgPhone,
        );
        countTime = Date.now() - countStartTime;
        if (stats) {
          rowCount = stats.rowCount;
          chatCount = stats.chatCount;
          this.groupsCountCache.set(cacheKey, {
            rowCount,
            chatCount,
            timestamp: now,
          });
        } else {
          let countQuery = supabase
            .from('telegram_groups')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId);
          if (selectedOnly) {
            countQuery = countQuery.eq('is_selected', true);
          }
          if (tgAccountFilter && !tgPhoneColumnMissing) {
            countQuery = this.applyTgPhoneAccountFilter(
              countQuery,
              tgAccountFilter,
              includeUnassignedTgPhone,
            );
          }
          const { count, error: countError } = await countQuery;
          if (countError) {
            this.logger.error(
              'Supabase count telegram_groups error',
              countError as any,
            );
            rowCount = 0;
            chatCount = 0;
          } else {
            rowCount = count ?? 0;
            chatCount = rowCount;
            this.groupsCountCache.set(cacheKey, {
              rowCount,
              chatCount,
              timestamp: now,
            });
          }
        }
      }

      const totalTime = Date.now() - startTime;
      const actualQueryTime = queryTime; // Время основного запроса
      const dedupTime = totalTime - queryTime - countTime; // Время на дедупликацию

      // Анализ производительности: предупреждаем о медленных запросах
      // Особенно обращаем внимание на большие offset, которые могут быть очень медленными
      if (totalTime > 1000) {
        const pagingInfo = usedKeyset
          ? 'keyset'
          : effectiveOffset !== undefined
            ? `offset=${effectiveOffset} (${effectiveOffset > 200 ? 'LARGE OFFSET' : 'normal'})`
            : 'no offset';
        this.logger.warn(
          `[TG getGroupsFromDb] SLOW QUERY: total=${totalTime}ms (query=${actualQueryTime}ms, count=${countTime}ms, dedup=${dedupTime}ms) userId=${userId}, limit=${effectiveLimit}, ${pagingInfo}, returned=${uniqueGroups.length}, rows=${rowCount} chats=${chatCount}`,
        );
      } else {
        this.logger.log(
          `[TG getGroupsFromDb] COMPLETE: total=${totalTime}ms (query=${actualQueryTime}ms, count=${countTime}ms, dedup=${dedupTime}ms), limit=${effectiveLimit}, keyset=${usedKeyset}, offset=${effectiveOffset}, returned=${uniqueGroups.length}, rows=${rowCount} chats=${chatCount}`,
        );
      }

      if (
        !usedKeyset &&
        effectiveOffset !== undefined &&
        effectiveOffset > 0 &&
        uniqueGroups.length === 0 &&
        rowCount > 0
      ) {
        this.logger.warn(
          `[TG getGroupsFromDb] EMPTY PAGE: offset=${effectiveOffset}, rows=${rowCount}, possible pagination issue`,
        );
      }

      const off = effectiveOffset ?? 0;
      const nextOffset = off + rawBatchLength;
      const hasMoreOffset = nextOffset < rowCount;
      const lim = effectiveLimit ?? 0;
      const hasMoreKeyset =
        usedKeyset && lim > 0 && rawBatchLength >= lim;
      const hasMore = usedKeyset ? hasMoreKeyset : hasMoreOffset;

      let nextCursor: { updated_at: string; tg_chat_id: string } | null = null;
      if (usedKeyset && hasMore && rawBatchLength > 0) {
        const last = data[data.length - 1];
        nextCursor = {
          updated_at: String(last?.updated_at ?? ''),
          tg_chat_id: String(last?.tg_chat_id ?? ''),
        };
      }

      return {
        success: true,
        groups: uniqueGroups,
        total: chatCount,
        totalRows: rowCount,
        hasMore,
        ...(usedKeyset ? { nextCursor } : { nextOffset }),
      };
    }

    const totalTime = Date.now() - startTime;
    if (wantFullList) {
      let rowCount = rawBatchLength;
      let chatCount = uniqueGroups.length;
      const stats = await this.fetchTelegramGroupsListStats(
        userId,
        Boolean(selectedOnly),
        tgAccountFilter,
        tgPhoneColumnMissing,
        includeUnassignedTgPhone,
      );
      if (stats) {
        rowCount = stats.rowCount;
        chatCount = stats.chatCount;
        const cacheKey = [
          userId,
          selectedOnly ? 'selected' : 'all',
          tgAccountFilter ? `tg_${tgAccountFilter}` : '',
          includeUnassignedTgPhone && tgAccountFilter ? 'un' : '',
        ]
          .filter(Boolean)
          .join('_');
        this.groupsCountCache.set(cacheKey, {
          rowCount,
          chatCount,
          timestamp: Date.now(),
        });
      }
      if (rawBatchLength >= 10000 && rowCount > 10000) {
        this.logger.warn(
          `[TG getGroupsFromDb] template full list capped at 10000 rows (user has ${rowCount} matching rows)`,
        );
      }
      this.logger.log(
        `[TG getGroupsFromDb] template full list: ${totalTime}ms, batch=${rawBatchLength} unique=${uniqueGroups.length} totalRows=${rowCount}`,
      );
      return {
        success: true,
        groups: uniqueGroups,
        total: chatCount,
        totalRows: rowCount,
        hasMore: false,
      };
    }

    this.logger.log(
      `[TG getGroupsFromDb] COMPLETE: total=${totalTime}ms, returned=${uniqueGroups.length} (no pagination)`,
    );

    return { success: true, groups: uniqueGroups };
  }

  /** Список уникальных номеров TG по группам пользователя (для фильтра «Номер TG») */
  async getGroupsPhones(userId: string): Promise<string[]> {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from('telegram_groups')
      .select('tg_phone')
      .eq('user_id', userId)
      .not('tg_phone', 'is', null);
    if (error) {
      if (String(error.message ?? '').includes('tg_phone')) {
        return [];
      }
      this.logger.error('[TG getGroupsPhones]', error as any);
      return [];
    }
    const set = new Set<string>();
    for (const row of Array.isArray(data) ? data : []) {
      const p = (row as any)?.tg_phone;
      if (p != null && String(p).trim() !== '') {
        const raw = String(p).trim();
        if (raw.startsWith('tgid:')) {
          set.add(raw.toLowerCase());
        }
      }
    }
    return Array.from(set).sort();
  }

  // ✅ Подсчёт выбранных и всего: уникальные чаты (RPC), при отсутствии RPC — строки БД
  async getSelectedGroupsCount(userId: string) {
    const supabase = this.supabaseService.getClient();
    try {
      const allStats = await this.fetchTelegramGroupsListStats(
        userId,
        false,
        null,
        false,
      );
      const selStats = await this.fetchTelegramGroupsListStats(
        userId,
        true,
        null,
        false,
      );
      if (allStats && selStats) {
        return {
          success: true,
          selected: selStats.chatCount,
          total: allStats.chatCount,
        };
      }

      const { count: selectedCount, error: selectedError } = await supabase
        .from('telegram_groups')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_selected', true);

      if (selectedError) {
        this.logger.error(
          'Supabase count telegram_groups selected error',
          selectedError as any,
        );
        return {
          success: false,
          message: 'supabase_count_error',
          error: selectedError,
        };
      }

      const { count: totalCount, error: totalError } = await supabase
        .from('telegram_groups')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      if (totalError) {
        this.logger.error(
          'Supabase count telegram_groups total error',
          totalError as any,
        );
        return {
          success: false,
          message: 'supabase_count_error',
          error: totalError,
        };
      }

      return {
        success: true,
        selected: selectedCount ?? 0,
        total: totalCount ?? 0,
      };
    } catch (e: any) {
      this.logger.error('Exception in getSelectedGroupsCount', {
        error: e?.message || String(e),
        stack: e?.stack,
        userId,
      });
      return { success: false, message: 'internal_error', error: String(e) };
    }
  }

  async setGroupSelected(params: {
    userId: string;
    tgChatId: string;
    isSelected: boolean;
  }) {
    const supabase = this.supabaseService.getClient();
    const { userId, tgChatId, isSelected } = params;

    const { data, error } = await supabase
      .from('telegram_groups')
      .update({ is_selected: isSelected, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('tg_chat_id', tgChatId)
      .select('tg_chat_id, is_selected')
      .maybeSingle();

    if (error) {
      this.logger.error('Supabase update telegram_groups error', error as any);
      return { success: false, message: 'supabase_update_error', error };
    }
    if (!data) return { success: false, message: 'group_not_found' };

    // Инвалидируем кэш при изменении группы (может измениться is_selected)
    this.clearGroupsCountCacheForUser(userId);

    return { success: true, group: data };
  }

  async setAllGroupsSelected(params: { userId: string; isSelected: boolean }) {
    const supabase = this.supabaseService.getClient();
    const { userId, isSelected } = params;

    const { error } = await supabase
      .from('telegram_groups')
      .update({ is_selected: isSelected, updated_at: new Date().toISOString() })
      .eq('user_id', userId);

    if (error) {
      this.logger.error(
        'Supabase bulk update telegram_groups error',
        error as any,
      );
      return { success: false, message: 'supabase_update_error', error };
    }

    this.clearGroupsCountCacheForUser(userId);

    const counts = await this.getSelectedGroupsCount(userId);
    if (!counts.success) return counts;

    return { success: true, selected: counts.selected, total: counts.total };
  }

  async setGroupSendTime(params: {
    userId: string;
    tgChatId: string;
    sendTime: string | null;
  }) {
    const supabase = this.supabaseService.getClient();
    const { userId, tgChatId, sendTime } = params;
    const normalized = normalizeSendInterval(sendTime);

    const { data, error } = await supabase
      .from('telegram_groups')
      .update({ send_time: normalized, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('tg_chat_id', tgChatId)
      .select('tg_chat_id, send_time')
      .maybeSingle();

    if (error) {
      this.logger.error('Supabase update telegram_groups error', error as any);
      return { success: false, message: 'supabase_update_error', error };
    }
    if (!data) return { success: false, message: 'group_not_found' };

    this.clearGroupsCountCacheForUser(userId);

    return { success: true, group: data };
  }

  /** Сохранить ошибку последней отправки по группе (для отображения в списке групп) */
  async persistSendError(
    userId: string,
    tgChatId: string,
    errorMessage: string,
  ): Promise<void> {
    const supabase = this.supabaseService.getClient();
    const msg = String(errorMessage || '')
      .trim()
      .substring(0, 500);
    const { error } = await supabase
      .from('telegram_groups')
      .update({
        last_send_error: msg || null,
        last_send_error_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('tg_chat_id', tgChatId);
    if (error) {
      this.logger.warn(
        `[TG persistSendError] update failed: ${(error as any)?.message ?? error} (userId=${userId}, tgChatId=${tgChatId})`,
      );
    }
  }

  private async clearSendError(userId: string, tgChatId: string): Promise<void> {
    const supabase = this.supabaseService.getClient();
    const { error } = await supabase
      .from('telegram_groups')
      .update({
        last_send_error: null,
        last_send_error_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('tg_chat_id', tgChatId);
    if (error) {
      this.logger.debug(
        `[TG clearSendError] update failed: ${(error as any)?.message ?? error} (userId=${userId}, tgChatId=${tgChatId})`,
      );
    }
  }

  /** Ошибки, при которых пробуем обновить кэш диалогов и пересобрать peer (один раз). */
  private isTgPeerLikelyStaleError(err: unknown): boolean {
    const msg = String((err as any)?.message ?? err ?? '');
    return (
      /\bCHANNEL_INVALID\b/i.test(msg) ||
      /\bPEER_ID_INVALID\b/i.test(msg) ||
      /\btg_access_hash_missing\b/i.test(msg)
    );
  }

  private isTgHardPeerInvalidError(err: unknown): boolean {
    const msg = String((err as any)?.message ?? err ?? '');
    return /\bCHANNEL_INVALID\b/i.test(msg) || /\bPEER_ID_INVALID\b/i.test(msg);
  }

  private async maybeMarkGroupStaleFromSendError(params: {
    userId: string;
    tgChatId: string;
    error: unknown;
  }): Promise<void> {
    if (!this.isTgHardPeerInvalidError(params.error)) return;
    const keepSelected = this.tgStaleKeepSelected();
    const staleUntilIso = new Date(
      Date.now() + this.tgStaleNotInDialogsQuarantineMs(),
    ).toISOString();
    const nowIso = new Date().toISOString();
    const basePayload: Record<string, any> = {
      updated_at: nowIso,
      last_send_error: String((params.error as any)?.message ?? params.error ?? '')
        .slice(0, 500)
        .trim(),
      last_send_error_at: nowIso,
    };
    if (!keepSelected) basePayload.is_selected = false;
    const supabase = this.supabaseService.getClient();
    let payload: Record<string, any> = {
      ...basePayload,
      quarantine_until: staleUntilIso,
      quarantine_reason: `${this.tgStaleNotInDialogsReasonPrefix()}_send_error`,
    };
    let upd = await supabase
      .from('telegram_groups')
      .update(payload)
      .eq('user_id', params.userId)
      .eq('tg_chat_id', params.tgChatId);
    if (
      upd.error &&
      /quarantine_until|quarantine_reason/i.test(
        String((upd.error as any)?.message ?? upd.error),
      )
    ) {
      payload = { ...basePayload };
      if (!keepSelected) payload.is_selected = false;
      upd = await supabase
        .from('telegram_groups')
        .update(payload)
        .eq('user_id', params.userId)
        .eq('tg_chat_id', params.tgChatId);
    }
    if (upd.error) {
      this.logger.warn(
        `[TG sendToGroup] stale mark from send error failed (userId=${params.userId}, tgChatId=${params.tgChatId}): ${
          (upd.error as any)?.message ?? upd.error
        }`,
      );
      return;
    }
    await this.persistLimitLearningEvent({
      userId: params.userId,
      eventType: 'tg_group_marked_stale',
      groupJid: params.tgChatId,
      label: 'send_error',
      error: String((params.error as any)?.message ?? params.error ?? ''),
    });
  }

  private async backfillGroupAccountKeyFromSuccessfulSend(params: {
    userId: string;
    tgChatId: string;
  }): Promise<void> {
    try {
      const activeKey = await this.getActiveTgAccountKey(params.userId);
      if (!activeKey || !activeKey.startsWith('tgid:')) return;
      const supabase = this.supabaseService.getClient();
      const { error } = await supabase
        .from('telegram_groups')
        .update({
          tg_phone: activeKey,
          updated_at: new Date().toISOString(),
          quarantine_until: null,
          quarantine_reason: null,
        })
        .eq('user_id', params.userId)
        .eq('tg_chat_id', params.tgChatId)
        .is('tg_phone', null);
      if (error) {
        this.logger.debug(
          `[TG backfillGroupAccountKeyFromSuccessfulSend] skip userId=${params.userId}, tgChatId=${params.tgChatId}: ${error.message}`,
        );
      }
    } catch (e: any) {
      this.logger.debug(
        `[TG backfillGroupAccountKeyFromSuccessfulSend] failed userId=${params.userId}, tgChatId=${params.tgChatId}: ${e?.message ?? e}`,
      );
    }
  }

  private async persistLimitLearningEvent(params: {
    userId: string;
    eventType: string;
    groupJid?: string | null;
    label?: string | null;
    error?: string | null;
  }) {
    try {
      await this.supabaseService.getClient().from('limit_learning_events').insert({
        user_id: params.userId,
        channel: 'tg',
        event_type: params.eventType,
        group_jid: params.groupJid ?? null,
        label: params.label ? String(params.label).slice(0, 120) : null,
        error: params.error ? String(params.error).slice(0, 500) : null,
      });
    } catch {
      // best-effort telemetry
    }
  }

  private async refreshTelegramDialogCache(
    client: TelegramClient,
    userId: string,
  ): Promise<void> {
    try {
      const t0 = Date.now();
      await client.getDialogs({});
      this.logger.warn(
        `[TG refreshDialogCache] getDialogs ok userId=${userId} time=${
          Date.now() - t0
        }ms`,
      );
    } catch (e: any) {
      this.logger.warn(
        `[TG refreshDialogCache] failed userId=${userId}: ${e?.message ?? e}`,
      );
    }
  }

  private async buildPeerForTgSend(
    client: TelegramClient,
    rawId: string,
    g: { tg_type?: string | null; tg_access_hash?: string | null } | null,
  ): Promise<any> {
    const tgType = String(g?.tg_type || '');
    const ah = (g as any)?.tg_access_hash;

    if (tgType === 'chat') {
      try {
        return await client.getInputEntity(rawId);
      } catch (e: any) {
        const normalizedChatId = bigInt(rawId).abs();
        this.logger.warn(
          `[TG sendToGroup] getInputEntity(${rawId}) failed for chat peer: ${
            e?.message ?? e
          }, using InputPeerChat(${normalizedChatId.toString()})`,
        );
        return new Api.InputPeerChat({ chatId: normalizedChatId });
      }
    }
    if (tgType === 'channel') {
      try {
        return await client.getInputEntity(rawId);
      } catch (e: any) {
        this.logger.warn(
          `[TG sendToGroup] getInputEntity(${rawId}) failed: ${e?.message ?? e}, using DB access_hash`,
        );
        if (!ah) throw new Error('tg_access_hash_missing');
        const n = bigInt(rawId);
        const mtprotoChannelId = n.lesser(0)
          ? n.negate().minus(bigInt(1000000000000))
          : n;
        return new Api.InputPeerChannel({
          channelId: mtprotoChannelId,
          accessHash: bigInt(String(ah)),
        });
      }
    }
    return /^-?\d+$/.test(rawId) ? bigInt(rawId) : rawId;
  }

  /** Сохраняем актуальный access_hash после удачного getInputEntity, чтобы fallback из БД реже был битым. */
  private async persistPeerMetadataFromResolvedPeer(
    userId: string,
    tgChatId: string,
    peer: any,
  ): Promise<void> {
    try {
      if (!(peer instanceof Api.InputPeerChannel)) return;
      const hashStr = String(peer.accessHash);
      const supabase = this.supabaseService.getClient();
      const { error } = await supabase
        .from('telegram_groups')
        .update({
          tg_access_hash: hashStr,
          tg_type: 'channel',
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('tg_chat_id', tgChatId);
      if (error) {
        this.logger.debug(
          `[TG persistPeerMetadata] update failed: ${(error as any)?.message ?? error}`,
        );
      }
    } catch (e: any) {
      this.logger.debug(
        `[TG persistPeerMetadata] exception: ${e?.message ?? e}`,
      );
    }
  }

  private async sendTgPayloadWithPeerRefreshRetry(params: {
    userId: string;
    rawId: string;
    client: TelegramClient;
    reloadGroupRow: () => Promise<{
      tg_type?: string | null;
      tg_access_hash?: string | null;
    } | null>;
    getPeer: () => any;
    setPeer: (p: any) => void;
    send: (peer: any) => Promise<unknown>;
  }): Promise<void> {
    const run = async () => {
      await params.send(params.getPeer());
    };
    try {
      await run();
    } catch (e: any) {
      if (!this.isTgPeerLikelyStaleError(e)) throw e;
      await this.persistLimitLearningEvent({
        userId: params.userId,
        eventType: 'tg_peer_refresh_retry_started',
        groupJid: params.rawId,
        error: e?.message ?? String(e),
      });
      this.logger.warn(
        `[TG sendToGroup] peer stale — refresh dialogs + retry once (userId=${params.userId}, tgChatId=${params.rawId})`,
      );
      await this.refreshTelegramDialogCache(params.client, params.userId);
      const g2 = await params.reloadGroupRow();
      try {
        const p2 = await this.buildPeerForTgSend(
          params.client,
          params.rawId,
          g2,
        );
        params.setPeer(p2);
        await this.persistPeerMetadataFromResolvedPeer(
          params.userId,
          params.rawId,
          p2,
        );
      } catch (rebuildErr: any) {
        await this.persistLimitLearningEvent({
          userId: params.userId,
          eventType: 'tg_peer_refresh_retry_failed',
          groupJid: params.rawId,
          label: 'peer_rebuild_failed',
          error: rebuildErr?.message ?? String(rebuildErr),
        });
        throw rebuildErr;
      }
      try {
        await run();
        await this.persistLimitLearningEvent({
          userId: params.userId,
          eventType: 'tg_peer_refresh_retry_success',
          groupJid: params.rawId,
        });
      } catch (retryErr: any) {
        await this.maybeMarkGroupStaleFromSendError({
          userId: params.userId,
          tgChatId: params.rawId,
          error: retryErr,
        });
        await this.persistLimitLearningEvent({
          userId: params.userId,
          eventType: 'tg_peer_refresh_retry_failed',
          groupJid: params.rawId,
          label: 'retry_send_failed',
          error: retryErr?.message ?? String(retryErr),
        });
        throw retryErr;
      }
    }
  }

  // ---------- send ----------
  async sendToGroup(
    userId: string,
    tgChatId: string,
    payload: {
      text: string;
      mediaUrl?: string | null;
      sendMediaAsFile?: boolean;
    },
  ) {
    const sendStartTime = Date.now();
    if (!(await this.ensureSessionLease(userId, 'send_to_group'))) {
      throw new Error('telegram_session_busy');
    }
    const client = await this.getConnectedClient(userId);
    if (!client) {
      this.logger.warn(
        `[TG sendToGroup] FAILED: not connected (userId=${userId}, tgChatId=${tgChatId})`,
      );
      throw new Error('telegram_not_connected');
    }

    const rawId = String(tgChatId || '').trim();
    if (!rawId) throw new Error('tg_chat_id_empty');

    const supabase = this.supabaseService.getClient();
    const { data: g, error: gErr } = await supabase
      .from('telegram_groups')
      .select('tg_chat_id, tg_type, tg_access_hash')
      .eq('user_id', userId)
      .eq('tg_chat_id', rawId)
      .maybeSingle();

    if (gErr) throw new Error(`supabase_telegram_groups_error:${gErr.message}`);

    let peer: any = await this.buildPeerForTgSend(client, rawId, g);
    await this.persistPeerMetadataFromResolvedPeer(userId, rawId, peer);

    const reloadGroupRow = async () => {
      const { data } = await supabase
        .from('telegram_groups')
        .select('tg_chat_id, tg_type, tg_access_hash')
        .eq('user_id', userId)
        .eq('tg_chat_id', rawId)
        .maybeSingle();
      return data;
    };

    const runWithPeerRetry = (send: (p: any) => Promise<unknown>) =>
      this.sendTgPayloadWithPeerRefreshRetry({
        userId,
        rawId,
        client,
        reloadGroupRow,
        getPeer: () => peer,
        setPeer: (p: any) => {
          peer = p;
        },
        send,
      });

    const text = payload.text || '';
    const textForTg = templateMarkdownToTelegramHtml(text);
    const mediaUrl = String(payload.mediaUrl || '').trim();
    const sendMediaAsFile = payload.sendMediaAsFile === true;

    if (!mediaUrl) {
      try {
        await runWithPeerRetry((p) =>
          client.sendMessage(p, {
            message: textForTg,
            parseMode: 'html',
          }),
        );
        await this.backfillGroupAccountKeyFromSuccessfulSend({
          userId,
          tgChatId: rawId,
        });
        await this.clearSendError(userId, rawId);
        const sendTime = Date.now() - sendStartTime;
        this.logger.log(
          `[TG sendToGroup] SUCCESS: text only (userId=${userId}, tgChatId=${tgChatId}, time=${sendTime}ms)`,
        );
        if (sendTime > 5000) {
          this.logger.warn(`[TG sendToGroup] SLOW SEND: ${sendTime}ms`);
        }
      } catch (e: any) {
        const sendTime = Date.now() - sendStartTime;
        this.logger.error(
          `[TG sendToGroup] FAILED: ${e?.message || String(e)} (userId=${userId}, tgChatId=${tgChatId}, time=${sendTime}ms)`,
        );
        throw e;
      }
      return;
    }

    // Быстрый путь: если это картинка и пользователь НЕ просил "как файл",
    // пробуем отправить по URL как фото (InputMediaPhotoExternal).
    const isImageByUrl = isProbablyImage('', mediaUrl);
    if (!sendMediaAsFile && isImageByUrl) {
      try {
        await runWithPeerRetry((p) =>
          client.sendFile(p, {
            file: mediaUrl,
            caption: textForTg,
            parseMode: 'html',
            forceDocument: false,
          }),
        );
        await this.backfillGroupAccountKeyFromSuccessfulSend({
          userId,
          tgChatId: rawId,
        });
        await this.clearSendError(userId, rawId);
        const sendTime = Date.now() - sendStartTime;
        this.logger.log(
          `[TG sendToGroup] SUCCESS: image media by URL (userId=${userId}, tgChatId=${tgChatId}, url=${mediaUrl.substring(
            0,
            100,
          )}..., time=${sendTime}ms)`,
        );
        if (sendTime > 10_000) {
          this.logger.warn(`[TG sendToGroup] SLOW MEDIA SEND: ${sendTime}ms`);
        }
        return;
      } catch (e: any) {
        // Если не удалось отправить по URL — логируем и падаем в обычный поток с загрузкой.
        this.logger.warn(
          `[TG sendToGroup] IMAGE_URL_SEND_FAILED: ${
            e?.message || String(e)
          }, url=${mediaUrl.substring(0, 100)}..., falling back to download`,
        );
      }
    }

    // скачиваем медиа (используется для "как файл" и для видео/аудио/unknown)
    let buf: Buffer;
    let contentType = '';
    try {
      const r = await fetchWithTimeout(mediaUrl, 25_000);
      buf = r.buf;
      contentType = r.contentType;
    } catch (e: any) {
      // если медиа не скачалось — отправим хотя бы текст
      this.logger.warn(
        `[TG sendToGroup] MEDIA DOWNLOAD FAILED: ${
          e?.message || String(e)
        }, url=${mediaUrl.substring(0, 100)}..., falling back to text only`,
      );
      await runWithPeerRetry((p) =>
        client.sendMessage(p, { message: textForTg, parseMode: 'html' }),
      );
      await this.backfillGroupAccountKeyFromSuccessfulSend({
        userId,
        tgChatId: rawId,
      });
      await this.clearSendError(userId, rawId);
      const sendTime = Date.now() - sendStartTime;
      this.logger.log(
        `[TG sendToGroup] SUCCESS: text fallback (userId=${userId}, tgChatId=${tgChatId}, time=${sendTime}ms)`,
      );
      return;
    }

    const isVideo = isProbablyVideo(contentType, mediaUrl);
    const isImage = isProbablyImage(contentType, mediaUrl);
    const isAudio = isProbablyAudio(contentType, mediaUrl);
    const sendAsPhoto =
      isImage || (!isVideo && !isAudio && isProbablyImage('', mediaUrl));

    try {
      if (sendMediaAsFile) {
        // Если явно запрошена отправка как файл - отправляем как документ
        await runWithPeerRetry((p) =>
          client.sendFile(p, {
            file: bufferAsTelegramUpload(buf, mediaUrl, contentType, 'generic'),
            caption: textForTg,
            parseMode: 'html',
            forceDocument: true,
          }),
        );
        await this.backfillGroupAccountKeyFromSuccessfulSend({
          userId,
          tgChatId: rawId,
        });
        await this.clearSendError(userId, rawId);
        const sendTime = Date.now() - sendStartTime;
        this.logger.log(
          `[TG sendToGroup] SUCCESS: document (userId=${userId}, tgChatId=${tgChatId}, size=${buf.length}, time=${sendTime}ms)`,
        );
        return;
      }

      // Если sendMediaAsFile = false, отправляем как медиа (не как файл)
      if (isVideo) {
        const videoFile = bufferAsTelegramUpload(
          buf,
          mediaUrl,
          contentType,
          'video',
        );
        await runWithPeerRetry((p) =>
          client.sendFile(p, {
            file: videoFile,
            caption: textForTg,
            parseMode: 'html',
            forceDocument: false,
            supportsStreaming: videoSupportsStreaming(videoFile.name),
          }),
        );
        await this.backfillGroupAccountKeyFromSuccessfulSend({
          userId,
          tgChatId: rawId,
        });
        await this.clearSendError(userId, rawId);
        const sendTime = Date.now() - sendStartTime;
        this.logger.log(
          `[TG sendToGroup] SUCCESS: video media (userId=${userId}, tgChatId=${tgChatId}, size=${buf.length}, time=${sendTime}ms)`,
        );
        if (sendTime > 10_000) {
          this.logger.warn(`[TG sendToGroup] SLOW MEDIA SEND: ${sendTime}ms`);
        }
        return;
      }

      if (isImage || sendAsPhoto) {
        await runWithPeerRetry((p) =>
          client.sendFile(p, {
            file: bufferAsTelegramUpload(buf, mediaUrl, contentType, 'image'),
            caption: textForTg,
            parseMode: 'html',
            forceDocument: false,
          }),
        );
        await this.backfillGroupAccountKeyFromSuccessfulSend({
          userId,
          tgChatId: rawId,
        });
        await this.clearSendError(userId, rawId);
        const sendTime = Date.now() - sendStartTime;
        this.logger.log(
          `[TG sendToGroup] SUCCESS: image media (userId=${userId}, tgChatId=${tgChatId}, size=${buf.length}, time=${sendTime}ms)`,
        );
        if (sendTime > 10_000) {
          this.logger.warn(`[TG sendToGroup] SLOW MEDIA SEND: ${sendTime}ms`);
        }
        return;
      }

      if (isAudio) {
        await runWithPeerRetry((p) =>
          client.sendFile(p, {
            file: bufferAsTelegramUpload(buf, mediaUrl, contentType, 'audio'),
            caption: textForTg,
            parseMode: 'html',
            forceDocument: false,
            voiceNote: true,
          }),
        );
        await this.backfillGroupAccountKeyFromSuccessfulSend({
          userId,
          tgChatId: rawId,
        });
        const sendTime = Date.now() - sendStartTime;
        this.logger.log(
          `[TG sendToGroup] SUCCESS: audio media (userId=${userId}, tgChatId=${tgChatId}, size=${buf.length}, time=${sendTime}ms)`,
        );
        return;
      }

      // Если тип медиа неизвестен, но sendMediaAsFile = false, отправляем как медиа (не как файл)
      // Telegram API попытается определить тип автоматически
      this.logger.warn(
        `[TG sendToGroup] UNKNOWN MEDIA TYPE: contentType=${contentType}, url=${mediaUrl.substring(
          0,
          100,
        )}..., sending as media (forceDocument=false)`,
      );
      await runWithPeerRetry((p) =>
        client.sendFile(p, {
          file: bufferAsTelegramUpload(buf, mediaUrl, contentType, 'generic'),
          caption: textForTg,
          parseMode: 'html',
          forceDocument: false,
        }),
      );
      await this.backfillGroupAccountKeyFromSuccessfulSend({
        userId,
        tgChatId: rawId,
      });
      await this.clearSendError(userId, rawId);
      const sendTime = Date.now() - sendStartTime;
      this.logger.log(
        `[TG sendToGroup] SUCCESS: media (unknown type, sent as media) (userId=${userId}, tgChatId=${tgChatId}, size=${buf.length}, time=${sendTime}ms)`,
      );
    } catch (e: any) {
      const sendTime = Date.now() - sendStartTime;
      this.logger.error(
        `[TG sendToGroup] FAILED: ${
          e?.message || String(e)
        } (userId=${userId}, tgChatId=${tgChatId}, mediaUrl=${mediaUrl.substring(
          0,
          100,
        )}..., time=${sendTime}ms)`,
      );
      throw e;
    }
  }

  // ---------- helper: connect if session exists ----------
  private async getConnectedClient(
    userId: string,
  ): Promise<TelegramClient | null> {
    // lock, so two parallel requests don't connect with same session
    return this.withLock(userId, async () => {
      const existing = this.sessions.get(userId);
      if (existing) {
        if (!(await this.ensureSessionLease(userId, 'reuse_connected_client'))) {
          return null;
        }
        this.touchSessionLease(userId);
        await this.publishRuntimeState({
          userId,
          status: 'connected',
        });
        return existing;
      }

      if (!(await this.ensureSessionLease(userId, 'get_connected_client'))) {
        return null;
      }

      const supabase = this.supabaseService.getClient();
      const { data: user, error } = await supabase
        .from('users')
        .select('id, tg_session')
        .eq('id', userId)
        .maybeSingle();

      if (error || !(user as any)?.tg_session) {
        await this.runtimeCoordinationService
          .releaseMessengerLease(this.channel, userId)
          .catch(() => undefined);
        return null;
      }

      try {
        await this.connectFromSavedSessionNoLock(
          userId,
          String((user as any).tg_session),
        );
        this.touchSessionLease(userId);
        return this.sessions.get(userId) ?? null;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        this.logger.warn(`TG auto-connect failed: ${msg}`);

        if (msg.includes('AUTH_KEY_DUPLICATED')) {
          await supabase
            .from('users')
            .update({ tg_session: null })
            .eq('id', userId);
        }

        await this.publishRuntimeState({
          userId,
          status: 'not_connected',
          lastError: msg,
        });
        await this.runtimeCoordinationService
          .releaseMessengerLease(this.channel, userId)
          .catch(() => undefined);

        return null;
      }
    });
  }
}
