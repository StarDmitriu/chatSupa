// backend/src/whatsapp/whatsapp.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
} from '@whiskeysockets/baileys';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Boom } from '@hapi/boom';
import * as path from 'path';
import * as fs from 'fs';
import pino from 'pino';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  normalizePhoneE164,
  normalizePhoneForStorage,
} from '../utils/phone.util';
import { Buffer } from 'buffer';
import {
  RuntimeCoordinationService,
  type MessengerChannel,
} from '../runtime/runtime-coordination.service';
import {
  runtimeCapabilitiesLabel,
  runtimeHasCapability,
} from '../runtime/runtime-role';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Сжатая строка для логов: Boom/Error из Baileys `lastDisconnect.error`. */
function formatWaLastDisconnectDetail(err: unknown): string {
  if (err == null) return 'lastDisconnect=none';
  if (typeof err !== 'object') return String(err).slice(0, 240);
  const e = err as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof e.message === 'string' && e.message.trim()) {
    parts.push(`message=${e.message.trim()}`);
  }
  const out = e.output as Record<string, unknown> | undefined;
  if (out && typeof out.statusCode === 'number') {
    parts.push(`output.statusCode=${out.statusCode}`);
  }
  const payload = out?.payload;
  if (payload && typeof payload === 'object') {
    try {
      const s = JSON.stringify(payload);
      if (s && s !== '{}' && s.length <= 500) {
        parts.push(`payload=${s}`);
      }
    } catch {
      /* ignore */
    }
  }
  if ('data' in e && e.data != null) {
    try {
      const s =
        typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
      if (s && s.length <= 400) {
        parts.push(`data=${s}`);
      }
    } catch {
      /* ignore */
    }
  }
  if (typeof e.name === 'string' && e.name !== 'Error') {
    parts.push(`name=${e.name}`);
  }
  return parts.length ? parts.join(' | ') : 'no detail';
}

function isProbablyVideo(contentType: string, url: string) {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('video/')) return true;
  const u = (url || '').toLowerCase();
  return (
    u.endsWith('.mp4') ||
    u.endsWith('.mov') ||
    u.endsWith('.webm') ||
    u.endsWith('.mkv')
  );
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        // иногда помогает против “капризных” хостингов
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`media_fetch_failed_${res.status}: ${txt.slice(0, 120)}`);
    }

    const contentType = res.headers.get('content-type') || '';
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);
    return { buf, contentType };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('media_fetch_timeout');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Приводит разметку шаблона к формату WhatsApp.
 * WA поддерживает только *жирный* _курсив_ ~зачёркнутый~ `код`; подчёркивания нет.
 * У нас: ~ = подчёркивание, ~~ = зачёркивание. Итог: ~~ → ~ для WA, ~...~ убираем.
 */
function templateMarkdownToWhatsAppText(text: string): string {
  if (!text) return '';
  const any = '[\\s\\S]+?';
  const normalized = text
    // У нас: ~~зачёркнутый~~, ~подчёркнутый~. В WA: ~зачёркнутый~, подчёркивания нет.
    .replace(new RegExp(`~~(${any})~~`, 'g'), '~$1~')
    .replace(new RegExp(`~(${any})~`, 'g'), '$1');

  // WhatsApp-форматирование не срабатывает, если сразу после открывающего маркера
  // или перед закрывающим есть пробельные символы (включая NBSP).
  // Пример: "* текст*" или "*текст *" будет показано со звёздочками.
  const tightenInlineMarkers = (s: string, marker: string) => {
    const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${esc}([\\s\\S]+?)${esc}`, 'g');
    return s.replace(re, (m, inner: string) => {
      const raw = String(inner ?? '');
      const leadMatch = raw.match(/^[\s\u00A0]+/);
      const trailMatch = raw.match(/[\s\u00A0]+$/);
      const lead = leadMatch ? leadMatch[0].replace(/\u00A0/g, ' ') : '';
      const trail = trailMatch ? trailMatch[0].replace(/\u00A0/g, ' ') : '';
      const core = raw.replace(/^[\s\u00A0]+/, '').replace(/[\s\u00A0]+$/, '');
      if (!core) return m;
      return `${lead}${marker}${core}${marker}${trail}`;
    });
  };

  let s = normalized;
  // Порядок не критичен, маркеры разные, но обрабатываем все WA-поддерживаемые.
  s = tightenInlineMarkers(s, '*');
  s = tightenInlineMarkers(s, '_');
  s = tightenInlineMarkers(s, '~');
  s = tightenInlineMarkers(s, '`');
  return s;
}

/** Per-group send_time для WhatsApp отключён — ритм только из настроек рассылки. */
function normalizeWaGroupSendTime(_v: any): string | null {
  return null;
}

export type WhatsappStatus =
  | 'not_connected'
  | 'connecting'
  | 'pending_qr'
  | 'connected'
  | 'temporary_network_issue'
  | 'error';

export interface SessionInfo {
  status: WhatsappStatus;
  qr?: string;
  lastError?: string;
  stateSinceAt?: string | null;
  stateDurationSec?: number | null;
  disconnectSinceAt?: string | null;
  disconnectDurationSec?: number | null;
  retryAttempt?: number;
  retryMax?: number;
  nextRetryAt?: string | null;
  networkIssue?: boolean;
  wsReachability?: 'unknown' | 'ok' | 'degraded' | 'down';
  wsLastCheckAt?: string | null;
  wsRttMs?: number | null;
  wsError?: string | null;
  proxyEnabled?: boolean;
  proxyActive?: boolean;
  proxyLabel?: string | null;
  proxyBypassUntil?: string | null;
}

type WaProxySettings = {
  enabled: boolean;
  proxyUrl: string | null;
  failOpenDirect: boolean;
  maxConsecutiveFailures: number;
};

type WaSyncDiagnostics = {
  rows: Array<Record<string, any>>;
  entriesCount: number;
  apiTime: number;
  apiMissingSubjectIds: string[];
  finalMissingSubjectIds: string[];
  fallbackSubjectIds: string[];
};

type CachedWaGroupMetadata = {
  metadata: any;
  ts: number;
};

type NormalizedWaGroupMetadata = {
  subject: string | null;
  participantsCount: number | null;
  isAnnouncement: boolean | null;
  isRestricted: boolean | null;
};

type WaRepairDiagnostics = {
  rows: Array<Record<string, any>>;
  attempted: number;
  repairedSubjectCount: number;
  repairedParticipantsCount: number;
  remainingMissingSubject: number;
  failures: number;
};

type WaGroupMetadataFetchResult = {
  metadata: any | null;
  errorMessage: string | null;
};

type InternalSession = {
  info: SessionInfo;
  sock?: WASocket;
  starting?: Promise<void>;
  restartAttempts: number;
  restartTimer?: NodeJS.Timeout;
  lastQrAt?: number;
  lastChangeAt: number;
  disconnectStartedAt?: number;
  lastReachabilityProbeAt?: number;
  proxySettings?: WaProxySettings;
  proxyConsecutiveTimeouts?: number;
  proxyBypassUntil?: number;
  leaseRenewTimer?: NodeJS.Timeout;
  lastLeaseTouchAt?: number;
};

function withJitter(ms: number, jitterMs = 1000): number {
  const jitter = Math.floor(Math.random() * Math.max(1, jitterMs + 1));
  return ms + jitter;
}

type WaDisconnectAuditContext = {
  requesterId: string;
  source: string;
  ip: string | null;
  userAgent: string | null;
};

type RateLearning = {
  hitsTimestamps: number[]; // timestamps (ms) in sliding window
  lastLabel?: string;
  lastError?: string;
};

function truncateForDb(value: string, maxLen: number) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly channel: MessengerChannel = 'wa';
  private readonly sessionLeaseTtlMs = Math.max(
    Number(process.env.WA_SESSION_LEASE_TTL_MS || 45_000) || 45_000,
    15_000,
  );
  private readonly sessionLeaseRenewEveryMs = Math.max(
    Number(process.env.WA_SESSION_LEASE_RENEW_MS || 15_000) || 15_000,
    5_000,
  );
  private readonly sessionIdleReleaseMs = Math.max(
    Number(process.env.WA_SESSION_IDLE_RELEASE_MS || 5 * 60_000) ||
      5 * 60_000,
    60_000,
  );

  private sessions = new Map<string, InternalSession>();

  private supabase: SupabaseClient;

  // Кэш для общего количества групп (userId -> {count, timestamp})
  // Отдельный кэш для выбранных групп (userId_selected -> {count, timestamp})
  private groupsCountCache = new Map<
    string,
    { count: number; timestamp: number }
  >();
  private readonly CACHE_TTL_MS = 30_000; // 30 секунд кэш

  // Кэш ссылок на аватарки групп (URL может быть временным — поэтому TTL ограниченный)
  private groupAvatarCache = new Map<
    string,
    { url: string | null; ts: number }
  >();
  private groupAvatarInFlight = new Map<string, Promise<string | null>>();
  private readonly GROUP_AVATAR_TTL_MS = 60 * 60 * 1000; // 1 час для успешных URL
  private readonly GROUP_AVATAR_NULL_TTL_MS = 2 * 60 * 1000; // 2 минуты для null, чтобы были повторы
  private groupMetadataCache = new Map<string, CachedWaGroupMetadata>();
  private groupMetadataInFlight = new Map<string, Promise<any | null>>();
  private readonly GROUP_METADATA_TTL_MS = 10 * 60 * 1000; // 10 минут
  // Важно: слишком высокая параллельность groupMetadata быстро приводит к rate-overlimit,
  // после чего WA-сессия может быть сброшена (stream error). Держим консервативно.
  private readonly GROUP_METADATA_REPAIR_CONCURRENCY = 2;
  private groupMetadataRefreshAt = new Map<string, number>();
  private readonly GROUP_METADATA_EVENT_REFRESH_COOLDOWN_MS = 60 * 1000;
  private backgroundHydrationJobs = new Map<string, Promise<void>>();
  private backgroundHydrationTimers = new Map<string, NodeJS.Timeout>();
  private readonly GROUP_METADATA_BACKGROUND_DELAY_MS = 2500;
  private readonly GROUP_METADATA_BACKGROUND_BATCH_SIZE = 40;
  private readonly GROUP_METADATA_BACKGROUND_RETRY_DELAY_MS = 30_000;
  private readonly GROUP_METADATA_BACKGROUND_START_DELAY_MS = 5_000;
  private readonly GROUP_METADATA_BACKGROUND_RATE_LIMIT_THRESHOLD = 3;
  private readonly SEND_RATE_LIMIT_RETRY_DELAY_MS = 30_000;
  private readonly WA_MEDIA_UPLOAD_RETRY_ATTEMPTS = 4;
  private readonly WA_MEDIA_UPLOAD_RETRY_DELAY_MS = 6_000;
  private readonly WA_TRANSIENT_RETRY_MAX_ATTEMPTS = 10;
  private readonly WA_REACHABILITY_PROBE_COOLDOWN_MS = 30_000;
  private waPhoneColumnAvailable: boolean | null = null;

  // =========================
  // LIMIT LEARNING (in-memory)
  // =========================
  private readonly rateLearningWindowMs = 5 * 60_000; // 5 мин
  private readonly waRateLearningByUser = new Map<string, RateLearning>();

  private recordWaSendRateLimitHit(params: {
    userId: string;
    label: string;
    errorMessage: string;
  }) {
    const { userId, label, errorMessage } = params;
    const now = Date.now();
    const existing =
      this.waRateLearningByUser.get(userId) ??
      ({
        hitsTimestamps: [],
        lastLabel: undefined,
        lastError: undefined,
      } as RateLearning);

    // prune old
    existing.hitsTimestamps = existing.hitsTimestamps.filter(
      (t) => now - t <= this.rateLearningWindowMs,
    );
    existing.hitsTimestamps.push(now);
    existing.lastLabel = label;
    existing.lastError = errorMessage;

    this.waRateLearningByUser.set(userId, existing);
    const hits5m = existing.hitsTimestamps.length;

    this.logger.warn(
      `[LIMIT LEARN][WA] rate-limit hit userId=${userId} hits5m=${hits5m} label=${label} error="${String(
        errorMessage || '',
      ).slice(0, 120)}" -> retryDelayMs=${this.SEND_RATE_LIMIT_RETRY_DELAY_MS}`,
    );

    // Persistent store (best-effort): keep for weekly analysis.
    // NOTE: insert must not break sending; swallow errors.
    const insertPromise = (this.supabase as any)
      .from('limit_learning_events')
      .insert({
        user_id: userId,
        channel: 'wa',
        event_type: 'wa_rate_limit',
        seconds: Math.round(this.SEND_RATE_LIMIT_RETRY_DELAY_MS / 1000),
        label: truncateForDb(label, 120) || null,
        error: truncateForDb(errorMessage, 500) || null,
      });

    void Promise.resolve(insertPromise)
      .then((res: any) => {
        const err = res?.error;
        if (err) {
          this.logger.warn(
            `[LIMIT LEARN][WA] db insert failed userId=${userId}: ${
              err.message || String(err)
            }`,
          );
        }
      })
      .catch(() => undefined);
  }

  private isMissingWaPhoneColumnError(error: any): boolean {
    const msg = String((error as any)?.message ?? '');
    return msg.includes('wa_phone');
  }

  private stripWaPhoneColumn(rows: Array<Record<string, any>>) {
    return rows.map(({ wa_phone, ...rest }) => rest);
  }

  private clearGroupsCountCacheForUser(userId: string) {
    const prefix = `${userId}_`;
    for (const key of this.groupsCountCache.keys()) {
      if (key === userId || key.startsWith(prefix)) {
        this.groupsCountCache.delete(key);
      }
    }
  }

  private clearGroupAvatarCache(userId: string) {
    const prefix = `${userId}:`;
    for (const key of this.groupAvatarCache.keys()) {
      if (key.startsWith(prefix)) {
        this.groupAvatarCache.delete(key);
      }
    }
    for (const key of this.groupAvatarInFlight.keys()) {
      if (key.startsWith(prefix)) {
        this.groupAvatarInFlight.delete(key);
      }
    }
  }

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly runtimeCoordinationService: RuntimeCoordinationService,
  ) {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY,
    );
  }

  private stopLeaseRenewTimer(session: InternalSession) {
    if (session.leaseRenewTimer) {
      clearInterval(session.leaseRenewTimer);
      session.leaseRenewTimer = undefined;
    }
  }

  private stopRestartTimer(session: InternalSession) {
    if (session.restartTimer) {
      clearTimeout(session.restartTimer);
      session.restartTimer = undefined;
    }
  }

  private async publishSessionState(userId: string, s?: InternalSession) {
    const session = s ?? this.sessions.get(userId);
    if (!session) {
      await this.runtimeCoordinationService
        .clearMessengerState(this.channel, userId)
        .catch(() => undefined);
      return;
    }

    await this.runtimeCoordinationService
      .writeMessengerState(this.channel, userId, {
        status: session.info.status,
        qr: session.info.qr ?? null,
        lastError: session.info.lastError ?? null,
        stateSinceAt: session.info.stateSinceAt ?? null,
        disconnectSinceAt: session.info.disconnectSinceAt ?? null,
        retryAttempt: session.info.retryAttempt ?? null,
        retryMax: session.info.retryMax ?? null,
        nextRetryAt: session.info.nextRetryAt ?? null,
        runtimeRole: runtimeCapabilitiesLabel(),
      })
      .catch(() => undefined);
  }

  private async releaseConnectedSessionOwnership(
    userId: string,
    reason: string,
  ): Promise<void> {
    const s = this.sessions.get(userId);
    if (!s) {
      await this.runtimeCoordinationService
        .releaseMessengerLease(this.channel, userId)
        .catch(() => undefined);
      return;
    }

    this.stopLeaseRenewTimer(s);
    this.stopRestartTimer(s);
    try {
      s.sock?.end?.(new Error(`release_connected_session_ownership:${reason}`));
    } catch {}
    s.sock = undefined;
    s.starting = undefined;
    s.lastLeaseTouchAt = 0;
    s.info = { status: 'not_connected' };
    s.lastChangeAt = Date.now();
    await this.publishSessionState(userId, s);
    await this.runtimeCoordinationService
      .releaseMessengerLease(this.channel, userId)
      .catch(() => undefined);
    this.logger.log(`[WA lease] released owner userId=${userId} reason=${reason}`);
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
        `[WA lease] busy userId=${userId} reason=${reason} owner=${lease.ownerInstanceId ?? 'unknown'}`,
      );
      return false;
    }

    const s = this.ensureSession(userId);
    s.lastLeaseTouchAt = Date.now();
    if (!s.leaseRenewTimer) {
      s.leaseRenewTimer = setInterval(() => {
        const latest = this.sessions.get(userId);
        if (!latest) return;
        const idleForMs = Date.now() - (latest.lastLeaseTouchAt ?? 0);
        if (idleForMs >= this.sessionIdleReleaseMs) {
          this.logger.log(
            `[WA lease] idle release userId=${userId} idleMs=${idleForMs}`,
          );
          this.stopLeaseRenewTimer(latest);
          if (latest.sock) {
            try {
              latest.sock.end?.(new Error('idle_release'));
            } catch {}
            latest.sock = undefined;
          }
          latest.info = { status: 'not_connected' };
          latest.lastChangeAt = Date.now();
          void this.publishSessionState(userId, latest);
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
    }
    return true;
  }

  /**
   * После реконнекта WA — вернуть в очередь paused jobs (без CAMPAIGN_REPEAT_*).
   * CampaignsService подгружаем через dynamic import, иначе цикл campaigns↔whatsapp ломает DI (WhatsappService = undefined).
   * Задержка по умолчанию 3s: не бить по event loop сразу в тике `open` (меньше шанс 408 у соседних сессий).
   * Переопределение: WA_POST_CONNECT_RESUME_DELAY_MS (2000–15000).
   */
  private scheduleCampaignResumeAfterWaConnected(userId: string) {
    if (!runtimeHasCapability('worker')) {
      return;
    }
    const raw = Number(process.env.WA_POST_CONNECT_RESUME_DELAY_MS);
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
              .autoResumeDisconnectedJobsForUser(userId, { channelHint: 'wa' })
              .then((r) => {
                if (r.resumed > 0) {
                  this.logger.log(
                    `[WA] post-connect auto-resume: ${r.resumed} job(s), ${r.campaigns} campaign(s) userId=${userId}`,
                  );
                }
              })
              .catch((e: any) =>
                this.logger.warn(
                  `[WA] autoResumeDisconnectedJobsForUser failed userId=${userId}: ${e?.message ?? e}`,
                ),
              );

            void campaigns
              .autoWakeConnectivityRetryJobsForUser(userId, {
                channelHint: 'wa',
              })
              .then((r) => {
                if (r.woken > 0) {
                  this.logger.log(
                    `[WA] post-connect fast-wake: ${r.woken} retry job(s), ${r.campaigns} campaign(s) userId=${userId}`,
                  );
                }
              })
              .catch((e: any) =>
                this.logger.warn(
                  `[WA] autoWakeConnectivityRetryJobsForUser failed userId=${userId}: ${e?.message ?? e}`,
                ),
              );
          } catch (e: any) {
            this.logger.debug(
              `[WA] CampaignsService not available for auto-resume: ${e?.message ?? e}`,
            );
          }
        })
        .catch((e: any) =>
          this.logger.warn(
            `[WA] campaigns.module load failed (auto-resume) userId=${userId}: ${e?.message ?? e}`,
          ),
        );
    }, delayMs);
  }

  private getAuthDir(userId: string) {
    return path.join(process.cwd(), 'wa_auth', userId);
  }

  private getGroupMetadataCacheKey(userId: string, jid: string) {
    return `${userId}:${jid}`;
  }

  private getCachedGroupMetadata(userId: string, jid: string) {
    const key = this.getGroupMetadataCacheKey(userId, jid);
    const cached = this.groupMetadataCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.ts > this.GROUP_METADATA_TTL_MS) {
      this.groupMetadataCache.delete(key);
      return null;
    }
    return cached.metadata;
  }

  private setCachedGroupMetadata(userId: string, jid: string, metadata: any) {
    const key = this.getGroupMetadataCacheKey(userId, jid);
    this.groupMetadataCache.set(key, { metadata, ts: Date.now() });
  }

  private clearGroupMetadataCache(userId: string) {
    const prefix = `${userId}:`;
    for (const key of this.groupMetadataCache.keys()) {
      if (key.startsWith(prefix)) this.groupMetadataCache.delete(key);
    }
    for (const key of this.groupMetadataInFlight.keys()) {
      if (key.startsWith(prefix)) this.groupMetadataInFlight.delete(key);
    }
    for (const key of this.groupMetadataRefreshAt.keys()) {
      if (key.startsWith(prefix)) this.groupMetadataRefreshAt.delete(key);
    }
  }

  private clearBackgroundHydration(userId: string) {
    const timer = this.backgroundHydrationTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.backgroundHydrationTimers.delete(userId);
    }
    this.backgroundHydrationJobs.delete(userId);
  }

  private isPlaceholderSubject(subject: string | null | undefined): boolean {
    if (!subject) return false;
    const s = String(subject).trim();
    return s.startsWith('Без названия (') && s.endsWith(')');
  }

  private extractGroupSubject(metadata: any): string | null {
    const pickText = (value: any): string | null => {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (!value || typeof value !== 'object') return null;

      const nestedCandidates = [
        value?.text,
        value?.title,
        value?.name,
        value?.subject,
        value?.displayName,
        value?.formattedName,
      ];

      for (const candidate of nestedCandidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim();
        }
      }

      return null;
    };

    const candidates = [
      metadata?.subject,
      metadata?.name,
      metadata?.groupName,
      metadata?.displayName,
      metadata?.title,
      metadata?.subjectText,
      metadata?.notify,
      metadata?.pushName,
      metadata?.conversation,
      metadata?.attrs?.subject,
      metadata?.attrs?.displayName,
      metadata?.groupMetadata?.subject,
      metadata?.groupMetadata?.name,
      metadata?.groupMetadata?.title,
      metadata?.groupMetadata?.notify,
      metadata?.groupMetadata?.conversation,
      metadata?.subjectName,
    ];

    for (const candidate of candidates) {
      const text = pickText(candidate);
      if (text) {
        return text;
      }
    }

    return null;
  }

  private normalizeGroupMetadata(metadata: any): NormalizedWaGroupMetadata {
    const subject = this.extractGroupSubject(metadata);

    const participantsCount = Array.isArray(metadata?.participants)
      ? metadata.participants.length
      : typeof metadata?.size === 'number'
        ? metadata.size
        : null;

    const isAnnouncement =
      typeof metadata?.announce === 'boolean' ? !!metadata.announce : null;
    const isRestricted =
      typeof metadata?.restrict === 'boolean' ? !!metadata.restrict : null;

    return {
      subject,
      participantsCount,
      isAnnouncement,
      isRestricted,
    };
  }

  private async fetchGroupMetadataResult(
    userId: string,
    sock: WASocket,
    jid: string,
    force = false,
    logErrors = true,
  ): Promise<WaGroupMetadataFetchResult> {
    const normalizedJid = String(jid || '').trim();
    if (!normalizedJid) return { metadata: null, errorMessage: 'empty_jid' };

    if (!force) {
      const cached = this.getCachedGroupMetadata(userId, normalizedJid);
      if (cached) return { metadata: cached, errorMessage: null };
    }

    const key = this.getGroupMetadataCacheKey(userId, normalizedJid);
    const existing = this.groupMetadataInFlight.get(key);
    if (existing) {
      const metadata = await existing.catch(() => null);
      return { metadata, errorMessage: metadata ? null : 'inflight_failed' };
    }

    const p = (async () => {
      try {
        const metadata = await sock.groupMetadata(normalizedJid);
        if (metadata)
          this.setCachedGroupMetadata(userId, normalizedJid, metadata);
        return metadata ?? null;
      } catch (e: any) {
        this.logger.warn(
          `[WA groupMetadata] failed for userId=${userId}, jid=${normalizedJid}: ${e?.message ?? e}`,
        );
        return null;
      } finally {
        this.groupMetadataInFlight.delete(key);
      }
    })();

    this.groupMetadataInFlight.set(key, p);
    try {
      const metadata = await p;
      return { metadata, errorMessage: metadata ? null : 'metadata_empty' };
    } catch (e: any) {
      const errorMessage = String(e?.message ?? e);
      if (logErrors) {
        this.logger.warn(
          `[WA groupMetadata] failed for userId=${userId}, jid=${normalizedJid}: ${errorMessage}`,
        );
      }
      return { metadata: null, errorMessage };
    }
  }

  private async fetchGroupMetadata(
    userId: string,
    sock: WASocket,
    jid: string,
    force = false,
  ): Promise<any | null> {
    const result = await this.fetchGroupMetadataResult(
      userId,
      sock,
      jid,
      force,
    );
    return result.metadata;
  }

  private async refreshGroupMetadataCache(
    userId: string,
    sock: WASocket,
    jid: string,
    reason: string,
  ) {
    const key = this.getGroupMetadataCacheKey(userId, jid);
    const lastRefreshAt = this.groupMetadataRefreshAt.get(key) ?? 0;
    if (
      Date.now() - lastRefreshAt <
      this.GROUP_METADATA_EVENT_REFRESH_COOLDOWN_MS
    ) {
      return;
    }
    this.groupMetadataRefreshAt.set(key, Date.now());

    const metadata = await this.fetchGroupMetadata(userId, sock, jid, true);
    if (!metadata) return;
    const normalized = this.normalizeGroupMetadata(metadata);
    this.logger.log(
      `[WA groupMetadata] cache refreshed for userId=${userId}, jid=${jid}, reason=${reason}, subject=${normalized.subject ?? 'null'}, participants=${normalized.participantsCount ?? 'null'}`,
    );
  }

  private async repairRowsWithGroupMetadata(
    userId: string,
    sock: WASocket,
    rows: Array<Record<string, any>>,
  ): Promise<WaRepairDiagnostics> {
    const candidates = rows.filter((row) => {
      const sRaw =
        typeof row.subject === 'string' && row.subject.trim()
          ? row.subject.trim()
          : null;
      const isPlaceholder = this.isPlaceholderSubject(sRaw);
      const subject = !sRaw || isPlaceholder ? null : sRaw;
      const participants =
        typeof row.participants_count === 'number'
          ? row.participants_count
          : null;
      return !subject || participants === 0 || participants == null;
    });

    if (candidates.length === 0) {
      return {
        rows,
        attempted: 0,
        repairedSubjectCount: 0,
        repairedParticipantsCount: 0,
        remainingMissingSubject: 0,
        failures: 0,
      };
    }

    const rowMap = new Map(rows.map((row) => [String(row.wa_group_id), row]));
    let repairedSubjectCount = 0;
    let repairedParticipantsCount = 0;
    let failures = 0;
    let rateLimitHits = 0;

    for (
      let i = 0;
      i < candidates.length;
      i += this.GROUP_METADATA_REPAIR_CONCURRENCY
    ) {
      const chunk = candidates.slice(
        i,
        i + this.GROUP_METADATA_REPAIR_CONCURRENCY,
      );
      const results = await Promise.all(
        chunk.map(async (row) => {
          const jid = String(row.wa_group_id || '').trim();
          const result = await this.fetchGroupMetadataResult(
            userId,
            sock,
            jid,
            true, // force=true: всегда запрашивать у WhatsApp, не использовать кэш (кэш мог быть заполнен неполными данными из groupFetchAllParticipating)
          );
          const err =
            typeof result.errorMessage === 'string' ? result.errorMessage : '';
          const isRateLimit =
            err.includes('rate-overlimit') || err.includes('retry-after');
          return { jid, metadata: result.metadata, isRateLimit };
        }),
      );

      for (const { jid, metadata, isRateLimit } of results) {
        if (!metadata) {
          failures += 1;
          if (isRateLimit) rateLimitHits += 1;
          continue;
        }

        const row = rowMap.get(jid);
        if (!row) continue;

        const normalized = this.normalizeGroupMetadata(metadata);
        const currentSubject =
          typeof row.subject === 'string' && row.subject.trim()
            ? row.subject.trim()
            : '';
        const hadSubject =
          !!currentSubject && !this.isPlaceholderSubject(currentSubject);
        const hadParticipants =
          typeof row.participants_count === 'number' &&
          row.participants_count > 0;

        if (!hadSubject && normalized.subject) {
          row.subject = normalized.subject;
          repairedSubjectCount += 1;
        }

        if (!hadParticipants && normalized.participantsCount != null) {
          row.participants_count = normalized.participantsCount;
          repairedParticipantsCount += 1;
        }

        if (row.is_announcement == null && normalized.isAnnouncement != null) {
          row.is_announcement = normalized.isAnnouncement;
        }

        if (row.is_restricted == null && normalized.isRestricted != null) {
          row.is_restricted = normalized.isRestricted;
        }
      }

      // Если словили лимиты — не продолжаем долбить WA, переносим ремонт в фон (там есть задержки).
      if (
        rateLimitHits >= this.GROUP_METADATA_BACKGROUND_RATE_LIMIT_THRESHOLD
      ) {
        this.logger.warn(
          `[WA syncGroups] groupMetadata repair hit rate limit for userId=${userId}, hits=${rateLimitHits}; switching to background hydration`,
        );
        this.scheduleBackgroundGroupHydration(userId, 10_000);
        break;
      }

      // Небольшая пауза между чанками, чтобы снизить шанс rate-overlimit.
      if (i + this.GROUP_METADATA_REPAIR_CONCURRENCY < candidates.length) {
        await delay(350);
      }
    }

    const repairedRows = Array.from(rowMap.values());
    const remainingMissingSubject = repairedRows.filter((row) => {
      const s =
        typeof row.subject === 'string' && row.subject.trim()
          ? row.subject.trim()
          : '';
      if (!s) return true;
      return this.isPlaceholderSubject(s);
    }).length;

    this.logger.log(
      `[WA syncGroups] groupMetadata repair for userId=${userId}: attempted=${candidates.length}, repairedSubject=${repairedSubjectCount}, repairedParticipants=${repairedParticipantsCount}, failures=${failures}, remainingMissingSubject=${remainingMissingSubject}`,
    );

    return {
      rows: repairedRows,
      attempted: candidates.length,
      repairedSubjectCount,
      repairedParticipantsCount,
      remainingMissingSubject,
      failures,
    };
  }

  private async runBackgroundGroupHydration(userId: string) {
    if (this.backgroundHydrationJobs.has(userId)) return;

    const job = (async () => {
      try {
        const s = this.ensureSession(userId);
        if (!s.sock || s.info.status !== 'connected') return;

        const { data, error } = await this.supabase
          .from('whatsapp_groups')
          .select(
            'wa_group_id, subject, participants_count, is_announcement, is_restricted, is_selected, send_time',
          )
          .eq('user_id', userId)
          .or('subject.is.null,subject.eq.,subject.like.Без названия%')
          .limit(this.GROUP_METADATA_BACKGROUND_BATCH_SIZE);

        if (error) {
          this.logger.error(
            `[WA bgHydrator] failed to query missing groups for userId=${userId}`,
            error as any,
          );
          return;
        }

        const rows = Array.isArray(data) ? data : [];
        if (rows.length === 0) {
          this.logger.log(
            `[WA bgHydrator] no missing subjects left for userId=${userId}`,
          );
          return;
        }

        this.logger.log(
          `[WA bgHydrator] start for userId=${userId}, batch=${rows.length}`,
        );

        const updates: Array<Record<string, any>> = [];
        let repairedSubjectCount = 0;
        let repairedParticipantsCount = 0;
        let failures = 0;
        let rateLimitHits = 0;

        for (const row of rows) {
          const session = this.ensureSession(userId);
          if (!session.sock || session.info.status !== 'connected') break;

          const jid = String(row.wa_group_id || '').trim();
          if (!jid) continue;

          const result = await this.fetchGroupMetadataResult(
            userId,
            session.sock,
            jid,
            true,
            false,
          );

          if (!result.metadata) {
            failures += 1;
            if (
              typeof result.errorMessage === 'string' &&
              result.errorMessage.includes('rate-overlimit')
            ) {
              rateLimitHits += 1;
              this.logger.warn(
                `[WA bgHydrator] rate-overlimit for userId=${userId}, jid=${jid}, hit=${rateLimitHits}`,
              );
              if (
                rateLimitHits >=
                this.GROUP_METADATA_BACKGROUND_RATE_LIMIT_THRESHOLD
              ) {
                break;
              }
            }
            await delay(this.GROUP_METADATA_BACKGROUND_DELAY_MS);
            continue;
          }

          const normalized = this.normalizeGroupMetadata(result.metadata);
          const patch: Record<string, any> = {
            user_id: userId,
            wa_group_id: jid,
            updated_at: new Date().toISOString(),
            send_time: row.send_time ?? null,
            is_selected:
              typeof row.is_selected === 'boolean' ? row.is_selected : true,
          };
          let changed = false;

          if (normalized.subject) {
            patch.subject = normalized.subject;
            repairedSubjectCount += 1;
            changed = true;
          }

          if (normalized.participantsCount != null) {
            patch.participants_count = normalized.participantsCount;
            if (
              !(
                typeof row.participants_count === 'number' &&
                row.participants_count > 0
              )
            ) {
              repairedParticipantsCount += 1;
            }
            changed = true;
          }

          if (normalized.isAnnouncement != null) {
            patch.is_announcement = normalized.isAnnouncement;
            changed = true;
          }

          if (normalized.isRestricted != null) {
            patch.is_restricted = normalized.isRestricted;
            changed = true;
          }

          if (changed) updates.push(patch);
          await delay(this.GROUP_METADATA_BACKGROUND_DELAY_MS);
        }

        if (updates.length > 0) {
          const { error: upsertError } = await this.supabase
            .from('whatsapp_groups')
            .upsert(updates, { onConflict: 'user_id,wa_group_id' });

          if (upsertError) {
            this.logger.error(
              `[WA bgHydrator] upsert failed for userId=${userId}`,
              upsertError as any,
            );
          } else {
            this.clearGroupsCountCacheForUser(userId);
          }
        }

        this.logger.log(
          `[WA bgHydrator] complete for userId=${userId}: attempted=${rows.length}, repairedSubject=${repairedSubjectCount}, repairedParticipants=${repairedParticipantsCount}, failures=${failures}, rateLimitHits=${rateLimitHits}, upserts=${updates.length}`,
        );

        if (
          rateLimitHits > 0 ||
          rows.length === this.GROUP_METADATA_BACKGROUND_BATCH_SIZE
        ) {
          this.scheduleBackgroundGroupHydration(
            userId,
            this.GROUP_METADATA_BACKGROUND_RETRY_DELAY_MS,
          );
        }
      } finally {
        this.backgroundHydrationJobs.delete(userId);
      }
    })();

    this.backgroundHydrationJobs.set(userId, job);
    await job;
  }

  private scheduleBackgroundGroupHydration(
    userId: string,
    delayMs = this.GROUP_METADATA_BACKGROUND_START_DELAY_MS,
  ) {
    if (this.backgroundHydrationJobs.has(userId)) return;
    if (this.backgroundHydrationTimers.has(userId)) return;

    const timer = setTimeout(() => {
      this.backgroundHydrationTimers.delete(userId);
      this.runBackgroundGroupHydration(userId).catch((e: any) => {
        this.logger.warn(
          `[WA bgHydrator] failed for userId=${userId}: ${e?.message ?? e}`,
        );
      });
    }, delayMs);

    this.backgroundHydrationTimers.set(userId, timer);
  }

  private ensureSession(userId: string): InternalSession {
    const existing = this.sessions.get(userId);
    if (existing) return existing;

    const s: InternalSession = {
      info: { status: 'not_connected' },
      restartAttempts: 0,
      lastChangeAt: Date.now(),
      proxyConsecutiveTimeouts: 0,
      lastLeaseTouchAt: 0,
    };
    this.sessions.set(userId, s);
    return s;
  }

  async getStatus(userId: string): Promise<SessionInfo> {
    const authDir = this.getAuthDir(userId);
    const credsPath = path.join(authDir, 'creds.json');
    const hasCreds = fs.existsSync(credsPath);
    const allowCredsConnectedFallback =
      hasCreds && !runtimeHasCapability('worker');
    const shared = await this.runtimeCoordinationService.readMessengerState<SessionInfo>(
      this.channel,
      userId,
    );
    const s = this.sessions.get(userId);
    if (!s) {
      if (shared) return shared;
      if (allowCredsConnectedFallback) {
        return {
          status: 'connected',
          stateSinceAt: new Date().toISOString(),
          stateDurationSec: 0,
          disconnectSinceAt: null,
          disconnectDurationSec: null,
        };
      }
      return {
        status: 'not_connected',
        stateSinceAt: new Date().toISOString(),
        stateDurationSec: 0,
        disconnectSinceAt: null,
        disconnectDurationSec: null,
      };
    }

    const sinceMs = Number.isFinite(s.lastChangeAt) ? s.lastChangeAt : Date.now();
    const durationSec = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
    const disconnectMs =
      s.info.status === 'connected'
        ? null
        : Number.isFinite(s.disconnectStartedAt)
          ? s.disconnectStartedAt!
          : null;
    const status = {
      ...s.info,
      stateSinceAt: new Date(sinceMs).toISOString(),
      stateDurationSec: durationSec,
      disconnectSinceAt: disconnectMs ? new Date(disconnectMs).toISOString() : null,
      disconnectDurationSec: disconnectMs
        ? Math.max(0, Math.floor((Date.now() - disconnectMs) / 1000))
        : null,
      proxyBypassUntil: Number.isFinite(s.proxyBypassUntil)
        ? new Date(s.proxyBypassUntil!).toISOString()
        : null,
    };

    if (status.status !== 'connected') {
      if (shared?.status && shared.status !== 'not_connected') {
        return shared;
      }
      if (
        allowCredsConnectedFallback &&
        (status.status === 'not_connected' || status.status === 'error')
      ) {
        return {
          ...status,
          status: 'connected',
          lastError: undefined,
          disconnectSinceAt: null,
          disconnectDurationSec: null,
        };
      }
    }

    await this.publishSessionState(userId, s);
    return status;
  }

  getNetworkIncidentSummary() {
    let total = 0;
    let affected = 0;
    for (const [, s] of this.sessions.entries()) {
      total += 1;
      const st = s.info?.status;
      const networkBad =
        st === 'temporary_network_issue' ||
        (st === 'connecting' && (s.info?.wsReachability === 'down' || s.info?.networkIssue === true));
      if (networkBad) affected += 1;
    }
    const globalIssue = affected >= 2 && total >= 2 && affected / Math.max(1, total) >= 0.5;
    return {
      success: true,
      globalIssue,
      affected,
      total,
      message: globalIssue
        ? 'Наблюдается общий сбой связи с WhatsApp. Восстановление уже выполняется автоматически.'
        : null,
    };
  }

  private maskProxyUrl(raw: string | null | undefined): string | null {
    const s = String(raw || '').trim();
    if (!s) return null;
    try {
      const u = new URL(s);
      const host = u.host || 'proxy';
      return `${u.protocol}//${host}`;
    } catch {
      return 'proxy';
    }
  }

  private async loadUserProxySettings(userId: string): Promise<WaProxySettings> {
    const defaults: WaProxySettings = {
      enabled: false,
      proxyUrl: null,
      failOpenDirect: true,
      maxConsecutiveFailures: 6,
    };
    try {
      const { data, error } = await (this.supabase as any)
        .from('wa_user_proxy_settings')
        .select(
          'enabled,proxy_url,fail_open_direct,max_consecutive_failures',
        )
        .eq('user_id', userId)
        .maybeSingle();
      if (error) {
        const msg = String(error?.message ?? '');
        if (msg.includes('wa_user_proxy_settings') || msg.includes('does not exist')) {
          return defaults;
        }
        this.logger.warn(`[WA proxy] load settings failed userId=${userId}: ${msg}`);
        return defaults;
      }
      if (!data) return defaults;
      const proxyUrl = String(data?.proxy_url || '').trim() || null;
      const maxRaw = Number(data?.max_consecutive_failures);
      const maxConsecutiveFailures = Number.isFinite(maxRaw)
        ? Math.max(2, Math.min(30, Math.floor(maxRaw)))
        : defaults.maxConsecutiveFailures;
      return {
        enabled: data?.enabled === true && !!proxyUrl,
        proxyUrl,
        failOpenDirect: data?.fail_open_direct !== false,
        maxConsecutiveFailures,
      };
    } catch (e: any) {
      this.logger.warn(
        `[WA proxy] load settings exception userId=${userId}: ${String(
          e?.message ?? e,
        )}`,
      );
      return defaults;
    }
  }

  async getUserProxySettings(userId: string) {
    const s = await this.loadUserProxySettings(userId);
    return {
      success: true,
      settings: {
        enabled: s.enabled,
        proxyUrl: s.proxyUrl,
        failOpenDirect: s.failOpenDirect,
        maxConsecutiveFailures: s.maxConsecutiveFailures,
        masked: this.maskProxyUrl(s.proxyUrl),
      },
    };
  }

  async setUserProxySettings(
    userId: string,
    params: {
      enabled?: boolean;
      proxyUrl?: string | null;
      failOpenDirect?: boolean;
      maxConsecutiveFailures?: number;
    },
  ) {
    const current = await this.loadUserProxySettings(userId);
    const next: WaProxySettings = {
      enabled: params.enabled ?? current.enabled,
      proxyUrl:
        params.proxyUrl === undefined
          ? current.proxyUrl
          : String(params.proxyUrl || '').trim() || null,
      failOpenDirect: params.failOpenDirect ?? current.failOpenDirect,
      maxConsecutiveFailures:
        typeof params.maxConsecutiveFailures === 'number'
          ? Math.max(2, Math.min(30, Math.floor(params.maxConsecutiveFailures)))
          : current.maxConsecutiveFailures,
    };
    if (next.enabled && !next.proxyUrl) {
      return { success: false, message: 'proxy_url_required_when_enabled' };
    }
    const { error } = await (this.supabase as any)
      .from('wa_user_proxy_settings')
      .upsert(
        {
          user_id: userId,
          enabled: next.enabled,
          proxy_url: next.proxyUrl,
          fail_open_direct: next.failOpenDirect,
          max_consecutive_failures: next.maxConsecutiveFailures,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
    if (error) {
      return { success: false, message: String(error?.message || 'db_error') };
    }
    const session = this.ensureSession(userId);
    session.proxySettings = next;
    return {
      success: true,
      settings: {
        ...next,
        masked: this.maskProxyUrl(next.proxyUrl),
      },
    };
  }

  /**
   * Сколько миллисекунд WA-сессия находится стабильно в статусе connected.
   * Если не connected — 0.
   */
  getConnectedStableMs(userId: string): number {
    const s = this.ensureSession(userId);
    if (s.info.status !== 'connected') return 0;
    return Math.max(0, Date.now() - (s.lastChangeAt || Date.now()));
  }

  private async probeWaReachability(userId: string, s: InternalSession) {
    const now = Date.now();
    const last = s.lastReachabilityProbeAt ?? 0;
    if (now - last < this.WA_REACHABILITY_PROBE_COOLDOWN_MS) return;
    s.lastReachabilityProbeAt = now;

    const startedAt = Date.now();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);

    try {
      // Легкий probe доступности маршрута до WA web-инфры.
      const res = await fetch('https://web.whatsapp.com/', {
        method: 'HEAD',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const rtt = Date.now() - startedAt;
      const status = res.ok
        ? rtt > 2500
          ? 'degraded'
          : 'ok'
        : 'down';
      s.info = {
        ...s.info,
        wsReachability: status,
        wsLastCheckAt: new Date().toISOString(),
        wsRttMs: rtt,
        wsError: res.ok ? null : `http_${res.status}`,
      };
      this.logger.warn(
        `[WA health] reachability userId=${userId} status=${status} rtt=${rtt}ms code=${res.status}`,
      );
    } catch (e: any) {
      const isAbort = e?.name === 'AbortError';
      const msg = isAbort ? 'timeout' : String(e?.message ?? e);
      s.info = {
        ...s.info,
        wsReachability: 'down',
        wsLastCheckAt: new Date().toISOString(),
        wsRttMs: null,
        wsError: msg,
      };
      this.logger.warn(`[WA health] reachability userId=${userId} status=down err=${msg}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Данные подключённого аккаунта WhatsApp (jid, номер) для отображения в кабинете.
   * Читает creds.json из папки сессии (Baileys хранит там me.id после подключения).
   */
  getAccountInfo(userId: string): {
    success: boolean;
    message?: string;
    connected?: boolean;
    wa_id?: string;
    jid?: string;
  } {
    try {
      const authDir = this.getAuthDir(userId);
      const credsPath = path.join(authDir, 'creds.json');
      const hasCreds = fs.existsSync(credsPath);

      const s = this.sessions.get(userId);
      const connected = s?.info.status === 'connected' || hasCreds;

      // Если сессия уже помечена как connected — считаем подключённым.
      // Если процесс перезапускался и память потерялась, но creds.json существует,
      // тоже считаем аккаунт подключённым и пытаемся фоном восстановить соединение.
      // Важно: не вызывать startSession во время показа QR / активного коннекта / авто‑рестарта.
      // Иначе любой поллинг account-info (шаблоны, другие вкладки) обрывает сокет Baileys —
      // QR «мигает» или исчезает через несколько секунд, пользователь не успевает отсканировать.
      if (
        s?.info.status !== 'connected' &&
        hasCreds &&
        runtimeHasCapability('worker')
      ) {
        const skipAutoRecover =
          s?.info.status === 'pending_qr' ||
          s?.info.status === 'connecting' ||
          s?.info.status === 'temporary_network_issue' ||
          Boolean(s?.starting);
        if (!skipAutoRecover) {
          this.startSession(userId).catch(() => undefined);
        }
      }

      if (!hasCreds) {
        return { success: true, connected };
      }

      const raw = fs.readFileSync(credsPath, 'utf-8');
      const data = JSON.parse(raw) as { me?: { id?: string } };
      const jid = data?.me?.id;
      if (!jid || typeof jid !== 'string') {
        return { success: true, connected };
      }
      // jid вида "79991234567@s.whatsapp.net" → wa_id "79991234567"
      const waId = jid.split('@')[0] || jid;
      return {
        success: true,
        connected,
        wa_id: waId,
        jid,
      };
    } catch (e: any) {
      this.logger.warn(
        `[WA] getAccountInfo failed for userId=${userId}: ${e?.message ?? e}`,
      );
      return { success: false, message: e?.message ?? 'unknown' };
    }
  }

  /** URL аватарки подключённого WA-аккаунта (для отображения в ЛК) */
  async getAccountAvatarUrl(userId: string): Promise<{
    success: boolean;
    url?: string | null;
    message?: string;
  }> {
    const jid = this.readAccountJidFromCreds(userId);
    if (!jid) return { success: true, url: null };
    // Отдельный proxy-URL: без редиректа на бренд-логотип при сбое (см. account-avatar-content).
    return { success: true, url: this.buildAccountAvatarProxyUrl(userId) };
  }

  /** Сырые байты аватара аккаунта (JID из creds). */
  async getAccountAvatarContent(userId: string): Promise<{
    success: boolean;
    contentType?: string;
    data?: Buffer;
    message?: string;
  }> {
    const jid = this.readAccountJidFromCreds(userId);
    if (!jid) return { success: false, message: 'no_creds' };
    return this.getGroupAvatarContent(userId, jid);
  }

  private readAccountJidFromCreds(userId: string): string | null {
    const authDir = this.getAuthDir(userId);
    const credsPath = path.join(authDir, 'creds.json');
    if (!fs.existsSync(credsPath)) return null;
    try {
      const raw = fs.readFileSync(credsPath, 'utf-8');
      const data = JSON.parse(raw) as { me?: { id?: string } };
      const jid = data?.me?.id;
      if (!jid || typeof jid !== 'string') return null;
      return jid.trim() || null;
    } catch {
      return null;
    }
  }

  private scheduleAuthDirCleanup(userId: string, delayMs = 2_000) {
    const authDir = this.getAuthDir(userId);
    setTimeout(() => {
      try {
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
          this.logger.log(
            `[WA] auth dir cleared after logout for userId=${userId}`,
          );
        }
      } catch (e: any) {
        this.logger.warn(
          `[WA] failed to clear auth dir for userId=${userId}: ${e?.message ?? e}`,
        );
      }
    }, delayMs);
  }

  resetSession(userId: string) {
    const s = this.ensureSession(userId);
    this.stopLeaseRenewTimer(s);
    try {
      s.sock?.end?.(new Error('manual reset'));
    } catch {}
    s.sock = undefined;
    s.starting = undefined;
    s.restartAttempts = 0;

    const authDir = this.getAuthDir(userId);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }

    this.clearGroupAvatarCache(userId);
    this.clearGroupMetadataCache(userId);
    this.clearBackgroundHydration(userId);

    s.info = { status: 'not_connected' };
    s.lastChangeAt = Date.now();
    s.disconnectStartedAt = undefined;
    s.lastLeaseTouchAt = 0;
    void this.publishSessionState(userId, s);
    void this.runtimeCoordinationService
      .releaseMessengerLease(this.channel, userId)
      .catch(() => undefined);
  }

  /**
   * Полное отключение WhatsApp:
   * - отправляем logout на сторону WhatsApp (убирает привязку устройства),
   * - останавливаем сокет,
   * - очищаем локальную папку авторизации и сбрасываем статус.
   */
  async disconnect(
    userId: string,
    audit: WaDisconnectAuditContext,
  ): Promise<{ success: boolean; message?: string }> {
    await this.ensureSessionLease(userId, 'disconnect').catch(() => false);
    const s = this.ensureSession(userId);
    const auditPrefix = `[WA AUDIT][disconnect] userId=${userId} requesterId=${audit.requesterId} source=${audit.source} ip=${audit.ip ?? '-'} ua=${audit.userAgent ?? '-'}`;

    this.logger.warn(`${auditPrefix} action=request`);

    try {
      if (s.sock && typeof (s.sock as any).logout === 'function') {
        this.logger.log(
          `${auditPrefix} action=logout_requested hasSocket=true`,
        );
        try {
          await (s.sock as any).logout();
          this.logger.log(`${auditPrefix} action=logout_success`);
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          this.logger.warn(`${auditPrefix} action=logout_failed error="${msg}"`);
        }
      } else {
        this.logger.warn(`${auditPrefix} action=logout_skipped hasSocket=false`);
      }
    } finally {
      this.resetSession(userId);
      this.logger.warn(`${auditPrefix} action=reset_session_done`);
    }

    return { success: true };
  }

  /**
   * @param opts.force — только явный запрос пользователя (POST /whatsapp/start): сбросить сокет и заново QR.
   * Без force во время `pending_qr` не трогаем сокет: иначе воркеры кампаний при каждой проверке WA
   * вызывают startSession → Baileys постоянно выдаёт новый QR и подключиться невозможно.
   */
  async startSession(
    userId: string,
    opts?: { force?: boolean },
  ): Promise<SessionInfo> {
    if (!(await this.ensureSessionLease(userId, 'start_session'))) {
      const shared = await this.runtimeCoordinationService.readMessengerState<SessionInfo>(
        this.channel,
        userId,
      );
      return (
        shared ?? {
          status: 'connecting',
          lastError: 'session_owned_by_other_runtime',
        }
      );
    }

    const s = this.ensureSession(userId);
    const force = opts?.force === true;

    if (s.info.status === 'connected') return s.info;

    if (!force && s.info.status === 'pending_qr' && s.sock) {
      return s.info;
    }

    if (s.starting) {
      await s.starting.catch(() => undefined);
      if (!force && s.info.status === 'pending_qr' && s.sock) {
        return s.info;
      }
    }

    s.starting = this.startInternal(userId).finally(() => {
      s.starting = undefined;
    });

    await s.starting.catch(() => undefined);
    await this.publishSessionState(userId, s);
    return s.info;
  }

  private buildGroupAvatarProxyUrl(userId: string, waGroupId: string) {
    return `/api/whatsapp/group-avatar-content/${encodeURIComponent(userId)}?wa_group_id=${encodeURIComponent(
      waGroupId,
    )}`;
  }

  private buildAccountAvatarProxyUrl(userId: string) {
    return `/api/whatsapp/account-avatar-content/${encodeURIComponent(userId)}`;
  }

  private readonly WA_AVATAR_BUCKET = 'wa-group-avatars';
  private waAvatarBucketEnsured: Promise<void> | null = null;

  private buildWaGroupAvatarObjectPath(userId: string, waGroupId: string) {
    // Важно: waGroupId может содержать ':' '@' и т.п.
    // Храним как url-encoded имя файла.
    const jid = String(waGroupId || '').trim();
    return `${userId}/${encodeURIComponent(jid)}.bin`;
  }

  private localWaAvatarCachePaths(userId: string, jid: string) {
    const dir = path.join(this.getAuthDir(userId), '.avatar-cache');
    const safe = encodeURIComponent(String(jid).trim()).replace(/%/g, '_');
    return {
      dir,
      img: path.join(dir, `${safe}.img`),
      ct: path.join(dir, `${safe}.ct`),
    };
  }

  private loadLocalWaAvatarDisk(
    userId: string,
    jid: string,
  ): { buf: Buffer; contentType: string } | null {
    try {
      const { img, ct } = this.localWaAvatarCachePaths(userId, jid);
      if (!fs.existsSync(img)) return null;
      const buf = fs.readFileSync(img);
      if (!buf.length) return null;
      let contentType = 'image/jpeg';
      if (fs.existsSync(ct)) {
        const t = fs.readFileSync(ct, 'utf8').trim();
        if (t) contentType = t;
      }
      return { buf, contentType };
    } catch {
      return null;
    }
  }

  private saveLocalWaAvatarDisk(
    userId: string,
    jid: string,
    buf: Buffer,
    contentType: string,
  ) {
    try {
      const { dir, img, ct } = this.localWaAvatarCachePaths(userId, jid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(img, buf);
      fs.writeFileSync(ct, contentType || 'image/jpeg', 'utf8');
    } catch {
      /* ignore — кеш опционален */
    }
  }

  private async loadCachedWaGroupAvatar(params: {
    userId: string;
    waGroupId: string;
  }): Promise<{ buf: Buffer; contentType: string } | null> {
    const { userId, waGroupId } = params;
    const path = this.buildWaGroupAvatarObjectPath(userId, waGroupId);
    try {
      const res = await this.supabase.storage
        .from(this.WA_AVATAR_BUCKET)
        .download(path);
      if (res.error || !res.data) return null;
      const blob: any = res.data as any;
      const ab = await blob.arrayBuffer();
      const buf = Buffer.from(ab);
      if (!buf.length) return null;
      const ct =
        typeof blob?.type === 'string' && blob.type.trim()
          ? String(blob.type).trim()
          : 'image/jpeg';
      return { buf, contentType: ct };
    } catch {
      return null;
    }
  }

  private async saveCachedWaGroupAvatar(params: {
    userId: string;
    waGroupId: string;
    buf: Buffer;
    contentType: string;
  }) {
    const { userId, waGroupId, buf, contentType } = params;
    const path = this.buildWaGroupAvatarObjectPath(userId, waGroupId);
    try {
      await this.ensureWaAvatarBucket();
      // best-effort: bucket может отсутствовать / быть приватным.
      await this.supabase.storage.from(this.WA_AVATAR_BUCKET).upload(path, buf, {
        upsert: true,
        contentType: contentType || 'image/jpeg',
      });
    } catch {
      // ignore
    }
  }

  private async ensureWaAvatarBucket() {
    if (this.waAvatarBucketEnsured) return this.waAvatarBucketEnsured;
    this.waAvatarBucketEnsured = (async () => {
      try {
        const listed = await this.supabase.storage.listBuckets();
        const buckets = (listed as any)?.data as Array<{ name?: string }> | undefined;
        const exists = Array.isArray(buckets) && buckets.some((b) => b?.name === this.WA_AVATAR_BUCKET);
        if (exists) return;

        // private bucket — доступ только через service key (который у бэкенда уже есть)
        const created = await this.supabase.storage.createBucket(this.WA_AVATAR_BUCKET, {
          public: false,
        });
        if ((created as any)?.error) {
          const msg = String((created as any).error?.message ?? '');
          // Если bucket уже существует — не считаем ошибкой.
          if (!msg.toLowerCase().includes('exists')) {
            this.logger.warn(`[WA avatars] createBucket failed: ${msg}`);
          }
        } else {
          this.logger.log(`[WA avatars] bucket created: ${this.WA_AVATAR_BUCKET}`);
        }
      } catch (e: any) {
        this.logger.warn(`[WA avatars] ensure bucket failed: ${e?.message ?? e}`);
      }
    })();
    return this.waAvatarBucketEnsured;
  }

  /**
   * Получить исходный внешний URL аватарки WA-группы (если доступно).
   * URL у WhatsApp временный, поэтому кэшируем его на короткое время.
   */
  private async resolveGroupAvatarSourceUrl(
    userId: string,
    waGroupId: string,
  ): Promise<{
    success: boolean;
    url?: string | null;
    message?: string;
  }> {
    const jid = String(waGroupId || '').trim();
    if (!jid) return { success: false, message: 'wa_group_id is required' };

    const s = this.ensureSession(userId);
    if (!s.sock || s.info.status !== 'connected') {
      return { success: false, message: 'whatsapp_not_connected' };
    }

    const key = `${userId}:${jid}`;
    const cached = this.groupAvatarCache.get(key);
    const now = Date.now();
    const avatarTtlMs = cached?.url
      ? this.GROUP_AVATAR_TTL_MS
      : this.GROUP_AVATAR_NULL_TTL_MS;
    if (cached && now - cached.ts < avatarTtlMs) {
      return { success: true, url: cached.url };
    }

    const existing = this.groupAvatarInFlight.get(key);
    if (existing) {
      const url = await existing.catch(() => null);
      return { success: true, url };
    }

    const p = (async () => {
      try {
        const sockAny = s.sock as any;
        if (typeof sockAny?.profilePictureUrl !== 'function') return null;

        // Baileys: profilePictureUrl(jid, type?) где type может быть 'image'/'preview'
        let url: string | null = null;
        try {
          url = await sockAny.profilePictureUrl(jid, 'image');
        } catch {
          try {
            url = await sockAny.profilePictureUrl(jid, 'preview');
          } catch {
            try {
              url = await sockAny.profilePictureUrl(jid);
            } catch {
              url = null;
            }
          }
        }

        if (typeof url !== 'string' || !url.trim()) url = null;

        this.groupAvatarCache.set(key, { url, ts: Date.now() });
        return url;
      } catch (e: any) {
        this.logger.warn(
          `[WA getGroupAvatarUrl] failed for userId=${userId}, jid=${jid}: ${e?.message ?? e}`,
        );
        this.groupAvatarCache.set(key, { url: null, ts: Date.now() });
        return null;
      } finally {
        this.groupAvatarInFlight.delete(key);
      }
    })();

    this.groupAvatarInFlight.set(key, p);
    const url = await p.catch(() => null);
    return { success: true, url };
  }

  /**
   * Получить URL аватарки WA-группы для браузера.
   * Отдаём наш proxy URL, чтобы фронт не зависел от DNS/доступности pps.whatsapp.net.
   */
  async getGroupAvatarUrl(
    userId: string,
    waGroupId: string,
  ): Promise<{
    success: boolean;
    url?: string | null;
    message?: string;
  }> {
    const jid = String(waGroupId || '').trim();
    if (!jid) return { success: false, message: 'wa_group_id is required' };

    const resolved = await this.resolveGroupAvatarSourceUrl(userId, jid);
    if (!resolved.success) return resolved;
    if (!resolved.url) return { success: true, url: null };

    return {
      success: true,
      url: this.buildGroupAvatarProxyUrl(userId, jid),
    };
  }

  async getGroupAvatarContent(
    userId: string,
    waGroupId: string,
  ): Promise<{
    success: boolean;
    contentType?: string;
    data?: Buffer;
    message?: string;
  }> {
    const jid = String(waGroupId || '').trim();
    if (!jid) return { success: false, message: 'wa_group_id is required' };

    const resolved = await this.resolveGroupAvatarSourceUrl(userId, jid);
    // Если WA временно недоступен — пробуем кеш (Supabase, затем локальный диск рядом с wa_auth).
    if (!resolved.success || !resolved.url) {
      const cached = await this.loadCachedWaGroupAvatar({ userId, waGroupId: jid });
      if (cached) {
        return { success: true, contentType: cached.contentType, data: cached.buf };
      }
      const local = this.loadLocalWaAvatarDisk(userId, jid);
      if (local) {
        return { success: true, contentType: local.contentType, data: local.buf };
      }
      return {
        success: false,
        message: resolved.message ?? 'avatar_not_found',
      };
    }

    try {
      const { buf, contentType } = await fetchWithTimeout(resolved.url, 15_000);
      // ✅ Обновляем кеш в хранилище: если аватар удалось скачать — сохраняем,
      // чтобы при временных проблемах WA продолжать показывать последнюю версию.
      await this.saveCachedWaGroupAvatar({
        userId,
        waGroupId: jid,
        buf,
        contentType: contentType || 'image/jpeg',
      });
      this.saveLocalWaAvatarDisk(userId, jid, buf, contentType || 'image/jpeg');
      return {
        success: true,
        contentType: contentType || 'image/jpeg',
        data: buf,
      };
    } catch (e: any) {
      this.logger.warn(
        `[WA getGroupAvatarContent] failed for userId=${userId}, jid=${jid}: ${e?.message ?? e}`,
      );
      // Если скачивание с WA не удалось — отдаём кеш, если он есть.
      const cached = await this.loadCachedWaGroupAvatar({ userId, waGroupId: jid });
      if (cached) {
        return { success: true, contentType: cached.contentType, data: cached.buf };
      }
      const local = this.loadLocalWaAvatarDisk(userId, jid);
      if (local) {
        return { success: true, contentType: local.contentType, data: local.buf };
      }
      return { success: false, message: e?.message ?? 'avatar_fetch_failed' };
    }
  }

  async syncGroups(userId: string) {
    const startTime = Date.now();
    this.logger.log(`[WA syncGroups] START for userId=${userId}`);
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
        message: 'whatsapp_session_busy',
      });
    }

    const s = this.ensureSession(userId);

    if (!s.sock || s.info.status !== 'connected') {
      const authDir = this.getAuthDir(userId);
      const credsPath = path.join(authDir, 'creds.json');
      const hasCreds = fs.existsSync(credsPath);

      if (!hasCreds) {
        return finish({
          success: false,
          message: 'whatsapp_not_connected',
        });
      }

      this.logger.log(
        `[WA syncGroups] no live socket but creds exist; reconnecting before sync userId=${userId}`,
      );
      if (!s.starting) {
        s.starting = this.startInternal(userId).finally(() => {
          s.starting = undefined;
        });
      }
      await s.starting.catch(() => undefined);

      if (!s.sock || s.info.status !== 'connected') {
        return finish({
          success: false,
          message: 'whatsapp_reconnect_failed',
          status: s.info.status,
          lastError: s.info.lastError,
        });
      }
    }

    const { data: existingRows, error: timeErr } = await this.supabase
      .from('whatsapp_groups')
      .select(
        'wa_group_id, send_time, subject, participants_count, is_announcement, is_restricted, is_selected',
      )
      .eq('user_id', userId);

    if (timeErr) {
      this.logger.error(
        'Supabase select whatsapp_groups send_time error',
        timeErr as any,
      );
      return finish({
        success: false,
        message: 'supabase_select_error',
        error: timeErr,
      });
    }

    const existingMap = new Map<string, any>();
    for (const r of existingRows ?? []) {
      const id = String((r as any)?.wa_group_id ?? '').trim();
      if (!id) continue;
      existingMap.set(id, r);
    }

    const firstAttempt = await this.buildSyncRows(
      userId,
      s.sock,
      existingMap,
      1,
    );

    let finalAttempt = firstAttempt;
    if (this.shouldRetrySync(firstAttempt, existingMap.size)) {
      this.logger.warn(
        `[WA syncGroups] retry scheduled for userId=${userId}: entries=${firstAttempt.entriesCount}, finalMissing=${firstAttempt.finalMissingSubjectIds.length}, apiMissing=${firstAttempt.apiMissingSubjectIds.length}`,
      );
      await delay(1500);
      const secondAttempt = await this.buildSyncRows(
        userId,
        s.sock,
        existingMap,
        2,
      );
      finalAttempt = this.pickBetterSyncAttempt(firstAttempt, secondAttempt);
      this.logger.log(
        `[WA syncGroups] retry selection for userId=${userId}: pickedAttempt=${
          finalAttempt === secondAttempt ? 2 : 1
        }, entries=${finalAttempt.entriesCount}, finalMissing=${finalAttempt.finalMissingSubjectIds.length}`,
      );
    }

    const repaired = await this.repairRowsWithGroupMetadata(
      userId,
      s.sock,
      finalAttempt.rows,
    );

    const accountInfo = this.getAccountInfo(userId);
    const waPhoneRaw =
      typeof accountInfo?.wa_id === 'string' && accountInfo.wa_id.trim()
        ? accountInfo.wa_id.trim()
        : null;
    const waPhone = waPhoneRaw
      ? normalizePhoneForStorage(waPhoneRaw) || waPhoneRaw
      : null;

    const rows = repaired.rows.map((r) => ({
      ...r,
      wa_phone: waPhone,
    }));

    const apiTime = finalAttempt.apiTime;

    const dbStartTime = Date.now();
    let upsertRows =
      this.waPhoneColumnAvailable === false
        ? this.stripWaPhoneColumn(rows)
        : rows;
    let { error } = await this.supabase
      .from('whatsapp_groups')
      .upsert(upsertRows, { onConflict: 'user_id,wa_group_id' });

    if (error && this.isMissingWaPhoneColumnError(error)) {
      this.logger.warn(
        '[WA syncGroups] wa_phone column missing in whatsapp_groups, retrying upsert without wa_phone',
      );
      this.waPhoneColumnAvailable = false;
      upsertRows = this.stripWaPhoneColumn(rows);
      const retry = await this.supabase
        .from('whatsapp_groups')
        .upsert(upsertRows, { onConflict: 'user_id,wa_group_id' });
      error = retry.error;
    } else if (!error && this.waPhoneColumnAvailable !== false) {
      this.waPhoneColumnAvailable = true;
    }

    if (error) {
      this.logger.error('Supabase upsert whatsapp_groups error', error as any);
      return finish({ success: false, message: 'supabase_upsert_error', error });
    }

    this.clearGroupsCountCacheForUser(userId);

    const totalTime = Date.now() - startTime;
    const dbTime = Date.now() - dbStartTime;
    this.logger.log(
      `[WA syncGroups] COMPLETE: total=${totalTime}ms, API=${apiTime}ms, DB=${dbTime}ms, groups=${rows.length}`,
    );

    // Предупреждение для медленных операций
    if (totalTime > 10000) {
      this.logger.warn(
        `[WA syncGroups] SLOW OPERATION: ${totalTime}ms for ${rows.length} groups (userId=${userId})`,
      );
    }

    if (repaired.remainingMissingSubject > 0) {
      this.scheduleBackgroundGroupHydration(userId);
    }

    return finish({
      success: true,
      count: rows.length,
      apiEntries: finalAttempt.entriesCount,
      apiMissingSubject: finalAttempt.apiMissingSubjectIds.length,
      finalMissingSubject: finalAttempt.finalMissingSubjectIds.length,
      repairedSubject: repaired.repairedSubjectCount,
      repairedParticipants: repaired.repairedParticipantsCount,
      remainingMissingSubject: repaired.remainingMissingSubject,
    });
  }

  private async buildSyncRows(
    userId: string,
    sock: WASocket,
    existingMap: Map<string, any>,
    attempt: number,
  ): Promise<WaSyncDiagnostics> {
    const apiStartTime = Date.now();
    const groupsMap = await sock.groupFetchAllParticipating();
    const apiTime = Date.now() - apiStartTime;

    const entries = Object.entries(groupsMap ?? {});
    const nowIso = new Date().toISOString();
    const apiMissingSubjectIds: string[] = [];
    const finalMissingSubjectIds: string[] = [];
    const fallbackSubjectIds: string[] = [];

    const rows = entries.map(([jid, gAny]: [string, any]) => {
      const id = String(gAny?.id ?? jid ?? '').trim();
      const computedSubject = this.extractGroupSubject(gAny);
      const hasValidSubject = !!computedSubject;
      if (id && hasValidSubject) this.setCachedGroupMetadata(userId, id, gAny);

      const existing = existingMap.get(id);
      const existingSubject =
        typeof existing?.subject === 'string' && existing.subject.trim()
          ? existing.subject.trim()
          : null;

      if (!computedSubject && id) {
        apiMissingSubjectIds.push(id);
      }
      if (!computedSubject && existingSubject && id) {
        fallbackSubjectIds.push(id);
      }

      const subject =
        computedSubject ??
        existingSubject ??
        (id ? `Без названия (${id})` : null);
      if (!subject && id) {
        finalMissingSubjectIds.push(id);
      }

      const existingSelected =
        typeof existing?.is_selected === 'boolean'
          ? existing.is_selected
          : null;
      const isSelected = existingSelected ?? true;

      const participantsCount = Array.isArray(gAny?.participants)
        ? gAny.participants.length
        : typeof existing?.participants_count === 'number'
          ? existing.participants_count
          : null;

      const announceRaw = gAny?.announce;
      const restrictRaw = gAny?.restrict;

      const isAnnouncement =
        typeof announceRaw === 'boolean'
          ? !!announceRaw
          : typeof existing?.is_announcement === 'boolean'
            ? existing.is_announcement
            : null;

      const isRestricted =
        typeof restrictRaw === 'boolean'
          ? !!restrictRaw
          : typeof existing?.is_restricted === 'boolean'
            ? existing.is_restricted
            : null;

      return {
        user_id: userId,
        wa_group_id: id,
        subject,
        participants_count: participantsCount,
        is_announcement: isAnnouncement,
        is_restricted: isRestricted,
        updated_at: nowIso,
        send_time: existing?.send_time ?? null,
        is_selected: isSelected,
      };
    });

    this.logger.log(
      `[WA syncGroups] attempt=${attempt} apiTime=${apiTime}ms entries=${entries.length} apiMissingSubject=${apiMissingSubjectIds.length} finalMissingSubject=${finalMissingSubjectIds.length} fallbackSubject=${fallbackSubjectIds.length}`,
    );

    if (apiMissingSubjectIds.length > 0) {
      this.logger.warn(
        `[WA syncGroups] attempt=${attempt} userId=${userId} missing subject from WA sample=${apiMissingSubjectIds
          .slice(0, 20)
          .join(', ')}`,
      );
    }

    if (finalMissingSubjectIds.length > 0) {
      this.logger.warn(
        `[WA syncGroups] attempt=${attempt} userId=${userId} final missing subject sample=${finalMissingSubjectIds
          .slice(0, 20)
          .join(', ')}`,
      );
    }

    return {
      rows,
      entriesCount: entries.length,
      apiTime,
      apiMissingSubjectIds,
      finalMissingSubjectIds,
      fallbackSubjectIds,
    };
  }

  private shouldRetrySync(
    attempt: WaSyncDiagnostics,
    existingCount: number,
  ): boolean {
    if (attempt.entriesCount === 0) return existingCount > 0;
    if (attempt.finalMissingSubjectIds.length >= 5) return true;
    return attempt.finalMissingSubjectIds.length / attempt.entriesCount >= 0.1;
  }

  private pickBetterSyncAttempt(
    first: WaSyncDiagnostics,
    second: WaSyncDiagnostics,
  ) {
    if (second.entriesCount !== first.entriesCount) {
      return second.entriesCount > first.entriesCount ? second : first;
    }

    if (
      second.finalMissingSubjectIds.length !==
      first.finalMissingSubjectIds.length
    ) {
      return second.finalMissingSubjectIds.length <
        first.finalMissingSubjectIds.length
        ? second
        : first;
    }

    if (
      second.apiMissingSubjectIds.length !== first.apiMissingSubjectIds.length
    ) {
      return second.apiMissingSubjectIds.length <
        first.apiMissingSubjectIds.length
        ? second
        : first;
    }

    return second;
  }

  /** Максимальный limit за один запрос — защита от тяжёлых выборок и злоупотреблений */
  private readonly GET_GROUPS_MAX_LIMIT = 200;

  async getGroupsFromDb(
    userId: string,
    limit?: number,
    offset?: number,
    selectedOnly?: boolean,
    waPhone?: string | null,
  ) {
    const startTime = Date.now();

    const safeLimit =
      limit === undefined
        ? undefined
        : Math.min(
            Math.max(1, Math.floor(Number(limit)) || 50),
            this.GET_GROUPS_MAX_LIMIT,
          );
    const safeOffset =
      offset === undefined
        ? undefined
        : Math.max(0, Math.floor(Number(offset)) || 0);

    // Оптимизация: выбираем только нужные колонки вместо select('*')
    const selectFields =
      'wa_group_id, subject, participants_count, is_announcement, is_restricted, is_selected, send_time, updated_at, last_send_error, last_send_error_at, wa_phone';
    const selectFieldsMin =
      'wa_group_id, subject, participants_count, is_announcement, is_restricted, is_selected, send_time, updated_at, wa_phone';
    const selectFieldsNoWaPhone =
      'wa_group_id, subject, participants_count, is_announcement, is_restricted, is_selected, send_time, updated_at';

    const safeWaPhone =
      typeof waPhone === 'string' && waPhone.trim()
        ? normalizePhoneForStorage(waPhone.trim()) || waPhone.trim()
        : null;

    const buildQuery = (fields: string, includeWaPhoneFilter: boolean) => {
      let q = this.supabase
        .from('whatsapp_groups')
        .select(fields)
        .eq('user_id', userId);

      if (selectedOnly) {
        q = q.eq('is_selected', true).eq('is_announcement', false);
      }
      if (includeWaPhoneFilter && safeWaPhone) {
        q = q.eq('wa_phone', safeWaPhone);
      }

      q = q.order('updated_at', { ascending: false });

      if (safeLimit !== undefined) {
        q = q.limit(safeLimit);
      }
      if (safeOffset !== undefined) {
        q = q.range(safeOffset, safeOffset + (safeLimit || 1000) - 1);
      }

      return q;
    };

    // Параллельно запускаем запрос данных и count (если нужен и не в кэше) — ускоряет загрузку списка групп
    const queryStartTime = Date.now();
    let countPromise: Promise<{
      count: number | null;
      countTime: number;
    }> | null = null;
    if (safeLimit !== undefined) {
      const cacheKey = [
        userId,
        selectedOnly ? 'selected' : 'all',
        safeWaPhone ?? '',
      ].join('_');
      const cached = this.groupsCountCache.get(cacheKey);
      const now = Date.now();
      if (!cached || now - cached.timestamp >= this.CACHE_TTL_MS) {
        const countStart = Date.now();
        countPromise = (async () => {
          let countQuery = this.supabase
            .from('whatsapp_groups')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId);
          if (selectedOnly) {
            countQuery = countQuery
              .eq('is_selected', true)
              .eq('is_announcement', false);
          }
          if (safeWaPhone && this.waPhoneColumnAvailable !== false) {
            countQuery = countQuery.eq('wa_phone', safeWaPhone);
          }
          let { count, error: countError } = await countQuery;
          if (countError && this.isMissingWaPhoneColumnError(countError)) {
            this.logger.warn(
              '[WA getGroupsFromDb] wa_phone column missing, count(*) without wa_phone filter',
            );
            this.waPhoneColumnAvailable = false;
            let fallbackCountQuery = this.supabase
              .from('whatsapp_groups')
              .select('*', { count: 'exact', head: true })
              .eq('user_id', userId);
            if (selectedOnly) {
              fallbackCountQuery = fallbackCountQuery
                .eq('is_selected', true)
                .eq('is_announcement', false);
            }
            const retry = await fallbackCountQuery;
            count = retry.count;
            countError = retry.error;
          }
          const countTime = Date.now() - countStart;
          if (countError) {
            this.logger.error(
              'Supabase count whatsapp_groups error',
              countError as any,
            );
            return { count: null, countTime };
          }
          return { count: count ?? 0, countTime };
        })();
      }
    }

    let { data, error } = await buildQuery(
      selectFields,
      this.waPhoneColumnAvailable !== false,
    );
    const queryTime = Date.now() - queryStartTime;

    // Fallback: если колонки last_send_error ещё нет (миграция не применена)
    const errMsg = String((error as any)?.message ?? '');
    if (error && errMsg.includes('last_send_error')) {
      this.logger.warn(
        '[WA getGroupsFromDb] last_send_error columns missing, using minimal select',
      );
      const res2 = await buildQuery(
        this.waPhoneColumnAvailable === false
          ? selectFieldsNoWaPhone
          : selectFieldsMin,
        this.waPhoneColumnAvailable !== false,
      );
      error = res2.error;
      data = Array.isArray(res2.data)
        ? res2.data.map((r: any) => ({
            ...r,
            wa_phone: (r as any)?.wa_phone ?? null,
            last_send_error: null,
            last_send_error_at: null,
          }))
        : res2.data;
    }

    if (error && this.isMissingWaPhoneColumnError(error)) {
      this.logger.warn(
        '[WA getGroupsFromDb] wa_phone column missing, using minimal select without wa_phone filter',
      );
      this.waPhoneColumnAvailable = false;
      const res3 = await buildQuery(selectFieldsNoWaPhone, false);
      error = res3.error;
      data = Array.isArray(res3.data)
        ? res3.data.map((r: any) => ({
            ...r,
            wa_phone: null,
            last_send_error: null,
            last_send_error_at: null,
          }))
        : res3.data;
    } else if (!error && this.waPhoneColumnAvailable !== false) {
      this.waPhoneColumnAvailable = true;
    }

    if (error) {
      this.logger.error('Supabase select whatsapp_groups error', error as any);
      return { success: false, message: 'supabase_select_error', error };
    }

    // Дедупликация на уровне бэкенда на случай дубликатов в БД
    const groups: any[] = Array.isArray(data) ? (data as any[]) : [];
    const seen = new Map<string, any>();
    const uniqueGroups: any[] = [];

    for (const group of groups) {
      const groupId = String(group.wa_group_id);
      if (!seen.has(groupId)) {
        seen.set(groupId, group);
        uniqueGroups.push(group);
      } else {
        // Логируем детальную информацию о дубликате для отладки
        const existing = seen.get(groupId);
        this.logger.warn(
          `Дубликат группы в БД: wa_group_id=${groupId}, user_id=${userId}, subject="${group.subject}", existing_subject="${existing?.subject}", updated_at="${group.updated_at}", existing_updated_at="${existing?.updated_at}"`,
        );
      }
    }

    // Если запрашиваем с пагинацией - возвращаем также общее количество
    if (safeLimit !== undefined) {
      const cacheKey = [
        userId,
        selectedOnly ? 'selected' : 'all',
        safeWaPhone ?? '',
      ].join('_');
      const now = Date.now();
      const cached = this.groupsCountCache.get(cacheKey);
      let totalCount: number | null = null;
      let countTime = 0;

      if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
        totalCount = cached.count;
        this.logger.log(
          `[WA getGroupsFromDb] Using cached count: ${totalCount} (userId=${userId}, selectedOnly=${selectedOnly})`,
        );
      } else if (countPromise) {
        const res = await countPromise;
        totalCount = res.count;
        countTime = res.countTime;
        if (totalCount !== null) {
          this.groupsCountCache.set(cacheKey, {
            count: totalCount,
            timestamp: now,
          });
        }
      }

      const totalTime = Date.now() - startTime;
      const actualQueryTime = queryTime; // Время основного запроса
      const dedupTime = totalTime - queryTime - countTime; // Время на дедупликацию

      // Анализ производительности: предупреждаем о медленных запросах
      // Особенно обращаем внимание на большие offset, которые могут быть очень медленными
      if (totalTime > 1000) {
        const offsetInfo =
          safeOffset !== undefined
            ? `offset=${safeOffset} (${safeOffset > 200 ? 'LARGE OFFSET - consider cursor pagination' : 'normal'})`
            : 'no offset';
        this.logger.warn(
          `[WA getGroupsFromDb] SLOW QUERY: total=${totalTime}ms (query=${actualQueryTime}ms, count=${countTime}ms, dedup=${dedupTime}ms) userId=${userId}, limit=${safeLimit}, ${offsetInfo}, returned=${uniqueGroups.length}, total=${totalCount}`,
        );
      } else {
        this.logger.log(
          `[WA getGroupsFromDb] COMPLETE: total=${totalTime}ms (query=${actualQueryTime}ms, count=${countTime}ms, dedup=${dedupTime}ms), limit=${safeLimit}, offset=${safeOffset}, returned=${uniqueGroups.length}, total=${totalCount}`,
        );
      }

      // Логирование проблем с пагинацией
      if (
        safeOffset !== undefined &&
        safeOffset > 0 &&
        uniqueGroups.length === 0 &&
        (totalCount ?? 0) > 0
      ) {
        this.logger.warn(
          `[WA getGroupsFromDb] EMPTY PAGE: offset=${safeOffset}, total=${totalCount}, possible pagination issue`,
        );
      }

      return {
        success: true,
        groups: uniqueGroups,
        total: totalCount ?? 0,
        hasMore: (safeOffset || 0) + uniqueGroups.length < (totalCount || 0),
      };
    }

    const totalTime = Date.now() - startTime;
    this.logger.log(
      `[WA getGroupsFromDb] COMPLETE: total=${totalTime}ms, returned=${uniqueGroups.length} (no pagination)`,
    );

    return { success: true, groups: uniqueGroups };
  }

  /** Список номеров WhatsApp, с которых есть группы (для фильтра в UI) */
  async getGroupsPhones(
    userId: string,
  ): Promise<{ success: boolean; phones?: string[]; message?: string }> {
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_groups')
        .select('wa_phone')
        .eq('user_id', userId)
        .not('wa_phone', 'is', null);

      if (error) {
        if (String((error as any)?.message ?? '').includes('wa_phone')) {
          return { success: true, phones: [] };
        }
        this.logger.error('Supabase select wa_phone error', error as any);
        return { success: false, message: 'supabase_error', phones: [] };
      }

      const seen = new Set<string>();
      const phones: string[] = [];
      for (const row of data ?? []) {
        const p = String((row as any)?.wa_phone ?? '').trim();
        if (!p) continue;
        const key = normalizePhoneForStorage(p) || p;
        if (key && !seen.has(key)) {
          seen.add(key);
          phones.push(normalizePhoneE164(p) || p);
        }
      }
      phones.sort();
      return { success: true, phones };
    } catch (e: any) {
      this.logger.error('getGroupsPhones error', e);
      return { success: false, message: e?.message ?? 'unknown', phones: [] };
    }
  }

  // ✅ Быстрый подсчет выбранных групп без загрузки данных
  async getSelectedGroupsCount(userId: string) {
    try {
      // Подсчет выбранных WA групп (не announcement)
      const { count: selectedCount, error: selectedError } = await this.supabase
        .from('whatsapp_groups')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_selected', true)
        .is('is_announcement', false);

      if (selectedError) {
        this.logger.error(
          'Supabase count whatsapp_groups selected error',
          selectedError as any,
        );
        return {
          success: false,
          message: 'supabase_count_error',
          error: selectedError,
        };
      }

      // Общее количество групп (не announcement)
      const { count: totalCount, error: totalError } = await this.supabase
        .from('whatsapp_groups')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('is_announcement', false);

      if (totalError) {
        this.logger.error(
          'Supabase count whatsapp_groups total error',
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

  // ✅ НОВОЕ: включить/выключить группу для рассылки
  /** Сохранить ошибку последней отправки по группе (для отображения в списке групп) */
  async persistSendError(
    userId: string,
    waGroupId: string,
    errorMessage: string,
  ): Promise<void> {
    const msg = String(errorMessage || '')
      .trim()
      .substring(0, 500);
    const { error } = await this.supabase
      .from('whatsapp_groups')
      .update({
        last_send_error: msg || null,
        last_send_error_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('wa_group_id', waGroupId);
    if (error) {
      this.logger.warn(
        `[WA persistSendError] update failed: ${(error as any)?.message ?? error} (userId=${userId}, waGroupId=${waGroupId})`,
      );
    }
  }

  async clearSendError(userId: string, waGroupId: string): Promise<void> {
    const { error } = await this.supabase
      .from('whatsapp_groups')
      .update({
        last_send_error: null,
        last_send_error_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('wa_group_id', waGroupId);
    if (error) {
      this.logger.debug(
        `[WA clearSendError] update failed: ${(error as any)?.message ?? error} (userId=${userId}, waGroupId=${waGroupId})`,
      );
    }
  }

  async setGroupSelected(params: {
    userId: string;
    waGroupId: string;
    isSelected: boolean;
  }) {
    const { userId, waGroupId, isSelected } = params;

    try {
      const { data, error } = await this.supabase
        .from('whatsapp_groups')
        .update({
          is_selected: isSelected,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('wa_group_id', waGroupId)
        .select('wa_group_id, is_selected')
        .maybeSingle();

      if (error) {
        this.logger.error(
          `Supabase update whatsapp_groups error for group ${waGroupId}`,
          {
            error,
            userId,
            waGroupId,
            isSelected,
          },
        );
        return {
          success: false,
          message: 'supabase_update_error',
          error: String(error),
        };
      }

      if (!data) {
        this.logger.warn(`Group not found: ${waGroupId} for user ${userId}`);
        return { success: false, message: 'group_not_found' };
      }

      this.clearGroupsCountCacheForUser(userId);

      return { success: true, group: data };
    } catch (e: any) {
      this.logger.error(
        `Exception in setGroupSelected for group ${waGroupId}`,
        {
          error: e?.message || String(e),
          stack: e?.stack,
          userId,
          waGroupId,
          isSelected,
        },
      );
      return { success: false, message: 'internal_error', error: String(e) };
    }
  }

  // Размер одного батча для .in() — Supabase/PostgREST ограничивает длину запроса при большом числе значений
  private readonly SELECT_BATCH_CHUNK_SIZE = 100;

  // ✅ Батч обновление: массовое включение/выключение групп (разбиваем на чанки, чтобы не упереться в лимит Supabase)
  async setGroupsSelectedBatch(params: {
    userId: string;
    waGroupIds: string[];
    isSelected: boolean;
  }) {
    const { userId, waGroupIds, isSelected } = params;

    if (!waGroupIds || waGroupIds.length === 0) {
      return { success: false, message: 'wa_group_ids is empty' };
    }

    try {
      const now = new Date().toISOString();
      let totalUpdated = 0;

      for (
        let i = 0;
        i < waGroupIds.length;
        i += this.SELECT_BATCH_CHUNK_SIZE
      ) {
        const chunk = waGroupIds.slice(i, i + this.SELECT_BATCH_CHUNK_SIZE);

        const { data, error } = await this.supabase
          .from('whatsapp_groups')
          .update({
            is_selected: isSelected,
            updated_at: now,
          })
          .eq('user_id', userId)
          .in('wa_group_id', chunk)
          .select('wa_group_id, is_selected');

        if (error) {
          this.logger.error(`Supabase batch update whatsapp_groups error`, {
            error,
            userId,
            chunkIndex: i / this.SELECT_BATCH_CHUNK_SIZE,
            chunkLength: chunk.length,
            isSelected,
          });
          return {
            success: false,
            message: 'supabase_update_error',
            error: String(error),
          };
        }

        totalUpdated += data?.length || 0;
      }

      this.logger.log(
        `Batch updated ${totalUpdated} groups for user ${userId} (chunks: ${Math.ceil(waGroupIds.length / this.SELECT_BATCH_CHUNK_SIZE)})`,
      );

      // Инвалидируем кэш после изменения групп (и для всех групп, и для выбранных)
      this.clearGroupsCountCacheForUser(userId);

      return {
        success: true,
        updated: totalUpdated,
        total: waGroupIds.length,
      };
    } catch (e: any) {
      this.logger.error(`Exception in setGroupsSelectedBatch`, {
        error: e?.message || String(e),
        stack: e?.stack,
        userId,
        waGroupIdsCount: waGroupIds.length,
        isSelected,
      });
      return { success: false, message: 'internal_error', error: String(e) };
    }
  }

  async setGroupSendTime(params: {
    userId: string;
    waGroupId: string;
    sendTime: string | null;
  }) {
    const { userId, waGroupId, sendTime } = params;
    const normalized = normalizeWaGroupSendTime(sendTime);

    const { data, error } = await this.supabase
      .from('whatsapp_groups')
      .update({
        send_time: normalized,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('wa_group_id', waGroupId)
      .select('wa_group_id, send_time')
      .maybeSingle();

    if (error) {
      this.logger.error(
        'Supabase update whatsapp_groups send_time error',
        error as any,
      );
      return { success: false, message: 'supabase_update_error', error };
    }

    if (!data) return { success: false, message: 'group_not_found' };

    // send_time не влияет на общее количество групп, кэш не инвалидируем

    return { success: true, group: data };
  }

  async sendToGroup(
    userId: string,
    groupJid: string,
    payload: {
      text: string;
      mediaUrl?: string | null;
      sendMediaAsFile?: boolean;
    },
  ) {
    const sendStartTime = Date.now();
    if (!(await this.ensureSessionLease(userId, 'send_to_group'))) {
      throw new Error('whatsapp_session_busy');
    }
    const s = this.ensureSession(userId);

    if (!s.sock || s.info.status !== 'connected') {
      this.logger.warn(
        `[WA sendToGroup] FAILED: not connected (userId=${userId}, groupJid=${groupJid})`,
      );
      throw new Error('whatsapp_not_connected');
    }

    const text = payload.text || '';
    const textForWa = templateMarkdownToWhatsAppText(text);
    const mediaUrl = (payload.mediaUrl || '').trim();
    const sendMediaAsFile = payload.sendMediaAsFile === true;
    const fileName = mediaUrl.split('/').pop()?.split('?')[0] || 'file';

    // ✅ Только текст
    if (!mediaUrl) {
      await this.sendMessageWithRateLimitRetry(
        userId,
        groupJid,
        s.sock,
        { text: textForWa },
        'text_only',
      );
      const sendTime = Date.now() - sendStartTime;
      this.logger.log(
        `[WA sendToGroup] SUCCESS: text only (userId=${userId}, groupJid=${groupJid}, time=${sendTime}ms)`,
      );
      if (sendTime > 5000) {
        this.logger.warn(`[WA sendToGroup] SLOW SEND: ${sendTime}ms`);
      }
      return;
    }

    // timeout на скачивание
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);

    let buf: Buffer;
    let contentType = '';
    try {
      const res = await fetch(mediaUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'follow',
      });

      if (!res.ok) {
        // ✅ если медиа не скачалось — отправим хотя бы текст
        this.logger.warn(
          `[WA sendToGroup] MEDIA DOWNLOAD FAILED: status=${res.status}, url=${mediaUrl.substring(0, 100)}..., falling back to text only`,
        );
        await this.sendMessageWithRateLimitRetry(
          userId,
          groupJid,
          s.sock,
          { text: textForWa },
          'text_fallback_media_download_failed',
        );
        const sendTime = Date.now() - sendStartTime;
        this.logger.log(
          `[WA sendToGroup] SUCCESS: text fallback (userId=${userId}, groupJid=${groupJid}, time=${sendTime}ms)`,
        );
        return;
      }

      contentType = (res.headers.get('content-type') || '').toLowerCase();

      const arr = await res.arrayBuffer();
      buf = Buffer.from(arr);

      // ✅ если пришёл HTML или слишком маленький файл — это почти точно не картинка
      if (contentType.includes('text/html') || buf.length < 2000) {
        this.logger.warn(
          `[WA sendToGroup] INVALID MEDIA: contentType=${contentType}, size=${buf.length}, url=${mediaUrl.substring(0, 100)}..., falling back to text`,
        );
        await this.sendMessageWithRateLimitRetry(
          userId,
          groupJid,
          s.sock,
          { text: textForWa },
          'text_fallback_invalid_media',
        );
        const sendTime = Date.now() - sendStartTime;
        this.logger.log(
          `[WA sendToGroup] SUCCESS: text fallback (userId=${userId}, groupJid=${groupJid}, time=${sendTime}ms)`,
        );
        return;
      }
    } finally {
      clearTimeout(timeout);
    }

    const lower = mediaUrl.toLowerCase().split('?')[0];

    const isVideo =
      contentType.startsWith('video/') ||
      lower.endsWith('.mp4') ||
      lower.endsWith('.mov') ||
      lower.endsWith('.webm') ||
      lower.endsWith('.mkv') ||
      lower.endsWith('.avi') ||
      lower.endsWith('.flv') ||
      lower.endsWith('.wmv') ||
      lower.endsWith('.m4v') ||
      lower.endsWith('.3gp');

    const isImage =
      contentType.startsWith('image/') ||
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.png') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.gif') ||
      lower.endsWith('.bmp') ||
      lower.endsWith('.svg') ||
      lower.endsWith('.ico') ||
      lower.endsWith('.tiff') ||
      lower.endsWith('.tif') ||
      lower.endsWith('.heic') ||
      lower.endsWith('.heif');

    const isAudio =
      contentType.startsWith('audio/') ||
      lower.endsWith('.mp3') ||
      lower.endsWith('.m4a') ||
      lower.endsWith('.ogg') ||
      lower.endsWith('.wav') ||
      lower.endsWith('.opus') ||
      lower.endsWith('.aac') ||
      lower.endsWith('.flac') ||
      lower.endsWith('.wma') ||
      lower.endsWith('.amr');

    if (sendMediaAsFile) {
      await this.sendMessageWithRateLimitRetry(
        userId,
        groupJid,
        s.sock,
        {
          document: buf,
          mimetype: contentType || 'application/octet-stream',
          caption: textForWa,
          fileName,
        },
        'document',
      );
      this.logger.log(
        `[WA sendToGroup] SUCCESS: document (userId=${userId}, groupJid=${groupJid}, size=${buf.length})`,
      );
      return;
    }

    if (isVideo) {
      await this.sendMessageWithRateLimitRetry(
        userId,
        groupJid,
        s.sock,
        {
          video: buf,
          caption: textForWa,
          mimetype: contentType || 'video/mp4',
        },
        'video',
      );
      return;
    }

    if (isImage) {
      await this.sendMessageWithRateLimitRetry(
        userId,
        groupJid,
        s.sock,
        {
          image: buf,
          caption: textForWa,
          mimetype: contentType || 'image/jpeg',
        },
        'image',
      );
      return;
    }

    // ✅ если тип непонятен — отправим текст, а не “левый документ”
    if (isAudio) {
      await this.sendMessageWithRateLimitRetry(
        userId,
        groupJid,
        s.sock,
        {
          audio: buf,
          mimetype: contentType || 'audio/mpeg',
          ptt: false,
        },
        'audio',
      );
      if (textForWa) {
        await this.sendMessageWithRateLimitRetry(
          userId,
          groupJid,
          s.sock,
          { text: textForWa },
          'audio_text_followup',
        );
      }
      this.logger.log(
        `[WA sendToGroup] SUCCESS: audio (userId=${userId}, groupJid=${groupJid}, size=${buf.length})`,
      );
      return;
    }

    await this.sendMessageWithRateLimitRetry(
      userId,
      groupJid,
      s.sock,
      { text: textForWa },
      'unknown_media_text_only',
    );
    return;
  }

  private async sendMessageWithRateLimitRetry(
    userId: string,
    groupJid: string,
    sock: WASocket,
    content: any,
    label: string,
  ) {
    const startedAt = Date.now();
    try {
      await sock.sendMessage(groupJid, content);
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? '');

      if (msg.includes('rate-overlimit') || msg.includes('retry-after')) {
        this.recordWaSendRateLimitHit({
          userId,
          label,
          errorMessage: msg,
        });
        this.logger.warn(
          `[WA sendMessageWithRateLimitRetry] rate limit hit (userId=${userId}, groupJid=${groupJid}, label=${label}): ${msg}`,
        );
        await delay(this.SEND_RATE_LIMIT_RETRY_DELAY_MS);
        await sock.sendMessage(groupJid, content);
        const total = Date.now() - startedAt;
        this.logger.log(
          `[WA sendMessageWithRateLimitRetry] SUCCESS after rate limit retry (userId=${userId}, groupJid=${groupJid}, label=${label}, time=${total}ms)`,
        );
        return;
      }

      // Частая плавающая проблема WA-медиа: "Media upload failed on all hosts".
      // Делаем мягкий быстрый self-heal без радикальной смены логики:
      // несколько коротких повторов с актуальным сокетом из текущей сессии.
      if (/media upload failed on all hosts/i.test(msg)) {
        for (let attempt = 1; attempt <= this.WA_MEDIA_UPLOAD_RETRY_ATTEMPTS; attempt++) {
          const waitMs =
            this.WA_MEDIA_UPLOAD_RETRY_DELAY_MS * attempt +
            Math.floor(Math.random() * 700);
          this.logger.warn(
            `[WA sendMessageWithRateLimitRetry] media upload failed, retry ${attempt}/${this.WA_MEDIA_UPLOAD_RETRY_ATTEMPTS} after ${waitMs}ms (userId=${userId}, groupJid=${groupJid}, label=${label})`,
          );
          await delay(waitMs);

          const latest = this.ensureSession(userId);
          if (!latest.sock || latest.info.status !== 'connected') {
            this.logger.warn(
              `[WA sendMessageWithRateLimitRetry] media retry aborted: session is not connected (userId=${userId}, groupJid=${groupJid}, label=${label})`,
            );
            throw new Error('whatsapp_not_connected');
          }

          try {
            await latest.sock.sendMessage(groupJid, content);
            const total = Date.now() - startedAt;
            this.logger.log(
              `[WA sendMessageWithRateLimitRetry] SUCCESS after media upload retry (userId=${userId}, groupJid=${groupJid}, label=${label}, time=${total}ms)`,
            );
            return;
          } catch (retryErr: any) {
            const retryMsg = String(retryErr?.message ?? retryErr ?? '');
            if (attempt >= this.WA_MEDIA_UPLOAD_RETRY_ATTEMPTS) {
              this.logger.error(
                `[WA sendMessageWithRateLimitRetry] media retry exhausted (userId=${userId}, groupJid=${groupJid}, label=${label}): ${retryMsg}`,
              );
              throw retryErr;
            }
          }
        }
      }

      this.logger.error(
        `[WA sendMessageWithRateLimitRetry] FAILED (userId=${userId}, groupJid=${groupJid}, label=${label}): ${msg}`,
      );
      throw e;
    }
  }

  private async startInternal(userId: string) {
    const s = this.ensureSession(userId);

    try {
      s.sock?.end?.(new Error('restart'));
    } catch {}
    s.sock = undefined;

    const authDir = this.getAuthDir(userId);
    fs.mkdirSync(authDir, { recursive: true });

    const proxySettings = s.proxySettings ?? (await this.loadUserProxySettings(userId));
    s.proxySettings = proxySettings;
    const nowMs = Date.now();
    const proxyBypassed =
      Number.isFinite(s.proxyBypassUntil) && nowMs < Number(s.proxyBypassUntil);
    const proxyEnabled =
      proxySettings.enabled && !!proxySettings.proxyUrl && !proxyBypassed;
    const proxyLabel = this.maskProxyUrl(proxySettings.proxyUrl);
    let proxyAgent: HttpsProxyAgent<string> | undefined;
    if (proxyEnabled && proxySettings.proxyUrl) {
      try {
        proxyAgent = new HttpsProxyAgent(proxySettings.proxyUrl);
      } catch (e: any) {
        this.logger.warn(
          `[WA proxy] invalid proxy url for userId=${userId}: ${String(
            e?.message ?? e,
          )}`,
        );
      }
    }

    s.info = {
      status: 'connecting',
      proxyEnabled: proxySettings.enabled,
      proxyActive: !!proxyAgent,
      proxyLabel,
      proxyBypassUntil: Number.isFinite(s.proxyBypassUntil)
        ? new Date(s.proxyBypassUntil!).toISOString()
        : null,
    };
    s.lastChangeAt = Date.now();
    void this.publishSessionState(userId, s);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      // Дольше ждём рукопожатие при слабом канале; короткий таймаут даёт лишние обрывы во время показа QR.
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 20_000,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      cachedGroupMetadata: async (jid: string) =>
        this.getCachedGroupMetadata(userId, jid) ?? undefined,
      agent: proxyAgent as any,
      fetchAgent: proxyAgent as any,
    });

    s.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('groups.update', (events: any[]) => {
      for (const event of events ?? []) {
        const jid = String(event?.id || '').trim();
        if (!jid) continue;
        this.refreshGroupMetadataCache(
          userId,
          sock,
          jid,
          'groups.update',
        ).catch(() => undefined);
      }
    });

    sock.ev.on('group-participants.update', (event: any) => {
      const jid = String(event?.id || '').trim();
      if (!jid) return;
      this.refreshGroupMetadataCache(
        userId,
        sock,
        jid,
        'group-participants.update',
      ).catch(() => undefined);
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection) {
        this.logger.log(`connection.update for ${userId}: ${connection}`);
      }

      if (qr) {
        s.info = { status: 'pending_qr', qr };
        s.lastQrAt = Date.now();
        s.lastChangeAt = Date.now();
        void this.publishSessionState(userId, s);
        this.logger.log(
          `[WA] QR emitted for userId=${userId}, length=${qr?.length ?? 0}`,
        );
        return;
      }

      if (connection === 'open') {
        this.stopRestartTimer(s);
        s.restartAttempts = 0;
        s.disconnectStartedAt = undefined;
        s.proxyConsecutiveTimeouts = 0;
        s.info = {
          status: 'connected',
          retryAttempt: 0,
          retryMax: this.WA_TRANSIENT_RETRY_MAX_ATTEMPTS,
          nextRetryAt: null,
          networkIssue: false,
          wsReachability: 'ok',
          wsLastCheckAt: new Date().toISOString(),
          wsRttMs: null,
          wsError: null,
          proxyEnabled: proxySettings.enabled,
          proxyActive: !!proxyAgent,
          proxyLabel,
          proxyBypassUntil: Number.isFinite(s.proxyBypassUntil)
            ? new Date(s.proxyBypassUntil!).toISOString()
            : null,
        };
        s.lastChangeAt = Date.now();
        s.lastLeaseTouchAt = Date.now();
        this.clearGroupAvatarCache(userId);
        void this.publishSessionState(userId, s);
        this.logger.log(`WhatsApp connected for user ${userId}`);
        if (runtimeHasCapability('worker')) {
          this.scheduleCampaignResumeAfterWaConnected(userId);
        }
        return;
      }

      if (connection === 'close') {
        this.stopLeaseRenewTimer(s);
        void this.runtimeCoordinationService
          .releaseMessengerLease(this.channel, userId)
          .catch(() => undefined);
        if (!Number.isFinite(s.disconnectStartedAt)) {
          s.disconnectStartedAt = Date.now();
        }
        const boom = lastDisconnect?.error as Boom | undefined;
        const statusCode = boom?.output?.statusCode;

        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const msg = boom?.message ?? 'connection closed';
        const msgLower = String(msg || '').toLowerCase();
        const isIntentionalOwnershipRelease =
          msg.startsWith('release_connected_session_ownership:') ||
          msg === 'idle_release' ||
          msg === 'manual reset';
        const isConflict401 =
          statusCode === 401 && msgLower.includes('conflict');
        const isConnectionReplaced =
          statusCode === DisconnectReason.connectionReplaced ||
          statusCode === 440;

        const disconnectDetail = formatWaLastDisconnectDetail(boom);
        this.logger.warn(
          `WhatsApp closed for ${userId}, code=${statusCode}, loggedOut=${loggedOut}, msg=${msg}, detail=${disconnectDetail}`,
        );
        void this.publishSessionState(userId, s);

        if (isIntentionalOwnershipRelease) {
          this.stopRestartTimer(s);
          s.sock = undefined;
          s.starting = undefined;
          s.restartAttempts = 0;
          s.info = { status: 'not_connected' };
          s.lastChangeAt = Date.now();
          void this.publishSessionState(userId, s);
          return;
        }

        // Понятные пользователю сообщения по кодам отключения (Baileys DisconnectReason).
        const userFriendlyError = (): string => {
          switch (statusCode) {
            case 401:
              // Baileys иногда помечает конфликт с другим устройством как 401 + message c "conflict".
              // В этом случае явно подсвечиваем именно конфликт.
              if (msg.toLowerCase().includes('conflict')) {
                return 'WhatsApp закрыл эту сессию из‑за конфликта с другим устройством. В «Связанных устройствах» оставьте только это подключение и отсканируйте QR-код заново.';
              }
              return 'Вы вышли из аккаунта на телефоне или отвязали устройство. Отсканируйте QR-код заново.';
            case 403:
              return 'WhatsApp заблокировал доступ (например, за подозрительную активность). Обновите приложение, подождите и попробуйте снова.';
            case 408:
              return msg.includes('QR refs attempts ended')
                ? 'QR-код устарел или привязка отклонена. В WhatsApp: «Настройки → Связанные устройства», закройте старые сессии и попробуйте снова.'
                : 'Временный сетевой обрыв с WhatsApp. Пробуем восстановить соединение автоматически.';
            case 411:
              return 'Включите мультиустройства в WhatsApp: Настройки → Связанные устройства → Мультиустройства.';
            case 428:
              return 'Соединение закрыто. Нажмите «Сканировать QR-код ещё раз».';
            case 440:
              return 'Этот аккаунт привязан с другого места. В WhatsApp отвяжите лишние устройства и подключите снова через QR.';
            case 500:
              return 'Сессия повреждена. Нажмите «Сканировать QR-код ещё раз» для новой привязки.';
            case 503:
              return 'Серверы WhatsApp временно недоступны. Подождите несколько минут и попробуйте снова.';
            case 515:
              return 'WhatsApp запросил перезапуск. Нажмите «Сканировать QR-код ещё раз».';
            default:
              return msg;
          }
        };

        // Коды, после которых не делаем авто-рестарт — показываем ошибку и предлагаем повторить вручную.
        const noRetryCodes = new Set([
          DisconnectReason.loggedOut, // 401
          DisconnectReason.forbidden, // 403
          DisconnectReason.multideviceMismatch, // 411
          DisconnectReason.connectionReplaced, // 440
          DisconnectReason.badSession, // 500
          DisconnectReason.unavailableService, // 503
        ]);

        // Частый кейс: кратковременные сетевые обрывы 408 (WebSocket Error/timeout).
        // Важно не сносить auth-сессию в таких случаях: пытаемся мягко восстановиться
        // с более длинным экспоненциальным backoff и отдельным "временным" статусом.
        const isTransient408 =
          statusCode === 408 && !msg.includes('QR refs attempts ended');
        if (isTransient408) {
          s.proxyConsecutiveTimeouts = Number(s.proxyConsecutiveTimeouts ?? 0) + 1;
          if (
            proxySettings.enabled &&
            proxySettings.failOpenDirect &&
            (s.proxyConsecutiveTimeouts ?? 0) >=
              Number(proxySettings.maxConsecutiveFailures || 6)
          ) {
            s.proxyBypassUntil = Date.now() + 10 * 60_000;
            s.proxyConsecutiveTimeouts = 0;
            this.logger.warn(
              `[WA proxy] bypass enabled for userId=${userId} until=${new Date(
                s.proxyBypassUntil,
              ).toISOString()} after consecutive 408`,
            );
          }
          s.restartAttempts += 1;
          const maxAttempts = this.WA_TRANSIENT_RETRY_MAX_ATTEMPTS;
          const nextAttempt = s.restartAttempts;

          // 2.5s, 5s, 10s, 20s, 40s, 60s... + небольшой jitter.
          const baseDelay = Math.min(2500 * 2 ** (nextAttempt - 1), 60_000);
          const delay = withJitter(baseDelay, 1500);
          const nextRetryAtIso = new Date(Date.now() + delay).toISOString();

          s.info = {
            status: 'temporary_network_issue',
            lastError:
              'Сеть до WhatsApp нестабильна (ETIMEDOUT). Пробуем восстановить соединение автоматически.',
            retryAttempt: Math.min(nextAttempt, maxAttempts),
            retryMax: maxAttempts,
            nextRetryAt: nextRetryAtIso,
            networkIssue: true,
            wsReachability: s.info.wsReachability ?? 'unknown',
            wsLastCheckAt: s.info.wsLastCheckAt ?? null,
            wsRttMs: s.info.wsRttMs ?? null,
            wsError: s.info.wsError ?? null,
          };
          s.lastChangeAt = Date.now();
          this.probeWaReachability(userId, s).catch(() => undefined);

          // Сразу отпускаем закрытый сокет (как в ветке после maxAttempts), чтобы до
          // следующего startInternal не держать ссылку на полумёртвое соединение.
          try {
            s.sock?.end?.(new Error('transient_408_early_release'));
          } catch {}
          s.sock = undefined;

          this.stopRestartTimer(s);
          s.restartTimer = setTimeout(() => {
            s.restartTimer = undefined;
            if (s.restartAttempts <= maxAttempts) {
              this.logger.warn(
                `Auto-restart WA after transient 408 for ${userId} (attempt ${s.restartAttempts}, delay=${delay}ms)`,
              );
              this.startSession(userId).catch(() => undefined);
            } else {
              // Не рвём сессию принудительно: держим мягкий авто-ретрай с большим интервалом.
              // Это позволяет дождаться восстановления маршрута без ручного disconnect/reset.
              s.info = {
                status: 'temporary_network_issue',
                lastError:
                  'Сеть до WhatsApp нестабильна (серия ETIMEDOUT). Продолжаем мягкие попытки восстановления.',
                retryAttempt: maxAttempts,
                retryMax: maxAttempts,
                nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
                networkIssue: true,
                wsReachability: s.info.wsReachability ?? 'unknown',
                wsLastCheckAt: s.info.wsLastCheckAt ?? null,
                wsRttMs: s.info.wsRttMs ?? null,
                wsError: s.info.wsError ?? null,
              };
              s.lastChangeAt = Date.now();
              const softDelay = withJitter(60_000, 10_000);
              this.stopRestartTimer(s);
              s.restartTimer = setTimeout(() => {
                s.restartTimer = undefined;
                this.logger.warn(
                  `Auto-restart WA in soft mode for ${userId} (attempt>${maxAttempts}, delay=${softDelay}ms)`,
                );
                this.startSession(userId).catch(() => undefined);
              }, softDelay);
            }
          }, delay);
          return;
        }

        if (statusCode === 408 && msg.includes('QR refs attempts ended')) {
          this.stopRestartTimer(s);
          s.sock = undefined;
          s.restartAttempts = 0;
          s.info = { status: 'error', lastError: userFriendlyError() };
          s.lastChangeAt = Date.now();
          // Для QR-стейтов лучше не повторять с теми же creds: сразу очищаем authDir,
          // чтобы следующий start гарантированно получил свежий QR.
          this.scheduleAuthDirCleanup(userId);
          return;
        }

        // Конфликт/замена соединения: переводим в обычное состояние "не подключено" и очищаем authDir,
        // чтобы следующий старт гарантированно показал новый QR (без ручного "сброса" пользователем).
        if (isConflict401 || isConnectionReplaced) {
          this.stopRestartTimer(s);
          try {
            s.sock?.end?.(new Error('conflict_or_replaced'));
          } catch {}
          s.sock = undefined;
          s.restartAttempts = 0;
          s.info = { status: 'not_connected', lastError: userFriendlyError() };
          s.lastChangeAt = Date.now();
          this.scheduleAuthDirCleanup(userId);
          return;
        }

        if (loggedOut) {
          this.stopRestartTimer(s);
          s.restartAttempts = 0;
          // Важно: не удаляем папку авторизации прямо здесь.
          // У Baileys параллельно могут идти асинхронные записи creds/state, и удаление директории
          // может приводить к падениям процесса. Для перепривязки достаточно показать QR и/или
          // дать пользователю вручную "сбросить" сессию отдельной кнопкой/эндпоинтом.
          try {
            s.sock?.end?.(new Error('loggedOut'));
          } catch {}
          s.sock = undefined;
          s.info = { status: 'not_connected', lastError: userFriendlyError() };
          s.lastChangeAt = Date.now();
          // Аккуратно очищаем папку авторизации чуть позже, чтобы при следующем запуске
          // сразу получить новый QR без "битых" cred'ов.
          this.scheduleAuthDirCleanup(userId);
          return;
        }

        if (statusCode !== undefined && noRetryCodes.has(statusCode)) {
          this.stopRestartTimer(s);
          s.sock = undefined;
          s.restartAttempts = 0;
          s.info = { status: 'error', lastError: userFriendlyError() };
          s.lastChangeAt = Date.now();
          return;
        }

        s.restartAttempts += 1;
        s.info = { status: 'connecting', lastError: userFriendlyError() };
        s.lastChangeAt = Date.now();

        const delay = Math.min(2000 * s.restartAttempts, 10_000);
        this.stopRestartTimer(s);
        s.restartTimer = setTimeout(() => {
          s.restartTimer = undefined;
          if (s.restartAttempts <= 5) {
            this.logger.warn(
              `Auto-restart WA for ${userId} (attempt ${s.restartAttempts})`,
            );
            this.startSession(userId).catch(() => undefined);
          } else {
            s.sock = undefined;
            s.restartAttempts = 0;
            s.info = { status: 'error', lastError: s.info.lastError ?? msg };
            s.lastChangeAt = Date.now();
          }
        }, delay);
      }
    });
  }
}
