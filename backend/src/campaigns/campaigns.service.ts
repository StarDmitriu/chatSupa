// backend/src/campaigns/campaigns.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { QueueService } from '../queue/queue.service';
import { CampaignVipService } from '../queue/campaign-vip.service';
import { classifyDeliveryError } from '../queue/delivery-error-classifier';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { TelegramService } from '../telegram/telegram.service';
import { applyTelegramGroupsTgPhoneScope } from '../telegram/telegram-groups-phone-scope';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { DateTime } from 'luxon';
import { runtimeHasCapability } from '../runtime/runtime-role';

/**
 * Нормализация TG chat id для сопоставления "123" и "-100123".
 * Используется ТОЛЬКО как ключ для сравнения/матчинга.
 * В campaign_jobs.group_jid пишем исходный tg_chat_id из БД групп, чтобы отправка работала.
 */
function normalizeTgChatIdKey(jid: string): string {
  const s = String(jid ?? '').trim();
  if (!s) return '';
  if (s.startsWith('-100')) return s;
  if (s.startsWith('-')) return s; // уже отрицательный id
  if (/^\d+$/.test(s)) return `-100${s}`;
  return s;
}

/** TG targets: пустое значение = legacy (до колонки tg_account_key); WA всегда "" */
const LEGACY_TEMPLATE_TG_ACCOUNT_KEY = '';

function isMissingTgAccountKeyColumn(err: unknown): boolean {
  return String((err as any)?.message ?? err).includes('tg_account_key');
}

function randInt(min: number, max: number) {
  const a = Number.isFinite(min) ? min : 0;
  const b = Number.isFinite(max) ? max : a;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

function parseHHMM(hhmm: string) {
  const [h, m] = (hhmm || '08:00').split(':').map((x) => Number(x));
  return { h: Number.isFinite(h) ? h : 8, m: Number.isFinite(m) ? m : 0 };
}

function nextFixedTime(base: DateTime, hhmm: string) {
  const { h, m } = parseHHMM(hhmm);
  let target = base.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (target < base) target = target.plus({ days: 1 });
  return target;
}

export type RepeatScheduleKind = 'minutes' | 'next_day' | 'clock_time';

function normalizeRepeatScheduleKind(v: unknown): RepeatScheduleKind {
  const s = String(v ?? '').toLowerCase();
  if (s === 'next_day' || s === 'clock_time' || s === 'minutes') return s;
  return 'minutes';
}

function normalizeRepeatClockTime(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim();
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) return s;
  const { h, m } = parseHHMM(fallback);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Когда поставить следующую волну (часовой пояс кампании). */
function computeNextRepeatAtLuxon(
  tz: string,
  kind: RepeatScheduleKind,
  timeFrom: string,
  repeatClockTime: string | null,
  repMin: number,
  repMax: number,
): DateTime {
  const now = DateTime.now().setZone(tz);
  if (kind === 'next_day') {
    const { h, m } = parseHHMM(timeFrom);
    return now
      .startOf('day')
      .plus({ days: 1 })
      .set({ hour: h, minute: m, second: 0, millisecond: 0 });
  }
  if (kind === 'clock_time') {
    const hhmm =
      repeatClockTime &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(repeatClockTime)
        ? repeatClockTime
        : timeFrom;
    return nextFixedTime(now, hhmm);
  }
  const mins = randInt(repMin, repMax);
  return now.plus({ minutes: mins });
}

/** Если время попало вне окна — переносим на ближайшее разрешённое. */
/** Поддерживает окна и "через полночь" (например 21:00–06:00). */
function clampToWindow(dt: DateTime, fromHHMM: string, toHHMM: string) {
  const from = parseHHMM(fromHHMM);
  const to = parseHHMM(toHHMM);

  const startToday = dt.set({
    hour: from.h,
    minute: from.m,
    second: 0,
    millisecond: 0,
  });

  const endToday = dt.set({
    hour: to.h,
    minute: to.m,
    second: 0,
    millisecond: 0,
  });

  const crossesMidnight = from.h > to.h || (from.h === to.h && from.m > to.m);

  // обычное окно (например 08:00–17:00)
  if (!crossesMidnight) {
    if (dt < startToday) return startToday;
    if (dt > endToday) return startToday.plus({ days: 1 });
    return dt;
  }

  // окно через полночь (например 21:00–06:00)
  // Разрешено: [21:00..24:00) ИЛИ [00:00..06:00]
  // Если dt после полуночи (00:00..06:00) — конец окна "сегодня", а старт был "вчера".
  if (dt >= startToday) {
    // вечерняя часть (21:00..24:00)
    return dt;
  }

  if (dt <= endToday) {
    // утренняя часть (00:00..06:00)
    return dt;
  }

  // иначе мы "днём" (между 06:00 и 21:00) — переносим на ближайшее 21:00
  return startToday;
}

type GroupScheduleSpec =
  | { kind: 'fixed'; hhmm: string }
  | { kind: 'interval'; minMinutes: number; maxMinutes: number };

/** Supabase/PostgREST often caps one response at 1000 rows, so large campaigns are paginated. */
const SELECT_PAGE_SIZE = 1000;
const JOBS_SELECT_LIMIT = 50_000;
const GROUPS_SELECT_LIMIT = 100_000;
const TARGETS_SELECT_LIMIT = 200_000;

const GROUP_INTERVALS: Record<
  string,
  { minMinutes: number; maxMinutes: number }
> = {
  '2-5m': { minMinutes: 2, maxMinutes: 5 },
  '5-15m': { minMinutes: 5, maxMinutes: 15 },
  '15-30m': { minMinutes: 15, maxMinutes: 30 },
  '30-60m': { minMinutes: 30, maxMinutes: 60 },
  '1-2h': { minMinutes: 60, maxMinutes: 120 },
  '2-4h': { minMinutes: 120, maxMinutes: 240 },
  '4h': { minMinutes: 240, maxMinutes: 240 },
  '6h': { minMinutes: 360, maxMinutes: 360 },
  '6-12h': { minMinutes: 360, maxMinutes: 720 },
  '12h': { minMinutes: 720, maxMinutes: 720 },
  '24h': { minMinutes: 1440, maxMinutes: 1440 },
};

function parseGroupScheduleSpec(v: any): GroupScheduleSpec | null {
  const s = String(v || '').trim();
  if (!s) return null;
  // В интерфейсе поле "tg_default_send_time" и override для TG обозначены как "интервал".
  // Поэтому HH:mm трактуем как длительность (например 00:05 => 5 минут), а не как "фиксированное время суток".
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
    const { h, m } = parseHHMM(s);
    const totalMinutes = h * 60 + m;
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return null;
    return { kind: 'interval', minMinutes: totalMinutes, maxMinutes: totalMinutes };
  }
  const interval = GROUP_INTERVALS[s];
  if (!interval) return null;
  return {
    kind: 'interval',
    minMinutes: interval.minMinutes,
    maxMinutes: interval.maxMinutes,
  };
}

function clampInt(n: any, lo: number, hi: number, def: number) {
  const x = Number(n);
  if (!Number.isFinite(x)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(x)));
}

function applySpeedFactorToDelaySeconds(baseSec: number, speedFactor: number) {
  // speedFactor: 100 = default; 200 = 2x faster (delay / 2); 50 = 2x slower (delay * 2)
  const sf = clampInt(speedFactor, 10, 400, 100);
  const scaled = Math.round((Number(baseSec) || 0) * (100 / sf));
  return Math.max(1, scaled);
}

/**
 * При `between_groups_scale_template === true` паузы между группами в волне берутся только из
 * полей шаблона `wa_between_groups_sec_*` / `tg_between_groups_sec_*` (форма создания/редактирования).
 * Константы TEMPLATE_* и `betweenGroupsSec*` кампании не подмешиваются в ритм волны (только режим
 * `between_groups_scale_template === false` может использовать betweenGroupsSec* с запуска).
 *
 * При `between_groups_scale_template === false` в кампанию попадают `betweenGroupsSecMin` / `Max`
 * из запуска, с clamp `BETWEEN_GROUPS_SEC_ABS_*`, без множителя коэффициента шаблона.
 */
const TEMPLATE_BETWEEN_GROUPS_WA_MIN_SEC = 45;
const TEMPLATE_BETWEEN_GROUPS_WA_MAX_SEC = 120;
const TEMPLATE_BETWEEN_GROUPS_TG_MIN_SEC = 45;
const TEMPLATE_BETWEEN_GROUPS_TG_MAX_SEC = 90;

const BETWEEN_GROUPS_SEC_ABS_MIN = 5;
const BETWEEN_GROUPS_SEC_ABS_MAX = 600;

function clampBetweenGroupsSecPair(
  minRaw: number | undefined,
  maxRaw: number | undefined,
  ch: 'wa' | 'tg',
): { min: number; max: number } {
  const defMin =
    ch === 'tg'
      ? TEMPLATE_BETWEEN_GROUPS_TG_MIN_SEC
      : TEMPLATE_BETWEEN_GROUPS_WA_MIN_SEC;
  const defMax =
    ch === 'tg'
      ? TEMPLATE_BETWEEN_GROUPS_TG_MAX_SEC
      : TEMPLATE_BETWEEN_GROUPS_WA_MAX_SEC;
  let mn = Number.isFinite(Number(minRaw)) ? Math.floor(Number(minRaw)) : defMin;
  let mx = Number.isFinite(Number(maxRaw)) ? Math.floor(Number(maxRaw)) : defMax;
  mn = Math.max(
    BETWEEN_GROUPS_SEC_ABS_MIN,
    Math.min(BETWEEN_GROUPS_SEC_ABS_MAX, mn),
  );
  mx = Math.max(
    BETWEEN_GROUPS_SEC_ABS_MIN,
    Math.min(BETWEEN_GROUPS_SEC_ABS_MAX, mx),
  );
  if (mn > mx) return { min: mx, max: mn };
  return { min: mn, max: mx };
}

/** Явный диапазон пауз между группами из карточки шаблона (сек). Иначе — кампания × %. */
function templateExplicitBetweenGroupsPause(
  template: any,
  channel: 'wa' | 'tg',
): { min: number; max: number } | null {
  const minKey =
    channel === 'wa'
      ? 'wa_between_groups_sec_min'
      : 'tg_between_groups_sec_min';
  const maxKey =
    channel === 'wa'
      ? 'wa_between_groups_sec_max'
      : 'tg_between_groups_sec_max';
  const lo = Number(template?.[minKey]);
  const hi = Number(template?.[maxKey]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  let mn = Math.max(5, Math.min(600, Math.floor(lo)));
  let mx = Math.max(5, Math.min(600, Math.floor(hi)));
  if (mn > mx) [mn, mx] = [mx, mn];
  return { min: mn, max: mx };
}

/**
 * Диапазон `between_groups_sec_*` в кампании при `between_groups_scale_template=true`:
 * только по явным паузам из карточек шаблонов (агрегат min/max по шаблонам).
 * Если ни у кого нет пары сек в БД — fallback TEMPLATE_* (legacy / миграции не применены).
 */
function computeStoredBetweenGroupsForScaledTemplates(
  templates: any[],
  channel: 'wa' | 'tg',
): { min: number; max: number } {
  const fbMin =
    channel === 'tg'
      ? TEMPLATE_BETWEEN_GROUPS_TG_MIN_SEC
      : TEMPLATE_BETWEEN_GROUPS_WA_MIN_SEC;
  const fbMax =
    channel === 'tg'
      ? TEMPLATE_BETWEEN_GROUPS_TG_MAX_SEC
      : TEMPLATE_BETWEEN_GROUPS_WA_MAX_SEC;
  const explicits: { min: number; max: number }[] = [];
  for (const t of templates) {
    const p = templateExplicitBetweenGroupsPause(t, channel);
    if (p) explicits.push(p);
  }
  if (explicits.length === 0) {
    return { min: fbMin, max: fbMax };
  }
  return {
    min: Math.min(...explicits.map((e) => e.min)),
    max: Math.max(...explicits.map((e) => e.max)),
  };
}

export type StartMultiOptions = {
  timeFrom?: string; // "08:00"
  timeTo?: string; // "17:00"
  betweenGroupsSecMin?: number;
  betweenGroupsSecMax?: number;
  /** true: база TEMPLATE_* и × speed_factor шаблона; false: только betweenGroupsSec* (страница рассылок), без множителя */
  betweenGroupsScaleWithTemplateSpeed?: boolean;
  betweenTemplatesMinMin?: number;
  betweenTemplatesMinMax?: number;

  // автоповтор волн
  repeatEnabled?: boolean;
  repeatMinMin?: number; // минут
  repeatMinMax?: number; // минут
  repeatScheduleKind?: RepeatScheduleKind;
  /** HH:mm для clock_time (иначе сервер подставит timeFrom). */
  repeatClockTime?: string;
  channel?: 'wa' | 'tg';
};

export type RequeueOptions = {
  includeSent?: boolean;
  forceNow?: boolean;
  statuses?: Array<
    'pending' | 'processing' | 'failed' | 'skipped' | 'sent' | 'paused'
  >;
};

type JobStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'skipped';

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);
  private readonly groupDeliverySummaryCache = new Map<
    string,
    { expiresAtMs: number; payload: any }
  >();
  private readonly autoHealLastRunByCampaign = new Map<string, number>();
  private readonly orphanRequeueLogLastAt = new Map<string, number>();
  private readonly tgForcedSyncLastRunByUser = new Map<string, number>();
  private runtimeHealModeOverride: 'normal' | 'incident' | null = null;
  private runtimeHealModeUntilMs = 0;
  private duePendingSamples: number[] = [];
  private campaignPausedColumnSupported: boolean | null = null;
  private pausedJobStatusSupported: boolean | null = null;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly queueService: QueueService,
    private readonly campaignVip: CampaignVipService,
    private readonly whatsappService: WhatsappService,
    private readonly telegramService: TelegramService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  private async fetchCampaignJobsPage(
    campaignId: string,
    offset: number,
    limit: number,
  ): Promise<{ data: any[] | null; error: any }> {
    const safeLimit = Math.max(1, Math.min(SELECT_PAGE_SIZE, Math.floor(limit)));
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from('campaign_jobs')
      .select('id, group_jid, template_id, status, scheduled_at, sent_at, error')
      .eq('campaign_id', campaignId)
      .order('scheduled_at', { ascending: true })
      .range(offset, offset + safeLimit - 1);
    return { data: data ?? null, error };
  }

  private async fetchCampaignJobsAll(
    campaignId: string,
    maxRows = JOBS_SELECT_LIMIT,
  ): Promise<{ data: any[] | null; error: any; truncated: boolean }> {
    const out: any[] = [];
    for (let offset = 0; offset < maxRows; offset += SELECT_PAGE_SIZE) {
      const remaining = maxRows - offset;
      const { data, error } = await this.fetchCampaignJobsPage(
        campaignId,
        offset,
        Math.min(SELECT_PAGE_SIZE, remaining),
      );
      if (error) return { data: null, error, truncated: false };
      const rows = data ?? [];
      out.push(...rows);
      if (rows.length < Math.min(SELECT_PAGE_SIZE, remaining)) {
        return { data: out, error: null, truncated: false };
      }
    }
    return { data: out, error: null, truncated: true };
  }

  private isMissingCampaignPausedColumnError(err: unknown): boolean {
    return String((err as any)?.message ?? err).includes('campaigns.paused');
  }

  private isPausedJobStatusUnsupportedError(err: unknown): boolean {
    return String((err as any)?.message ?? err).includes(
      'invalid input value for enum campaign_job_status: "paused"',
    );
  }

  private async getRunnableCampaignIds(campaignIds: string[]): Promise<Set<string>> {
    const ids = campaignIds.map((id) => String(id || '').trim()).filter(Boolean);
    const out = new Set<string>();
    if (ids.length === 0) return out;

    const supabase = this.supabaseService.getClient();
    const tryWithPaused =
      this.campaignPausedColumnSupported === null ||
      this.campaignPausedColumnSupported === true;

    if (tryWithPaused) {
      const { data, error } = await supabase
        .from('campaigns')
        .select('id, status, paused')
        .in('id', ids);
      if (!error) {
        this.campaignPausedColumnSupported = true;
        for (const c of data ?? []) {
          const id = String((c as any)?.id || '').trim();
          if (!id) continue;
          if (String((c as any)?.status || '') === 'running' && !(c as any)?.paused) {
            out.add(id);
          }
        }
        return out;
      }
      if (!this.isMissingCampaignPausedColumnError(error)) {
        return out;
      }
      this.campaignPausedColumnSupported = false;
    }

    const { data } = await supabase
      .from('campaigns')
      .select('id, status')
      .in('id', ids);
    for (const c of data ?? []) {
      const id = String((c as any)?.id || '').trim();
      if (!id) continue;
      if (String((c as any)?.status || '') === 'running') {
        out.add(id);
      }
    }
    return out;
  }

  private async getActiveRunningCampaigns(
    limit: number,
  ): Promise<Array<{ id: string; user_id: string; channel: 'wa' | 'tg'; status: string; paused: boolean }>> {
    const supabase = this.supabaseService.getClient();
    const tryWithPaused =
      this.campaignPausedColumnSupported === null ||
      this.campaignPausedColumnSupported === true;

    if (tryWithPaused) {
      const { data, error } = await supabase
        .from('campaigns')
        .select('id, user_id, channel, status, paused')
        .eq('status', 'running')
        .eq('paused', false)
        .limit(limit);
      if (!error) {
        this.campaignPausedColumnSupported = true;
        return (data ?? []) as any;
      }
      if (!this.isMissingCampaignPausedColumnError(error)) {
        return [];
      }
      this.campaignPausedColumnSupported = false;
    }

    const { data } = await supabase
      .from('campaigns')
      .select('id, user_id, channel, status')
      .eq('status', 'running')
      .limit(limit);
    return (data ?? []).map((c: any) => ({ ...c, paused: false })) as any;
  }

  private async loadCampaignForRepeatCompat(campaignId: string): Promise<{
    data: any | null;
    error: any;
  }> {
    const supabase = this.supabaseService.getClient();
    const selectWithPaused = `id, user_id, status, channel, paused, timezone, time_from, time_to,
         repeat_enabled, repeat_schedule_kind, repeat_clock_time,
         repeat_min_min, repeat_min_max, next_repeat_at,
         between_groups_sec_min, between_groups_sec_max, between_groups_scale_template,
         between_templates_min_min, between_templates_min_max`;
    const selectWithoutPaused = `id, user_id, status, channel, timezone, time_from, time_to,
         repeat_enabled, repeat_schedule_kind, repeat_clock_time,
         repeat_min_min, repeat_min_max, next_repeat_at,
         between_groups_sec_min, between_groups_sec_max, between_groups_scale_template,
         between_templates_min_min, between_templates_min_max`;

    const tryWithPaused =
      this.campaignPausedColumnSupported === null ||
      this.campaignPausedColumnSupported === true;
    if (tryWithPaused) {
      const first = await supabase
        .from('campaigns')
        .select(selectWithPaused)
        .eq('id', campaignId)
        .maybeSingle();
      if (!first.error) {
        this.campaignPausedColumnSupported = true;
        return first;
      }
      if (!this.isMissingCampaignPausedColumnError(first.error)) {
        return first;
      }
      this.campaignPausedColumnSupported = false;
    }

    const second = await supabase
      .from('campaigns')
      .select(selectWithoutPaused)
      .eq('id', campaignId)
      .maybeSingle();
    if (second.data) {
      (second.data as any).paused = false;
    }
    return second;
  }

  private isRepeatOverlapAllowed(): boolean {
    const overlap =
      String(process.env.CAMPAIGN_REPEAT_ALLOW_OVERLAP || '').toLowerCase() ===
      'true';
    const forceUnsafe =
      String(process.env.CAMPAIGN_REPEAT_OVERLAP_FORCE_UNSAFE || '').toLowerCase() ===
      'true';
    if (overlap && !forceUnsafe) {
      this.logger.error(
        '[Campaigns] invariant violation: CAMPAIGN_REPEAT_ALLOW_OVERLAP=true is blocked; set CAMPAIGN_REPEAT_OVERLAP_FORCE_UNSAFE=true only for emergency rollback',
      );
      return false;
    }
    return overlap && forceUnsafe;
  }

  private campaignHealMode(): 'normal' | 'incident' {
    if (this.runtimeHealModeOverride && Date.now() < this.runtimeHealModeUntilMs) {
      return this.runtimeHealModeOverride;
    }
    const raw = String(process.env.CAMPAIGN_HEAL_MODE || 'normal')
      .toLowerCase()
      .trim();
    return raw === 'incident' ? 'incident' : 'normal';
  }

  getEffectiveHealMode(): 'normal' | 'incident' {
    return this.campaignHealMode();
  }

  async detectAndApplyIncidentMode(): Promise<{
    success: boolean;
    mode: 'normal' | 'incident';
    triggers: string[];
  }> {
    const supabase = this.supabaseService.getClient();
    const now = Date.now();
    const window15mIso = new Date(now - 15 * 60_000).toISOString();
    const window5mIso = new Date(now - 5 * 60_000).toISOString();
    const [failedTgRes, channelInvalidRes, duePendingRes, processingRes] =
      await Promise.all([
        supabase
          .from('campaign_jobs')
          .select('*', { count: 'exact', head: true })
          .eq('channel', 'tg')
          .eq('status', 'failed')
          .gte('sent_at', window15mIso),
        supabase
          .from('campaign_jobs')
          .select('*', { count: 'exact', head: true })
          .eq('channel', 'tg')
          .eq('status', 'failed')
          .gte('sent_at', window15mIso)
          .ilike('error', '%CHANNEL_INVALID%'),
        supabase
          .from('campaign_jobs')
          .select('*', { count: 'exact', head: true })
          .eq('channel', 'tg')
          .eq('status', 'pending')
          .lte('scheduled_at', new Date().toISOString()),
        supabase
          .from('campaign_jobs')
          .select('*', { count: 'exact', head: true })
          .eq('channel', 'tg')
          .eq('status', 'processing')
          .gte('updated_at', window5mIso),
      ]);

    const tgFailed = failedTgRes.count ?? 0;
    const tgChannelInvalid = channelInvalidRes.count ?? 0;
    const duePending = duePendingRes.count ?? 0;
    const processingRecent = processingRes.count ?? 0;

    this.duePendingSamples.push(duePending);
    if (this.duePendingSamples.length > 3) this.duePendingSamples.shift();
    const duePendingGrowing3x =
      this.duePendingSamples.length >= 3 &&
      this.duePendingSamples[0] < this.duePendingSamples[1] &&
      this.duePendingSamples[1] < this.duePendingSamples[2];

    const triggers: string[] = [];
    if (tgFailed > 0 && tgChannelInvalid / tgFailed > 0.2) {
      triggers.push('channel_invalid_rate_15m');
    }
    if (duePendingGrowing3x) {
      triggers.push('due_pending_growing_3_windows');
    }
    if (duePending > 0 && processingRecent === 0) {
      triggers.push('processing_zero_with_due_pending');
    }

    if (triggers.length > 0) {
      this.runtimeHealModeOverride = 'incident';
      this.runtimeHealModeUntilMs = now + 15 * 60_000;
      await this.persistRecoveryAuditEvent({
        userId: 'system',
        channel: 'tg',
        eventType: 'incident_mode_switch',
        label: 'incident',
        error: triggers.join(','),
      });
      return { success: true, mode: 'incident', triggers };
    }

    if (
      this.runtimeHealModeOverride === 'incident' &&
      Date.now() >= this.runtimeHealModeUntilMs
    ) {
      this.runtimeHealModeOverride = 'normal';
      this.runtimeHealModeUntilMs = now + 5 * 60_000;
      await this.persistRecoveryAuditEvent({
        userId: 'system',
        channel: 'tg',
        eventType: 'incident_mode_switch',
        label: 'normal',
      });
    }
    return { success: true, mode: this.campaignHealMode(), triggers };
  }

  private tgForceSyncBeforeWaveEnabled(): boolean {
    return String(process.env.TG_FORCE_SYNC_BEFORE_WAVE_ENABLED || 'true')
      .toLowerCase()
      .trim() !== 'false';
  }

  private tgForceSyncBeforeWaveThreshold(): number {
    const raw = Number(
      (process.env.TG_FORCE_SYNC_TARGET_GROUPS_THRESHOLD || '150').trim(),
    );
    if (!Number.isFinite(raw)) return 150;
    return Math.max(1, Math.min(5000, Math.floor(raw)));
  }

  private tgForceSyncBeforeWaveCooldownMs(): number {
    const raw = Number(
      (process.env.TG_FORCE_SYNC_COOLDOWN_MS || String(6 * 60 * 60 * 1000)).trim(),
    );
    if (!Number.isFinite(raw)) return 6 * 60 * 60 * 1000;
    return Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Math.floor(raw)));
  }

  private async listSelectedTgGroupsAll(userId: string): Promise<any[]> {
    const supabase = this.supabaseService.getClient();
    const activeAccountKey = await this.telegramService.getActiveTgAccountKey(userId);
    if (!activeAccountKey) {
      this.logger.warn(
        `[Campaigns] listSelectedTgGroupsAll: active TG account key missing (userId=${userId})`,
      );
      return [];
    }
    const batch = 1000;
    const out: any[] = [];
    for (let offset = 0; offset < 100_000; offset += batch) {
      let q = supabase
        .from('telegram_groups')
        .select(
          'tg_chat_id, tg_type, tg_access_hash, quarantine_until, quarantine_reason',
        )
        .eq('user_id', userId)
        .eq('is_selected', true);
      q = applyTelegramGroupsTgPhoneScope(q, activeAccountKey);
      const { data, error } = await q.range(offset, offset + batch - 1);
      if (error) break;
      const rows = data ?? [];
      out.push(...rows);
      if (rows.length < batch) break;
    }
    return out;
  }

  private async listEnabledTgTargetsAll(userId: string): Promise<any[]> {
    const activeAccountKey = await this.telegramService.getActiveTgAccountKey(userId);
    if (!activeAccountKey) return [];
    const supabase = this.supabaseService.getClient();
    const batch = 1000;
    const out: any[] = [];
    const accountKeyFilter = [
      activeAccountKey,
      LEGACY_TEMPLATE_TG_ACCOUNT_KEY,
    ];
    for (let offset = 0; offset < 100_000; offset += batch) {
      let q = supabase
        .from('template_group_targets')
        .select('group_jid, tg_account_key')
        .eq('user_id', userId)
        .eq('channel', 'tg')
        .eq('enabled', true)
        .in('tg_account_key', accountKeyFilter);
      let { data, error } = await q.range(offset, offset + batch - 1);
      if (error && isMissingTgAccountKeyColumn(error)) {
        const r2 = await supabase
          .from('template_group_targets')
          .select('group_jid')
          .eq('user_id', userId)
          .eq('channel', 'tg')
          .eq('enabled', true)
          .range(offset, offset + batch - 1);
        data = r2.data as typeof data;
        error = r2.error as any;
      }
      if (error) break;
      const rows = data ?? [];
      out.push(...rows);
      if (rows.length < batch) break;
    }

    let poolQ = supabase
      .from('telegram_groups')
      .select('tg_chat_id')
      .eq('user_id', userId);
    poolQ = applyTelegramGroupsTgPhoneScope(poolQ, activeAccountKey);
    const { data: poolRows } = await poolQ;
    const gSet = new Set(
      (poolRows ?? [])
        .map((r: any) => normalizeTgChatIdKey(String(r.tg_chat_id || '')))
        .filter(Boolean),
    );
    return out.filter((row: any) => {
      const acc = String(row.tg_account_key ?? '').trim();
      const hasCol = 'tg_account_key' in row;
      const k = normalizeTgChatIdKey(String(row.group_jid ?? ''));
      if (!k) return false;
      if (hasCol) {
        if (acc === activeAccountKey) return true;
        if (acc === LEGACY_TEMPLATE_TG_ACCOUNT_KEY) return gSet.has(k);
        return false;
      }
      return gSet.has(k);
    });
  }

  private async estimateTgTargetGroupsForUser(userId: string): Promise<number> {
    const [groups, targets] = await Promise.all([
      this.listSelectedTgGroupsAll(userId),
      this.listEnabledTgTargetsAll(userId),
    ]);
    const gSet = new Set(
      (groups ?? [])
        .map((r: any) => normalizeTgChatIdKey(String(r.tg_chat_id || '')))
        .filter(Boolean),
    );
    const tSet = new Set(
      (targets ?? [])
        .map((r: any) => normalizeTgChatIdKey(String(r.group_jid || '')))
        .filter(Boolean),
    );
    let count = 0;
    for (const id of tSet) {
      if (gSet.has(id)) count += 1;
    }
    return count;
  }

  private async maybeForceTgSyncBeforeWave(
    userId: string,
    campaignId: string,
  ): Promise<void> {
    if (!this.tgForceSyncBeforeWaveEnabled()) return;
    const targetCount = await this.estimateTgTargetGroupsForUser(userId);
    const threshold = this.tgForceSyncBeforeWaveThreshold();
    if (targetCount < threshold) return;
    const now = Date.now();
    const cooldownMs = this.tgForceSyncBeforeWaveCooldownMs();
    const last = this.tgForcedSyncLastRunByUser.get(userId) ?? 0;
    if (now - last < cooldownMs) return;
    this.tgForcedSyncLastRunByUser.set(userId, now);
    const syncRes = await this.telegramService.syncGroups(userId);
    await this.persistRecoveryAuditEvent({
      userId,
      channel: 'tg',
      eventType: 'tg_forced_sync_before_wave',
      campaignId,
      label: syncRes?.success ? 'success' : 'failed',
      error: syncRes?.success
        ? null
        : String((syncRes as any)?.message || 'sync_failed'),
    });
    this.logger.log(
      `[Campaigns] TG forced sync before wave (campaign=${campaignId}, userId=${userId}, targets=${targetCount}, success=${syncRes?.success === true})`,
    );
  }

  private async persistRecoveryAuditEvent(params: {
    userId: string;
    channel: 'wa' | 'tg';
    eventType: string;
    campaignId?: string | null;
    jobId?: string | null;
    groupJid?: string | null;
    templateId?: string | null;
    label?: string | null;
    error?: string | null;
    seconds?: number | null;
  }) {
    const supabase = this.supabaseService.getClient();
    try {
      await supabase.from('limit_learning_events').insert({
        user_id: params.userId,
        channel: params.channel,
        event_type: params.eventType,
        seconds: params.seconds ?? null,
        campaign_id: params.campaignId ?? null,
        job_id: params.jobId ?? null,
        group_jid: params.groupJid ?? null,
        template_id: params.templateId ?? null,
        label: params.label ? String(params.label).slice(0, 120) : null,
        error: params.error ? String(params.error).slice(0, 500) : null,
      });
    } catch {
      // best-effort audit trail
    }
  }

  // =========================
  // ACTIVE CAMPAIGN (running) for user
  // =========================
  async getActiveCampaign(userId: string, channel: 'wa' | 'tg') {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase
      .from('campaigns')
      .select('id, status, created_at')
      .eq('user_id', userId)
      .eq('status', 'running')
      .eq('channel', channel)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return {
        success: false,
        message: 'supabase_campaign_select_error',
        error,
      };
    }

    return {
      success: true,
      active: data ? { campaignId: String((data as any).id) } : null,
    };
  }

  async tgPreflight(
    userId: string,
    badRateThreshold = 0.15,
  ): Promise<{
    success: boolean;
    totalTargets: number;
    resolvableTargets: number;
    unresolvableTargets: number;
    badRate: number;
    threshold: number;
    ok: boolean;
  }> {
    const [groups, targets] = await Promise.all([
      this.listSelectedTgGroupsAll(userId),
      this.listEnabledTgTargetsAll(userId),
    ]);
    const groupMap = new Map<string, any>();
    for (const g of groups ?? []) {
      groupMap.set(normalizeTgChatIdKey(String((g as any).tg_chat_id || '')), g);
    }
    const nowMs = Date.now();
    let totalTargets = 0;
    let unresolvableTargets = 0;
    let staleUnresolvableTargets = 0;
    const targetSet = new Set(
      (targets ?? [])
        .map((t: any) => normalizeTgChatIdKey(String((t as any).group_jid || '')))
        .filter(Boolean),
    );
    for (const key of targetSet) {
      totalTargets += 1;
      const g: any = groupMap.get(key);
      if (!g) {
        unresolvableTargets += 1;
        continue;
      }
      const quarantineReason = String((g as any).quarantine_reason || '');
      if (quarantineReason.startsWith('stale_not_in_dialogs')) {
        unresolvableTargets += 1;
        staleUnresolvableTargets += 1;
        continue;
      }
      const q = (g as any).quarantine_until;
      if (q) {
        const qt = new Date(String(q)).getTime();
        if (Number.isFinite(qt) && qt > nowMs) {
          unresolvableTargets += 1;
          continue;
        }
      }
      const tgType = String((g as any).tg_type || '');
      const hasHash = String((g as any).tg_access_hash || '').trim().length > 0;
      const resolvable =
        tgType === 'chat' || (tgType === 'channel' && hasHash) || tgType === '';
      if (!resolvable) unresolvableTargets += 1;
    }
    const badRate = totalTargets > 0 ? unresolvableTargets / totalTargets : 0;
    const threshold = Math.max(0.01, Math.min(0.9, Number(badRateThreshold) || 0.15));
    if (staleUnresolvableTargets > 0) {
      await this.persistRecoveryAuditEvent({
        userId,
        channel: 'tg',
        eventType: 'tg_preflight_unresolvable_stale',
        label: `stale=${staleUnresolvableTargets}/${totalTargets}`,
      });
    }
    return {
      success: true,
      totalTargets,
      resolvableTargets: Math.max(0, totalTargets - unresolvableTargets),
      unresolvableTargets,
      badRate,
      threshold,
      ok: badRate <= threshold,
    };
  }

  private tgPreflightBlockMode(): 'block' | 'warn' {
    const raw = String(process.env.TG_PREFLIGHT_BLOCK_MODE || 'warn')
      .toLowerCase()
      .trim();
    return raw === 'block' ? 'block' : 'warn';
  }

  /** Статус паузы по каналу: true если есть хотя бы одна running-кампания с paused=true. */
  async getPauseState(userId: string, channel: 'wa' | 'tg') {
    const supabase = this.supabaseService.getClient();
    let data: any = null;
    let error: any = null;

    if (this.campaignPausedColumnSupported !== false) {
      const first = await supabase
        .from('campaigns')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'running')
        .eq('channel', channel)
        .eq('paused', true)
        .limit(1)
        .maybeSingle();
      data = first.data;
      error = first.error;
      if (error && this.isMissingCampaignPausedColumnError(error)) {
        this.campaignPausedColumnSupported = false;
        data = null;
        error = null;
      }
    }

    if (error) {
      return {
        success: false,
        message: 'supabase_campaign_select_error',
        error,
      };
    }

    const campaignId = data ? String((data as any).id) : '';
    let reason: string | null = null;

    if (campaignId) {
      let j: any = null;
      let jErr: any = null;
      if (this.pausedJobStatusSupported !== false) {
        const first = await supabase
          .from('campaign_jobs')
          .select('error')
          .eq('campaign_id', campaignId)
          .eq('status', 'paused')
          .not('error', 'is', null)
          .limit(1)
          .maybeSingle();
        j = first.data;
        jErr = first.error;
        if (jErr && this.isPausedJobStatusUnsupportedError(jErr)) {
          this.pausedJobStatusSupported = false;
          j = null;
          jErr = null;
        }
      }

      if (!jErr && j && (j as any).error) {
        reason = String((j as any).error || '').trim() || null;
      }
    }

    return {
      success: true,
      paused: !!data,
      reason,
      campaignId: campaignId || null,
    };
  }

  /** Включить/выключить паузу всех running-рассылок по каналу. При снятии паузы — переставить в очередь job'ы со статусом paused. */
  async setPause(userId: string, channel: 'wa' | 'tg', paused: boolean) {
    const supabase = this.supabaseService.getClient();

    // Снять паузу (Возобновить) можно только при активной подписке; админ всегда проходит
    if (!paused) {
      const access = await this.subscriptionsService.hasAccessForChannel(
        userId,
        channel,
      );
      if (!access.allowed) {
        return {
          success: false,
          message: access.reason || 'subscription_expired',
        };
      }
    }

    if (this.campaignPausedColumnSupported === false) {
      return {
        success: false,
        message: 'pause_not_supported_by_schema',
      };
    }

    const { data: campaigns, error: upErr } = await supabase
      .from('campaigns')
      .update({ paused })
      .eq('user_id', userId)
      .eq('status', 'running')
      .eq('channel', channel)
      .select('id');

    if (upErr) {
      if (this.isMissingCampaignPausedColumnError(upErr)) {
        this.campaignPausedColumnSupported = false;
        return {
          success: false,
          message: 'pause_not_supported_by_schema',
        };
      }
      return {
        success: false,
        message: 'supabase_campaign_update_error',
        error: upErr,
      };
    }

    const ids = (campaigns ?? []).map((c: any) => String(c.id));
    if (ids.length === 0) {
      return { success: true, paused, updated: 0, enqueued: 0 };
    }

    let enqueued = 0;
    if (!paused) {
      let pausedJobs: any[] | null = null;
      let jErr: any = null;
      if (this.pausedJobStatusSupported !== false) {
        const first = await supabase
          .from('campaign_jobs')
          .select('id, user_id, group_jid, template_id, scheduled_at, channel')
          .in('campaign_id', ids)
          .eq('status', 'paused');
        pausedJobs = first.data;
        jErr = first.error;
        if (jErr && this.isPausedJobStatusUnsupportedError(jErr)) {
          this.pausedJobStatusSupported = false;
          pausedJobs = null;
          jErr = null;
        }
      }

      if (!jErr && pausedJobs?.length) {
        enqueued = await this.resumePausedJobsWithScheduleShift(pausedJobs);
      }
    }

    return {
      success: true,
      paused,
      updated: ids.length,
      enqueued,
    };
  }

  /** Список рассылок пользователя (последние 50): сначала самые новые — для отчётов и аналитики. */
  async getCampaignsList(userId: string) {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from('campaigns')
      .select('id, status, channel, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false, nullsFirst: false }) // последние первыми, без даты — в конец
      .limit(50);

    if (error) {
      return {
        success: false,
        message: 'supabase_campaign_select_error',
        error,
      };
    }
    const list = (data ?? []).map((r: any) => ({
      id: String(r.id),
      status: r.status,
      channel: r.channel,
      created_at: r.created_at,
    }));
    return { success: true, campaigns: list };
  }

  /**
   * Расширенная диагностика кампаний для админки (по клиентам).
   * Возвращает агрегированные метрики без выдачи полного списка job'ов.
   */
  async getAdminCampaignDiagnostics(params?: {
    limit?: number;
    userId?: string;
  }): Promise<{
    success: boolean;
    campaigns?: Array<{
      campaign_id: string;
      user_id: string;
      user_phone: string | null;
      user_name: string | null;
      channel: 'wa' | 'tg';
      status: string;
      total: number;
      sent: number;
      failed: number;
      pending: number;
      processing: number;
      skipped: number;
      paused: number;
      retried: number;
      slow: number;
      created_at: string | null;
      started_at: string | null;
      last_attempt_at: string | null;
      completed_at: string | null;
      overload_level: 'normal' | 'elevated' | 'high' | 'critical';
      overload_hits_5m: number;
      overload_factor: number;
      fast_wake_5m: number;
    }>;
    message?: string;
    error?: any;
  }> {
    const supabase = this.supabaseService.getClient();
    const limit = Math.max(1, Math.min(100, Number(params?.limit ?? 40)));
    const userIdFilter = String(params?.userId || '').trim();

    let q = supabase
      .from('campaigns')
      .select('id, user_id, channel, status, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (userIdFilter) q = q.eq('user_id', userIdFilter);

    const { data: campaigns, error } = await q;
    if (error) {
      return {
        success: false,
        message: 'supabase_campaigns_select_error',
        error,
      };
    }
    if (!campaigns?.length) return { success: true, campaigns: [] };

    const userIds = [
      ...new Set((campaigns ?? []).map((c: any) => String(c.user_id || '')).filter(Boolean)),
    ];
    const campaignIds = [
      ...new Set((campaigns ?? []).map((c: any) => String(c.id || '')).filter(Boolean)),
    ];
    const { data: users } = await supabase
      .from('users')
      .select('id, phone, full_name')
      .in('id', userIds);
    const userMap = new Map<string, { phone: string | null; full_name: string | null }>();
    for (const u of users ?? []) {
      userMap.set(String((u as any).id || ''), {
        phone: (u as any).phone ?? null,
        full_name: (u as any).full_name ?? null,
      });
    }

    const fastWakeByCampaign = new Map<string, number>();
    if (campaignIds.length > 0) {
      const sinceIso = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data: wakeEvents } = await supabase
        .from('limit_learning_events')
        .select('campaign_id, event_type')
        .in('campaign_id', campaignIds)
        .in('event_type', ['wa_fast_wake', 'tg_fast_wake'])
        .gte('created_at', sinceIso)
        .limit(5000);
      for (const ev of wakeEvents ?? []) {
        const cid = String((ev as any).campaign_id || '').trim();
        if (!cid) continue;
        fastWakeByCampaign.set(cid, (fastWakeByCampaign.get(cid) ?? 0) + 1);
      }
    }

    const rows = await Promise.all(
      (campaigns ?? []).map(async (c: any) => {
        const campaignId = String(c.id || '');
        const userId = String(c.user_id || '');
        const channel: 'wa' | 'tg' = c.channel === 'tg' ? 'tg' : 'wa';

        const { data: jobs, error: jErr } =
          await this.fetchCampaignJobsAll(campaignId);

        if (jErr) {
          return {
            campaign_id: campaignId,
            user_id: userId,
            user_phone: userMap.get(userId)?.phone ?? null,
            user_name: userMap.get(userId)?.full_name ?? null,
            channel,
            status: String(c.status || ''),
            total: 0,
            sent: 0,
            failed: 0,
            pending: 0,
            processing: 0,
            skipped: 0,
            paused: 0,
            retried: 0,
            slow: 0,
            created_at: c.created_at ?? null,
            started_at: null,
            last_attempt_at: null,
            completed_at: null,
            overload_level: 'normal' as const,
            overload_hits_5m: 0,
            overload_factor: 1,
            fast_wake_5m: fastWakeByCampaign.get(campaignId) ?? 0,
          };
        }

        const counters: Record<JobStatus | 'paused', number> = {
          pending: 0,
          processing: 0,
          sent: 0,
          failed: 0,
          skipped: 0,
          paused: 0,
        };
        let retried = 0;
        let slow = 0;
        let startedAtMs: number | null = null;
        let lastAttemptAtMs: number | null = null;

        for (const j of jobs ?? []) {
          const s = String((j as any).status || '');
          const errText = String((j as any).error || '');
          const sentAtRaw = String((j as any).sent_at || '');
          const scheduledAtRaw = String((j as any).scheduled_at || '');
          const sentAtMs = sentAtRaw ? new Date(sentAtRaw).getTime() : NaN;
          const scheduledAtMs = scheduledAtRaw
            ? new Date(scheduledAtRaw).getTime()
            : NaN;
          if (s === 'paused') counters.paused += 1;
          else if (counters[s as keyof typeof counters] !== undefined)
            (counters as any)[s] += 1;

          if (errText.startsWith('tg_flood_wait_')) {
            retried += 1;
            slow += 1;
          } else if (errText === 'stale_processing') {
            slow += 1;
          }

          const hasAttemptFinal =
            s === 'sent' || s === 'failed' || s === 'skipped' || s === 'paused';
          if (hasAttemptFinal) {
            const attemptMs = Number.isFinite(sentAtMs)
              ? sentAtMs
              : Number.isFinite(scheduledAtMs)
                ? scheduledAtMs
                : NaN;
            if (Number.isFinite(attemptMs)) {
              if (startedAtMs == null || attemptMs < startedAtMs)
                startedAtMs = attemptMs;
              if (lastAttemptAtMs == null || attemptMs > lastAttemptAtMs)
                lastAttemptAtMs = attemptMs;
            }
          }
        }

        const done =
          counters.pending === 0 &&
          counters.processing === 0 &&
          counters.paused === 0;
        const overload = await this.computeOverloadState({
          userId,
          channelHint: channel,
        });

        return {
          campaign_id: campaignId,
          user_id: userId,
          user_phone: userMap.get(userId)?.phone ?? null,
          user_name: userMap.get(userId)?.full_name ?? null,
          channel,
          status: String(c.status || ''),
          total: (jobs ?? []).length,
          sent: counters.sent,
          failed: counters.failed,
          pending: counters.pending,
          processing: counters.processing,
          skipped: counters.skipped,
          paused: counters.paused,
          retried,
          slow,
          created_at: c.created_at ?? null,
          started_at:
            startedAtMs != null ? new Date(startedAtMs).toISOString() : null,
          last_attempt_at:
            lastAttemptAtMs != null ? new Date(lastAttemptAtMs).toISOString() : null,
          completed_at:
            done && lastAttemptAtMs != null
              ? new Date(lastAttemptAtMs).toISOString()
              : null,
          overload_level: overload.level,
          overload_hits_5m: overload.hits5m,
          overload_factor: overload.factor,
          fast_wake_5m: fastWakeByCampaign.get(campaignId) ?? 0,
        };
      }),
    );

    return { success: true, campaigns: rows };
  }

  // =========================
  // START MULTI (если уже есть running — вернуть её)
  // =========================
  async startMulti(userId: string, opts: StartMultiOptions = {}) {
    const supabase = this.supabaseService.getClient();

    const ch = opts.channel === 'tg' ? 'tg' : 'wa';

    const { data: running, error: rErr } = await supabase
      .from('campaigns')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'running')
      .eq('channel', ch) // ✅ ВАЖНО
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (rErr) {
      return {
        success: false,
        message: 'supabase_campaign_select_error',
        error: rErr,
      };
    }

    if (running?.id) {
      this.logger.log(
        `[Campaigns] START: already running campaign=${running.id} (userId=${userId}, channel=${ch})`,
      );
      return {
        success: true,
        campaignId: String((running as any).id),
        alreadyRunning: true,
        message: 'already_running',
      };
    }

    // ✅ Проверяем подключение перед запуском рассылки (после проверки already_running)
    if (ch === 'wa') {
      const waStatus = await this.whatsappService.getStatus(userId);
      if (waStatus.status !== 'connected') {
        return {
          success: false,
          message: 'whatsapp_not_connected',
        };
      }
    } else {
      // Telegram: считаем подключённым, если в users есть tg_session
      const { data: u, error: uErr } = await supabase
        .from('users')
        .select('id, tg_session')
        .eq('id', userId)
        .maybeSingle();

      if (uErr) {
        return {
          success: false,
          message: 'supabase_users_error',
          error: uErr,
        };
      }

      if (!(u as any)?.tg_session) {
        return {
          success: false,
          message: 'telegram_not_connected',
        };
      }

      const preflightThreshold = Number(
        process.env.TG_PREFLIGHT_BAD_RATE_THRESHOLD || '0.15',
      );
      const preflight = await this.tgPreflight(userId, preflightThreshold);
      if (!preflight.ok && this.tgPreflightBlockMode() === 'block') {
        return {
          success: false,
          message: 'tg_preflight_blocked',
          preflight,
          recommendation: 'run_sync_repair_then_restart',
        };
      }
      if (!preflight.ok) {
        this.logger.warn(
          `[Campaigns] TG preflight warning mode: badRate=${(
            preflight.badRate * 100
          ).toFixed(1)}% (userId=${userId})`,
        );
      }
    }

    // timezone пользователя (fallback UTC)
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, timezone')
      .eq('id', userId)
      .maybeSingle();

    if (userErr) {
      return {
        success: false,
        message: 'supabase_users_error',
        error: userErr,
      };
    }

    const tz =
      (user as any)?.timezone || process.env.DEFAULT_TZ || 'Europe/Moscow';

    // настройки времени/задержек
    const time_from = opts.timeFrom ?? '08:00';
    const time_to = opts.timeTo ?? '17:00';

    const scaleTemplate = opts.betweenGroupsScaleWithTemplateSpeed !== false;

    let between_groups_sec_min: number;
    let between_groups_sec_max: number;

    if (scaleTemplate) {
      const { templates: pauseTpl, error: pauseTplErr } =
        await this.fetchEnabledMessageTemplates(userId);
      if (!pauseTplErr && pauseTpl?.length) {
        const pair = computeStoredBetweenGroupsForScaledTemplates(pauseTpl, ch);
        between_groups_sec_min = pair.min;
        between_groups_sec_max = pair.max;
      } else {
        if (pauseTplErr) {
          this.logger.warn(
            `[Campaigns] startMulti: could not load templates for pause envelope userId=${userId}: ${String((pauseTplErr as any)?.message ?? pauseTplErr)}; using TEMPLATE_* defaults`,
          );
        }
        between_groups_sec_min =
          ch === 'tg'
            ? TEMPLATE_BETWEEN_GROUPS_TG_MIN_SEC
            : TEMPLATE_BETWEEN_GROUPS_WA_MIN_SEC;
        between_groups_sec_max =
          ch === 'tg'
            ? TEMPLATE_BETWEEN_GROUPS_TG_MAX_SEC
            : TEMPLATE_BETWEEN_GROUPS_WA_MAX_SEC;
      }
    } else {
      const pair = clampBetweenGroupsSecPair(
        opts.betweenGroupsSecMin,
        opts.betweenGroupsSecMax,
        ch,
      );
      between_groups_sec_min = pair.min;
      between_groups_sec_max = pair.max;
    }

    const between_groups_scale_template = scaleTemplate;

    const rawBtMin = Number.isFinite(opts.betweenTemplatesMinMin)
      ? Number(opts.betweenTemplatesMinMin)
      : NaN;
    const rawBtMax = Number.isFinite(opts.betweenTemplatesMinMax)
      ? Number(opts.betweenTemplatesMinMax)
      : NaN;
    const between_templates_min_min =
      Number.isFinite(rawBtMin) && rawBtMin > 0 ? rawBtMin : 2;
    const between_templates_min_max =
      Number.isFinite(rawBtMax) && rawBtMax > 0 ? rawBtMax : 3;

    // repeat settings
    const repeat_enabled = !!opts.repeatEnabled;
    const scheduleKind = repeat_enabled
      ? normalizeRepeatScheduleKind(opts.repeatScheduleKind)
      : ('minutes' as RepeatScheduleKind);
    const repeat_clock_time = repeat_enabled
      ? normalizeRepeatClockTime(opts.repeatClockTime, time_from)
      : null;

    const repeat_min_min = Number.isFinite(opts.repeatMinMin)
      ? Number(opts.repeatMinMin)
      : 120;
    const repeat_min_max = Number.isFinite(opts.repeatMinMax)
      ? Number(opts.repeatMinMax)
      : 180;

    const next_repeat_at = repeat_enabled
      ? computeNextRepeatAtLuxon(
          tz,
          scheduleKind,
          time_from,
          scheduleKind === 'clock_time' ? repeat_clock_time : null,
          repeat_min_min,
          repeat_min_max,
        ).toUTC()
          .toISO()
      : null;

    if (ch === 'tg') {
      await this.maybeForceTgSyncBeforeWave(userId, 'new_campaign');
    }

    // 1) создаём кампанию (сразу running — так лучше с уникальным индексом)
    const { data: camp, error: cErr } = await supabase
      .from('campaigns')
      .insert({
        user_id: userId,
        status: 'running',
        mode: 'multi',
        time_from,
        time_to,
        timezone: tz,

        between_groups_sec_min,
        between_groups_sec_max,
        between_groups_scale_template,
        between_templates_min_min,
        between_templates_min_max,

        repeat_enabled,
        repeat_schedule_kind: repeat_enabled ? scheduleKind : null,
        repeat_clock_time:
          repeat_enabled && scheduleKind === 'clock_time'
            ? repeat_clock_time
            : null,
        repeat_min_min:
          repeat_enabled && scheduleKind === 'minutes'
            ? repeat_min_min
            : null,
        repeat_min_max:
          repeat_enabled && scheduleKind === 'minutes'
            ? repeat_min_max
            : null,
        next_repeat_at,
        channel: opts.channel === 'tg' ? 'tg' : 'wa',
      })
      .select('id')
      .single();

    // если стоит уникальный индекс и словили гонку — вернём уже существующую running
    if (cErr) {
      const pe = (cErr as any)?.message || String(cErr);
      const ph = (cErr as any)?.hint;
      this.logger.warn(
        `[Campaigns] startMulti insert failed userId=${userId} channel=${ch}: ${pe}${ph ? ` hint=${ph}` : ''}`,
      );
      const code = (cErr as any)?.code;
      if (code === '23505') {
        const { data: r2 } = await supabase
          .from('campaigns')
          .select('id')
          .eq('user_id', userId)
          .eq('status', 'running')
          .eq('channel', ch)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (r2?.id) {
          return {
            success: true,
            campaignId: String((r2 as any).id),
            alreadyRunning: true,
            message: 'already_running',
          };
        }
      }

      return {
        success: false,
        message: 'supabase_campaign_insert_error',
        error: cErr,
      };
    }

    if (!camp) {
      return { success: false, message: 'supabase_campaign_insert_empty' };
    }

    const campaignId = String((camp as any).id);

    // 2) создаём 1 волну
    const waveRes = await this.createWaveAndEnqueue({
      campaignId,
      userId,
      tz,
      time_from,
      time_to,
      betweenGroupsSecMin: between_groups_sec_min,
      betweenGroupsSecMax: between_groups_sec_max,
      scaleGroupDelaysWithTemplateSpeed: between_groups_scale_template,
      betweenTemplatesMinMin: between_templates_min_min,
      betweenTemplatesMinMax: between_templates_min_max,
      baseIso: DateTime.now().setZone(tz).toISO()!,
      channel: opts.channel === 'tg' ? 'tg' : 'wa',
      allowNoJobs: false,
    });

    if (!waveRes.success) {
      // откатываем кампанию, чтобы не висела running без jobs
      await supabase
        .from('campaigns')
        .update({
          status: 'stopped',
          repeat_enabled: false,
          next_repeat_at: null,
        })
        .eq('id', campaignId);

      return waveRes;
    }

    return {
      success: true,
      campaignId,
      alreadyRunning: false,
      groups: waveRes.groups,
      templates: waveRes.templates,
      jobs: waveRes.jobs,
      settings: {
        timeFrom: time_from,
        timeTo: time_to,
        betweenGroupsSecMin: between_groups_sec_min,
        betweenGroupsSecMax: between_groups_sec_max,
        betweenTemplatesMinMin: between_templates_min_min,
        betweenTemplatesMinMax: between_templates_min_max,
        timezone: tz,
        repeatEnabled: repeat_enabled,
        repeatScheduleKind: repeat_enabled ? scheduleKind : null,
        repeatClockTime:
          repeat_enabled && scheduleKind === 'clock_time'
            ? repeat_clock_time
            : null,
        repeatMinMin:
          repeat_enabled && scheduleKind === 'minutes'
            ? repeat_min_min
            : null,
        repeatMinMax:
          repeat_enabled && scheduleKind === 'minutes'
            ? repeat_min_max
            : null,
        nextRepeatAt: next_repeat_at,
      },
    };
  }

  // =========================
  // GET JOBS (с проверкой владельца, если передан userId)
  // =========================
  async getJobs(campaignId: string, userId?: string) {
    const supabase = this.supabaseService.getClient();
    if (userId) {
      const { data: camp, error: cErr } = await supabase
        .from('campaigns')
        .select('id')
        .eq('id', campaignId)
        .eq('user_id', userId)
        .maybeSingle();
      if (cErr || !camp)
        return { success: false, message: 'campaign_not_found', error: cErr };
    }
    const { data, error } = await supabase
      .from('campaign_jobs')
      .select(
        'id, group_jid, template_id, status, scheduled_at, sent_at, error',
      )
      .eq('campaign_id', campaignId)
      .order('scheduled_at', { ascending: true })
      .limit(JOBS_SELECT_LIMIT);

    if (error)
      return { success: false, message: 'supabase_jobs_select_error', error };
    return { success: true, jobs: data ?? [] };
  }

  // =========================
  // PROGRESS (с проверкой владельца, если передан userId)
  // =========================
  async getProgress(campaignId: string, userId?: string) {
    const supabase = this.supabaseService.getClient();

    let query = supabase
      .from('campaigns')
      .select('id, status, created_at, channel, user_id')
      .eq('id', campaignId);
    if (userId) query = query.eq('user_id', userId);
    const { data: camp, error: cErr } = await query.maybeSingle();

    if (cErr || !camp)
      return { success: false, message: 'campaign_not_found', error: cErr };

    const { data: jobs, error: jErr, truncated } =
      await this.fetchCampaignJobsAll(campaignId);

    if (jErr) {
      return {
        success: false,
        message: 'supabase_jobs_select_error',
        error: jErr,
      };
    }

    const counters: Record<JobStatus | 'paused', number> = {
      pending: 0,
      processing: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      paused: 0,
    };
    let retried = 0;
    let slow = 0;
    let startedAtMs: number | null = null;
    let lastAttemptAtMs: number | null = null;

    for (const j of jobs ?? []) {
      const s = String((j as any).status || '');
      const err = String((j as any).error || '');
      const sentAtRaw = String((j as any).sent_at || '');
      const scheduledAtRaw = String((j as any).scheduled_at || '');
      const sentAtMs = sentAtRaw ? new Date(sentAtRaw).getTime() : NaN;
      const scheduledAtMs = scheduledAtRaw
        ? new Date(scheduledAtRaw).getTime()
        : NaN;
      if (s === 'paused') counters.paused += 1;
      else if (counters[s as keyof typeof counters] !== undefined)
        (counters as any)[s] += 1;

      // Метрики повторов/замедлений для отчётов:
      // - tg_flood_wait_* означает что задача была отложена/повторена (retried) и шла медленнее (slow).
      // - stale_processing также считаем замедлением.
      if (err.startsWith('tg_flood_wait_')) {
        retried += 1;
        slow += 1;
      } else if (err === 'stale_processing') {
        slow += 1;
      }

      const hasAttemptFinal =
        s === 'sent' || s === 'failed' || s === 'skipped' || s === 'paused';
      if (hasAttemptFinal) {
        const attemptMs = Number.isFinite(sentAtMs)
          ? sentAtMs
          : Number.isFinite(scheduledAtMs)
            ? scheduledAtMs
            : NaN;
        if (Number.isFinite(attemptMs)) {
          if (startedAtMs == null || attemptMs < startedAtMs) startedAtMs = attemptMs;
          if (lastAttemptAtMs == null || attemptMs > lastAttemptAtMs)
            lastAttemptAtMs = attemptMs;
        }
      }
    }

    const total = (jobs ?? []).length;
    const done =
      counters.pending === 0 &&
      counters.processing === 0 &&
      counters.paused === 0;

    const overload = await this.computeOverloadState({
      userId: String((camp as any).user_id || ''),
      channelHint:
        String((camp as any).channel || '') === 'tg'
          ? 'tg'
          : String((camp as any).channel || '') === 'wa'
            ? 'wa'
            : undefined,
    });

    return {
      success: true,
      campaignId: (camp as any).id,
      created_at: (camp as any).created_at ?? null,
      started_at:
        startedAtMs != null ? new Date(startedAtMs).toISOString() : null,
      last_attempt_at:
        lastAttemptAtMs != null ? new Date(lastAttemptAtMs).toISOString() : null,
      completed_at:
        done && lastAttemptAtMs != null
          ? new Date(lastAttemptAtMs).toISOString()
          : null,
      total,
      sent: counters.sent,
      failed: counters.failed,
      pending: counters.pending,
      processing: counters.processing,
      skipped: counters.skipped,
      paused: counters.paused,
      retried,
      slow,
      overload_level: overload.level,
      overload_hits_5m: overload.hits5m,
      overload_factor: overload.factor,
      done,
      jobs: jobs ?? [],
      truncated,
    };
  }

  async getRecentOutcomes(
    campaignId: string,
    userId?: string,
    windowMinutes = 5,
  ) {
    const supabase = this.supabaseService.getClient();
    const safeWindowMinutes = Math.max(1, Math.min(60, Math.floor(windowMinutes)));

    let query = supabase
      .from('campaigns')
      .select('id, user_id, channel')
      .eq('id', campaignId);
    if (userId) query = query.eq('user_id', userId);
    const { data: camp, error: cErr } = await query.maybeSingle();
    if (cErr || !camp) {
      return { success: false, message: 'campaign_not_found', error: cErr };
    }

    const fromIso = new Date(Date.now() - safeWindowMinutes * 60_000).toISOString();
    const { data: rows, error } = await supabase
      .from('campaign_jobs')
      .select('status,error,sent_at')
      .eq('campaign_id', campaignId)
      .in('status', ['sent', 'failed'])
      .gte('sent_at', fromIso)
      .order('sent_at', { ascending: false })
      .limit(5000);
    if (error) {
      return { success: false, message: 'supabase_jobs_select_error', error };
    }

    let sent = 0;
    let failed = 0;
    let failedTransient = 0;
    let failedExhausted = 0;
    for (const r of rows ?? []) {
      const status = String((r as any).status || '');
      const errText = String((r as any).error || '');
      if (status === 'sent') {
        sent += 1;
        continue;
      }
      if (status === 'failed') {
        failed += 1;
        if (errText === 'wa_connectivity_retry_exhausted') failedExhausted += 1;
        const channel: 'wa' | 'tg' =
          String((camp as any).channel || 'wa') === 'tg' ? 'tg' : 'wa';
        const classified = classifyDeliveryError(channel, errText);
        if (classified.kind === 'transient') failedTransient += 1;
      }
    }

    return {
      success: true,
      campaignId,
      channel: String((camp as any).channel || 'wa') === 'tg' ? 'tg' : 'wa',
      windowMinutes: safeWindowMinutes,
      rates: {
        sentPerMinute: Number((sent / safeWindowMinutes).toFixed(3)),
        failedPerMinute: Number((failed / safeWindowMinutes).toFixed(3)),
      },
      counts: {
        sent,
        failed,
        failedTransient,
        failedExhausted,
      },
      from: fromIso,
      at: new Date().toISOString(),
    };
  }

  async getGroupDeliverySummary(
    userId: string,
    params: {
      channel: 'wa' | 'tg';
      groupJids: string[];
      lookbackDays?: number;
      includeTemplatesIncluded?: boolean;
    },
  ) {
    const supabase = this.supabaseService.getClient();
    const channel: 'wa' | 'tg' = params.channel === 'tg' ? 'tg' : 'wa';
    const uniqInput = Array.from(
      new Set((params.groupJids || []).map((x) => String(x || '').trim()).filter(Boolean)),
    ).slice(0, 2000);
    if (!uniqInput.length) {
      return { success: true, channel, summaries: {} };
    }

    const lookbackDaysRaw = Number(
      params.lookbackDays ?? process.env.CAMPAIGN_GROUP_SUMMARY_LOOKBACK_DAYS ?? 14,
    );
    const lookbackDays = Number.isFinite(lookbackDaysRaw)
      ? Math.max(1, Math.min(365, Math.floor(lookbackDaysRaw)))
      : 30;
    const fromIso = new Date(
      Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const keyOf = (jid: string) =>
      channel === 'tg' ? normalizeTgChatIdKey(jid) : String(jid);
    const includeTemplatesIncluded = params.includeTemplatesIncluded === true;
    const sortedIds = [...uniqInput].sort();
    const idsHash = sortedIds.join('|');
    const cacheKey = `${userId}:${channel}:${lookbackDays}:${includeTemplatesIncluded ? 1 : 0}:${idsHash}`;
    const nowMs = Date.now();
    const cached = this.groupDeliverySummaryCache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.payload;
    }

    const lookupKeys = new Set<string>();
    for (const jid of uniqInput) {
      lookupKeys.add(jid);
      const k = keyOf(jid);
      if (k && k !== jid) lookupKeys.add(k);
    }

    const { data: rows, error } = await supabase
      .from('campaign_jobs')
      .select('group_jid,status,error,sent_at')
      .eq('user_id', userId)
      .eq('channel', channel)
      .in('group_jid', Array.from(lookupKeys))
      .in('status', ['sent', 'failed'])
      .gte('sent_at', fromIso)
      .limit(50000);
    if (error) {
      return { success: false, message: 'supabase_jobs_select_error', error };
    }

    type GroupSummary = {
      templatesIncluded: number;
      sent: number;
      failed: number;
      total: number;
      successRate: number;
      lastSentAt: string | null;
      lastFailedAt: string | null;
      topReasons: Array<{ reason: string; count: number }>;
    };
    const byKey = new Map<
      string,
      {
        sent: number;
        failed: number;
        lastSentAt: string | null;
        lastFailedAt: string | null;
        reasons: Map<string, number>;
      }
    >();

    const templatesByKey = new Map<string, Set<string>>();
    if (includeTemplatesIncluded) {
      const targetsLookupKeys = new Set<string>();
      for (const jid of uniqInput) {
        const k = keyOf(jid);
        if (!k) continue;
        targetsLookupKeys.add(k);
        targetsLookupKeys.add(jid);
      }
      let tq = supabase
        .from('template_group_targets')
        .select('template_id,group_jid,tg_account_key')
        .eq('user_id', userId)
        .eq('channel', channel)
        .eq('enabled', true)
        .in('group_jid', Array.from(targetsLookupKeys))
        .limit(50000);
      if (channel === 'tg') {
        const ak = await this.telegramService.getActiveTgAccountKey(userId);
        if (ak) {
          tq = tq.in('tg_account_key', [
            ak,
            LEGACY_TEMPLATE_TG_ACCOUNT_KEY,
          ]);
        }
      }
      let { data: targetRows, error: targetErr } = await tq;
      if (
        targetErr &&
        channel === 'tg' &&
        isMissingTgAccountKeyColumn(targetErr)
      ) {
        const fb = await supabase
          .from('template_group_targets')
          .select('template_id,group_jid')
          .eq('user_id', userId)
          .eq('channel', channel)
          .eq('enabled', true)
          .in('group_jid', Array.from(targetsLookupKeys))
          .limit(50000);
        targetRows = fb.data as typeof targetRows;
        targetErr = fb.error;
      }
      if (!targetErr && targetRows) {
        let tgPoolNorm = new Set<string>();
        let tgActiveForSummary: string | null = null;
        if (channel === 'tg') {
          tgActiveForSummary =
            await this.telegramService.getActiveTgAccountKey(userId);
          if (tgActiveForSummary) {
            let poolQ2 = supabase
              .from('telegram_groups')
              .select('tg_chat_id')
              .eq('user_id', userId);
            poolQ2 = applyTelegramGroupsTgPhoneScope(
              poolQ2,
              tgActiveForSummary,
            );
            const { data: poolRows } = await poolQ2;
            tgPoolNorm = new Set(
              (poolRows ?? [])
                .map((r: any) =>
                  normalizeTgChatIdKey(String(r.tg_chat_id || '')),
                )
                .filter(Boolean),
            );
          }
        }
        for (const row of targetRows as any[]) {
          const rawJid = String(row?.group_jid || '').trim();
          const templateId = String(row?.template_id || '').trim();
          if (!rawJid || !templateId) continue;
          const k = keyOf(rawJid);
          if (!k) continue;
          if (channel === 'tg' && tgActiveForSummary) {
            const acc = String(row?.tg_account_key ?? '').trim();
            const hasCol = 'tg_account_key' in row;
            if (hasCol) {
              if (acc === tgActiveForSummary) {
                /* ok */
              } else if (acc === LEGACY_TEMPLATE_TG_ACCOUNT_KEY) {
                if (!tgPoolNorm.has(k)) continue;
              } else continue;
            } else if (!tgPoolNorm.has(k)) continue;
          }
          if (!templatesByKey.has(k)) templatesByKey.set(k, new Set<string>());
          templatesByKey.get(k)!.add(templateId);
        }
      }
    }
    for (const row of rows || []) {
      const rawJid = String((row as any).group_jid || '').trim();
      if (!rawJid) continue;
      const k = keyOf(rawJid);
      if (!k) continue;
      if (!byKey.has(k)) {
        byKey.set(k, {
          sent: 0,
          failed: 0,
          lastSentAt: null,
          lastFailedAt: null,
          reasons: new Map<string, number>(),
        });
      }
      const bucket = byKey.get(k)!;
      const status = String((row as any).status || '').toLowerCase();
      const sentAtRaw = String((row as any).sent_at || '').trim();
      const errRaw = String((row as any).error || '').trim();
      if (status === 'sent') {
        bucket.sent += 1;
        if (sentAtRaw && (!bucket.lastSentAt || sentAtRaw > bucket.lastSentAt)) {
          bucket.lastSentAt = sentAtRaw;
        }
      } else if (status === 'failed') {
        bucket.failed += 1;
        if (
          sentAtRaw &&
          (!bucket.lastFailedAt || sentAtRaw > bucket.lastFailedAt)
        ) {
          bucket.lastFailedAt = sentAtRaw;
        }
        const reason =
          classifyDeliveryError(channel, errRaw).normalizedCode || 'failed';
        bucket.reasons.set(reason, (bucket.reasons.get(reason) || 0) + 1);
      }
    }

    const summaries: Record<string, GroupSummary> = {};
    for (const input of uniqInput) {
      const k = keyOf(input);
      const s = byKey.get(k);
      const sent = s?.sent ?? 0;
      const failed = s?.failed ?? 0;
      const total = sent + failed;
      const topReasons = Array.from(s?.reasons?.entries?.() || [])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason, count]) => ({ reason, count }));
      summaries[input] = {
        templatesIncluded: templatesByKey.get(k)?.size ?? 0,
        sent,
        failed,
        total,
        successRate: total > 0 ? Math.round((sent / total) * 100) : 0,
        lastSentAt: s?.lastSentAt ?? null,
        lastFailedAt: s?.lastFailedAt ?? null,
        topReasons,
      };
    }

    const payload = { success: true, channel, lookbackDays, summaries };
    this.groupDeliverySummaryCache.set(cacheKey, {
      expiresAtMs: nowMs + 45_000,
      payload,
    });
    return payload;
  }

  // =========================
  // STOP (с проверкой владельца, если передан userId)
  // =========================
  async stopCampaign(campaignId: string, userId?: string) {
    const supabase = this.supabaseService.getClient();

    let updateQuery = supabase
      .from('campaigns')
      .update({
        status: 'stopped',
        repeat_enabled: false,
        next_repeat_at: null,
      })
      .eq('id', campaignId);
    if (userId) updateQuery = updateQuery.eq('user_id', userId);
    const { data: updated, error: uErr } = await updateQuery
      .select('id')
      .maybeSingle();
    if (uErr)
      return {
        success: false,
        message: 'supabase_campaign_update_error',
        error: uErr,
      };
    if (!updated) return { success: false, message: 'campaign_not_found' };

    // Обновляем job'ы батчами (по 500), чтобы не упираться в statement_timeout (57014) при большом числе задач
    const BATCH = 500;
    const nowIso = new Date().toISOString();
    let totalUpdated = 0;
    while (true) {
      const { data: batch, error: selErr } = await supabase
        .from('campaign_jobs')
        .select('id')
        .eq('campaign_id', campaignId)
        .in('status', ['pending', 'processing'])
        .limit(BATCH);
      if (selErr) {
        const code = (selErr as any)?.code;
        if (
          code === '57014' ||
          String((selErr as any)?.message || '').includes('statement timeout')
        ) {
          return { success: false, message: 'database_timeout', error: selErr };
        }
        return {
          success: false,
          message: 'supabase_jobs_select_error',
          error: selErr,
        };
      }
      if (!batch?.length) break;
      const ids = batch.map((r: any) => r.id);
      const { error: upErr } = await supabase
        .from('campaign_jobs')
        .update({
          status: 'skipped',
          error: 'campaign_stopped',
          sent_at: nowIso,
        })
        .in('id', ids);
      if (upErr) {
        const code = (upErr as any)?.code;
        if (
          code === '57014' ||
          String((upErr as any)?.message || '').includes('statement timeout')
        ) {
          return { success: false, message: 'database_timeout', error: upErr };
        }
        return {
          success: false,
          message: 'supabase_jobs_update_error',
          error: upErr,
        };
      }
      totalUpdated += ids.length;
      if (batch.length < BATCH) break;
    }

    return {
      success: true,
      message: 'campaign_stopped',
      jobsUpdated: totalUpdated,
    };
  }

  // =========================
  // REQUEUE (с проверкой владельца, если передан userId)
  // =========================
  async requeueCampaign(
    campaignId: string,
    userId?: string,
    opts: RequeueOptions = {},
  ) {
    const supabase = this.supabaseService.getClient();

    if (userId) {
      const { data: camp, error: cErr } = await supabase
        .from('campaigns')
        .select('id, channel')
        .eq('id', campaignId)
        .eq('user_id', userId)
        .maybeSingle();
      if (cErr || !camp)
        return { success: false, message: 'campaign_not_found', error: cErr };

      const ch: 'wa' | 'tg' = (camp as any).channel === 'tg' ? 'tg' : 'wa';
      const access = await this.subscriptionsService.hasAccessForChannel(
        userId,
        ch,
      );
      if (!access.allowed) {
        return {
          success: false,
          message: access.reason || 'plan_not_allowed',
        };
      }
    }

    const includeSent = !!opts.includeSent;
    const forceNow = !!opts.forceNow;
    const requestedStatuses = Array.isArray(opts.statuses)
      ? opts.statuses.filter(Boolean)
      : [];
    const statuses =
      requestedStatuses.length > 0
        ? requestedStatuses
        : includeSent
          ? ['pending', 'sent', 'failed', 'skipped', 'processing', 'paused']
          : ['pending'];

    const { data: jobs, error: jErr } = await supabase
      .from('campaign_jobs')
      .select('id, user_id, group_jid, template_id, scheduled_at, status')
      .eq('campaign_id', campaignId)
      .in('status', statuses)
      .order('scheduled_at', { ascending: true });

    if (jErr)
      return {
        success: false,
        message: 'supabase_jobs_select_error',
        error: jErr,
      };
    if (!jobs?.length)
      return { success: false, message: 'no_jobs_for_requeue' };

    const nowIso = new Date().toISOString();

    if (forceNow) {
      const ids = jobs.map((j: any) => j.id);

      const { error: upErr } = await supabase
        .from('campaign_jobs')
        .update({
          status: 'pending',
          error: null,
          sent_at: null,
          scheduled_at: nowIso,
        })
        .in('id', ids);

      if (upErr)
        return {
          success: false,
          message: 'supabase_jobs_update_error',
          error: upErr,
        };

      const { data: fresh, error: fErr } = await supabase
        .from('campaign_jobs')
        .select('id, user_id, group_jid, template_id, scheduled_at')
        .in('id', ids);

      if (fErr)
        return {
          success: false,
          message: 'supabase_jobs_refetch_error',
          error: fErr,
        };

      await this.enqueueRows(fresh ?? []);
      return {
        success: true,
        enqueued: (fresh ?? []).length,
        includeSent,
        statuses,
        forceNow: true,
      };
    }

    const firstOldMs = new Date((jobs[0] as any).scheduled_at).getTime();
    const baseMs = Date.now();

    const ids: string[] = [];
    const toEnqueue: any[] = [];

    for (const j of jobs as any[]) {
      const oldMs = new Date(j.scheduled_at).getTime();
      const delta = Math.max(0, oldMs - firstOldMs);
      const newIso = new Date(baseMs + delta).toISOString();

      const { error: uErr } = await supabase
        .from('campaign_jobs')
        .update({
          status: 'pending',
          error: null,
          sent_at: null,
          scheduled_at: newIso,
        })
        .eq('id', j.id);

      if (uErr)
        return {
          success: false,
          message: 'supabase_jobs_update_error',
          error: uErr,
        };

      ids.push(j.id);
      toEnqueue.push({
        id: j.id,
        user_id: j.user_id,
        group_jid: j.group_jid,
        template_id: j.template_id,
        scheduled_at: newIso,
      });
    }

    await this.enqueueRows(toEnqueue);
    return {
      success: true,
      enqueued: toEnqueue.length,
      includeSent,
      statuses,
      forceNow: false,
    };
  }

  /**
   * Пересчитать scheduled_at у уже созданных pending job'ов по текущим паузам из карточек шаблонов
   * (и настройке кампании between_groups_scale_template), сохранить порядок волны и переставить Bull.
   */
  async resyncPendingJobsScheduleFromTemplates(
    campaignId: string,
    userId: string,
  ) {
    const supabase = this.supabaseService.getClient();

    const { data: camp, error: cErr } = await supabase
      .from('campaigns')
      .select(
        `id, user_id, status, channel, paused, timezone, time_from, time_to,
         between_groups_sec_min, between_groups_sec_max, between_groups_scale_template`,
      )
      .eq('id', campaignId)
      .eq('user_id', userId)
      .maybeSingle();

    if (cErr || !camp) {
      return { success: false, message: 'campaign_not_found', error: cErr };
    }

    const c: any = camp;
    if (String(c.status || '') !== 'running') {
      return { success: false, message: 'campaign_not_running' };
    }

    const channel: 'wa' | 'tg' = c.channel === 'tg' ? 'tg' : 'wa';
    const access = await this.subscriptionsService.hasAccessForChannel(
      userId,
      channel,
    );
    if (!access.allowed) {
      return {
        success: false,
        message: access.reason || 'plan_not_allowed',
      };
    }

    const { data: jobs, error: jErr } = await supabase
      .from('campaign_jobs')
      .select('id, user_id, group_jid, template_id, scheduled_at, channel')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
      .order('scheduled_at', { ascending: true })
      .limit(JOBS_SELECT_LIMIT);

    if (jErr) {
      return {
        success: false,
        message: 'supabase_jobs_select_error',
        error: jErr,
      };
    }
    if (!jobs?.length) {
      return { success: false, message: 'no_pending_jobs' };
    }

    const templateIds = [
      ...new Set(
        (jobs as any[]).map((j) => String(j.template_id || '').trim()).filter(Boolean),
      ),
    ];
    if (!templateIds.length) {
      return { success: false, message: 'no_template_ids_on_jobs' };
    }

    const { data: tplRows, error: tErr } = await supabase
      .from('message_templates')
      .select(
        'id, wa_speed_factor, tg_speed_factor, wa_between_groups_sec_min, wa_between_groups_sec_max, tg_between_groups_sec_min, tg_between_groups_sec_max',
      )
      .eq('user_id', userId)
      .in('id', templateIds);

    if (tErr || !tplRows?.length) {
      return {
        success: false,
        message: 'supabase_templates_select_error',
        error: tErr,
      };
    }

    const tplById = new Map<string, any>();
    for (const row of tplRows as any[]) {
      tplById.set(String(row.id), row);
    }

    for (const tid of templateIds) {
      if (!tplById.has(tid)) {
        return {
          success: false,
          message: 'template_not_found_for_job',
          details: { templateId: tid },
        };
      }
    }

    const tz = String(c.timezone || 'UTC').trim() || 'UTC';
    const timeFrom = String(c.time_from || '08:00');
    const timeTo = String(c.time_to || '17:00');
    const scaleGroupDelaysWithTemplateSpeed =
      c.between_groups_scale_template === true;
    const bgPair = clampBetweenGroupsSecPair(
      c.between_groups_sec_min,
      c.between_groups_sec_max,
      channel,
    );
    const betweenGroupsSecMin = bgPair.min;
    const betweenGroupsSecMax = bgPair.max;

    const list = jobs as any[];
    const firstMs = new Date(String(list[0].scheduled_at || '')).getTime();
    const nowMs = Date.now();
    const anchorMs =
      Number.isFinite(firstMs) && firstMs > nowMs ? firstMs : nowMs;

    let cursor = DateTime.fromMillis(anchorMs, { zone: 'utc' }).setZone(tz);
    cursor = clampToWindow(cursor, timeFrom, timeTo);

    const planned: Array<{
      id: string;
      user_id: string;
      group_jid: string;
      template_id: string;
      channel: string;
      scheduled_at: string;
    }> = [];

    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      const template = tplById.get(String(row.template_id));

      if (scaleGroupDelaysWithTemplateSpeed) {
        const pauseOk = templateExplicitBetweenGroupsPause(template, channel);
        if (!pauseOk) {
          return {
            success: false,
            message: 'template_between_groups_required',
            details: {
              channel,
              templateId: String(template?.id ?? row.template_id),
            },
          };
        }
      }

      cursor = clampToWindow(cursor, timeFrom, timeTo);
      const scheduledAt = cursor.toUTC().toISO();

      planned.push({
        id: String(row.id),
        user_id: String(row.user_id),
        group_jid: String(row.group_jid),
        template_id: String(row.template_id),
        channel: String(row.channel || channel),
        scheduled_at: scheduledAt,
      });

      if (i < list.length - 1) {
        const tplPauseRange = templateExplicitBetweenGroupsPause(
          template,
          channel,
        );
        const baseDelay =
          tplPauseRange != null
            ? randInt(tplPauseRange.min, tplPauseRange.max)
            : randInt(betweenGroupsSecMin, betweenGroupsSecMax);
        const tplSpeedFactorBase =
          channel === 'tg'
            ? clampInt(template.tg_speed_factor, 10, 400, 100)
            : clampInt(template.wa_speed_factor, 10, 400, 100);
        const speedFactor =
          tplPauseRange || !scaleGroupDelaysWithTemplateSpeed
            ? 100
            : tplSpeedFactorBase;
        const scaledDelay = applySpeedFactorToDelaySeconds(
          baseDelay,
          speedFactor,
        );
        cursor = cursor.plus({ seconds: scaledDelay });
      }
    }

    const chunk = 40;
    for (let i = 0; i < planned.length; i += chunk) {
      const part = planned.slice(i, i + chunk);
      const results = await Promise.all(
        part.map((p) =>
          supabase
            .from('campaign_jobs')
            .update({ scheduled_at: p.scheduled_at })
            .eq('id', p.id)
            .eq('status', 'pending'),
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) {
        return {
          success: false,
          message: 'supabase_jobs_update_error',
          error: failed.error,
        };
      }
    }

    await this.enqueueRows(planned);

    const syncRes = await this.syncCampaignBetweenGroupsFromTemplates(
      campaignId,
      userId,
      channel,
    );
    if (!syncRes.success) {
      this.logger.warn(
        `[Campaigns] resyncPendingJobsScheduleFromTemplates: syncCampaignBetweenGroupsFromTemplates: ${syncRes.message}`,
      );
    }

    this.logger.log(
      `[Campaigns] RESYNC SCHEDULE: campaign=${campaignId}, userId=${userId}, channel=${channel}, jobs=${planned.length}`,
    );

    return {
      success: true,
      jobs: planned.length,
      message: 'schedule_resynced_from_templates',
    };
  }

  // =========================
  // REPEAT WAVE
  // =========================
  async repeatWaveIfReady(campaignId: string) {
    const supabase = this.supabaseService.getClient();

    const { data: camp, error: cErr } =
      await this.loadCampaignForRepeatCompat(campaignId);

    if (cErr || !camp)
      return { success: false, message: 'campaign_not_found', error: cErr };

    const c: any = camp;
    if (c.paused) return { success: false, message: 'campaign_paused' };

    // Не создаём повторную волну, если у пользователя нет доступа по подписке
    const ch: 'wa' | 'tg' = c.channel === 'tg' ? 'tg' : 'wa';
    const access = await this.subscriptionsService.hasAccessForChannel(
      c.user_id,
      ch,
    );
    if (!access.allowed) {
      this.logger.log(
        `[Campaigns] repeatWaveIfReady: no access for userId=${c.user_id} channel=${ch} reason=${access.reason}`,
      );
      // Если подписка истекла — ставим рассылку на паузу, чтобы не пытаться повторно стартовать волны.
      if (this.campaignPausedColumnSupported !== false) {
        const pauseRes = await supabase
          .from('campaigns')
          .update({ paused: true })
          .eq('id', campaignId);
        if (pauseRes.error && this.isMissingCampaignPausedColumnError(pauseRes.error)) {
          this.campaignPausedColumnSupported = false;
        }
      }
      return {
        success: false,
        message: access.reason || 'subscription_expired',
      };
    }

    if (c.status !== 'running')
      return { success: false, message: 'campaign_not_running' };
    if (!c.repeat_enabled)
      return { success: false, message: 'repeat_disabled' };
    if (!c.next_repeat_at)
      return { success: false, message: 'no_next_repeat_at' };

    // Усиленный preflight перед созданием новой волны:
    // если канал не подключен, не создаём jobs, а ставим кампанию в paused до реконнекта.
    const channel: 'wa' | 'tg' = c.channel === 'tg' ? 'tg' : 'wa';
    if (channel === 'wa') {
      let waStatus = await this.whatsappService.getStatus(String(c.user_id));
      if (waStatus.status !== 'connected') {
        const canOwnWaSession = runtimeHasCapability('worker');
        if (canOwnWaSession) {
          try {
            await this.whatsappService.startSession(String(c.user_id));
          } catch {
            // best-effort
          }
          waStatus = await this.whatsappService.getStatus(String(c.user_id));
        } else {
          this.logger.log(
            `[Campaigns] repeat preflight delegated WA reconnect to worker (campaign=${campaignId}, userId=${c.user_id}, status=${waStatus.status})`,
          );
        }
      }
      if (waStatus.status !== 'connected' && runtimeHasCapability('worker')) {
        this.logger.warn(
          `[Campaigns] repeat preflight deferred: WA not connected (campaign=${campaignId}, userId=${c.user_id})`,
        );
        return { success: false, message: 'waiting_reconnect' };
      }
    } else {
      const tgStatus = await this.telegramService.getStatus(String(c.user_id));
      if (tgStatus?.status !== 'connected') {
        this.logger.warn(
          `[Campaigns] repeat preflight deferred: TG not connected (campaign=${campaignId}, userId=${c.user_id})`,
        );
        return { success: false, message: 'waiting_reconnect' };
      }
      const preflightThreshold = Number(
        process.env.TG_PREFLIGHT_BAD_RATE_THRESHOLD || '0.15',
      );
      const preflight = await this.tgPreflight(
        String(c.user_id),
        preflightThreshold,
      );
      if (!preflight.ok && this.tgPreflightBlockMode() === 'block') {
        this.logger.warn(
          `[Campaigns] repeat preflight deferred: TG bad-rate=${(
            preflight.badRate * 100
          ).toFixed(1)}% (campaign=${campaignId}, userId=${c.user_id})`,
        );
        return { success: false, message: 'tg_preflight_blocked', preflight };
      }
      if (!preflight.ok) {
        this.logger.warn(
          `[Campaigns] repeat preflight warning mode: TG bad-rate=${(
            preflight.badRate * 100
          ).toFixed(1)}% (campaign=${campaignId}, userId=${c.user_id})`,
        );
      }
    }

    const nowIso = new Date().toISOString();
    const nextMs = new Date(c.next_repeat_at).getTime();
    if (Number.isFinite(nextMs) && nextMs > Date.now())
      return { success: true, message: 'not_time_yet' };

    // Если остались "pending/processing" с заполненной error, финализируем только НЕ-транзиентные.
    // retry-маркеры (wa_connect_retry_*, tg_connect_retry_*, tg_flood_wait_*) должны будиться fast-wake и не блокировать repeat.
    try {
      const { data: stuckRows } = await supabase
        .from('campaign_jobs')
        .select('id, channel, error')
        .eq('campaign_id', campaignId)
        .in('status', ['pending', 'processing'])
        .lte('scheduled_at', nowIso)
        .not('error', 'is', null)
        .limit(5000);
      const finalizeIds = (stuckRows ?? [])
        .filter((r: any) => {
          const channel: 'wa' | 'tg' = String((r as any).channel || 'wa') === 'tg' ? 'tg' : 'wa';
          const classification = classifyDeliveryError(
            channel,
            String((r as any).error || ''),
          );
          return classification.kind !== 'transient';
        })
        .map((r: any) => String((r as any).id || ''))
        .filter(Boolean);
      if (finalizeIds.length > 0) {
        await supabase
          .from('campaign_jobs')
          .update({
            status: 'failed',
            sent_at: nowIso,
          })
          .in('id', finalizeIds);
      }

      // Также размораживаем "вечные processing" без error/sent_at (например, если процесс умер между claim и update).
      // Если задача в processing слишком давно — считаем её failed, чтобы не блокировать repeat.
      const staleBeforeIso = new Date(Date.now() - 15 * 60_000).toISOString();
      await supabase
        .from('campaign_jobs')
        .update({
          status: 'failed',
          error: 'stale_processing',
          sent_at: nowIso,
        })
        .eq('campaign_id', campaignId)
        .eq('status', 'processing')
        .is('sent_at', null)
        .lte('scheduled_at', staleBeforeIso);
    } catch {
      // best-effort: даже если не получилось — дальше отработает обычная логика
    }

    // если есть pending/processing/paused с временем <= сейчас — волна ещё идёт
    let inFlight: any[] | null = null;
    let fErr: any = null;
    {
      const first = await supabase
        .from('campaign_jobs')
        .select('id')
        .eq('campaign_id', campaignId)
        .in('status', ['pending', 'processing', 'paused'])
        .lte('scheduled_at', nowIso)
        .limit(1);
      inFlight = first.data;
      fErr = first.error;
      if (fErr && this.isPausedJobStatusUnsupportedError(fErr)) {
        this.pausedJobStatusSupported = false;
        const fallback = await supabase
          .from('campaign_jobs')
          .select('id')
          .eq('campaign_id', campaignId)
          .in('status', ['pending', 'processing'])
          .lte('scheduled_at', nowIso)
          .limit(1);
        inFlight = fallback.data;
        fErr = fallback.error;
      }
    }

    if (fErr)
      return {
        success: false,
        message: 'supabase_jobs_select_error',
        error: fErr,
      };
    if (inFlight?.length) return { success: true, message: 'wave_in_progress' };

    // Anti-backlog guard: не создаём новую волну, пока в кампании есть
    // любой незавершённый хвост (pending/processing/paused), даже если он "в будущем".
    // Это предотвращает раздувание очереди при длительных хвостах/реконнектах.
    const allowRepeatOverlap = this.isRepeatOverlapAllowed();
    if (!allowRepeatOverlap) {
      let unfinished: any[] | null = null;
      let uErr: any = null;
      const first = await supabase
        .from('campaign_jobs')
        .select('id')
        .eq('campaign_id', campaignId)
        .in('status', ['pending', 'processing', 'paused'])
        .limit(1);
      unfinished = first.data;
      uErr = first.error;
      if (uErr && this.isPausedJobStatusUnsupportedError(uErr)) {
        this.pausedJobStatusSupported = false;
        const fallback = await supabase
          .from('campaign_jobs')
          .select('id')
          .eq('campaign_id', campaignId)
          .in('status', ['pending', 'processing'])
          .limit(1);
        unfinished = fallback.data;
        uErr = fallback.error;
      }
      if (uErr) {
        return {
          success: false,
          message: 'supabase_jobs_select_error',
          error: uErr,
        };
      }
      if (unfinished?.length) {
        await this.persistRecoveryAuditEvent({
          userId: String(c.user_id || ''),
          channel,
          eventType: 'wave_tail_blocked',
          campaignId,
          label: 'repeat_overlap_guard',
        });
        return { success: true, message: 'wave_tail_not_finished' };
      }
    }

    // CLAIM
    const scheduleKind = normalizeRepeatScheduleKind(c.repeat_schedule_kind);
    const time_from = c.time_from || '00:00';
    const clockRaw = c.repeat_clock_time ? String(c.repeat_clock_time) : null;
    const repMin = Number.isFinite(c.repeat_min_min)
      ? Number(c.repeat_min_min)
      : 5;
    const repMax = Number.isFinite(c.repeat_min_max)
      ? Number(c.repeat_min_max)
      : 15;
    const tz = c.timezone || process.env.DEFAULT_TZ || 'Europe/Moscow';
    const newNext = computeNextRepeatAtLuxon(
      tz,
      scheduleKind,
      time_from,
      scheduleKind === 'clock_time'
        ? normalizeRepeatClockTime(clockRaw, time_from)
        : null,
      repMin,
      repMax,
    )
      .toUTC()
      .toISO();

    const { data: claimed, error: claimErr } = await supabase
      .from('campaigns')
      .update({ next_repeat_at: newNext })
      .eq('id', campaignId)
      .eq('repeat_enabled', true)
      .eq('status', 'running')
      .lte('next_repeat_at', nowIso)
      .select('id')
      .maybeSingle();

    if (claimErr)
      return { success: false, message: 'claim_failed', error: claimErr };
    if (!claimed) return { success: true, message: 'not_claimed' };

    const time_to = c.time_to || '23:59';

    if (channel === 'tg') {
      await this.maybeForceTgSyncBeforeWave(String(c.user_id), campaignId);
    }

    const betweenGroupsSecMin = Number.isFinite(c.between_groups_sec_min)
      ? Number(c.between_groups_sec_min)
      : 20;
    const betweenGroupsSecMax = Number.isFinite(c.between_groups_sec_max)
      ? Number(c.between_groups_sec_max)
      : 90;
    const scaleGroupDelaysWithTemplateSpeed =
      c.between_groups_scale_template !== false;
    const betweenTemplatesMinMin = Number.isFinite(c.between_templates_min_min)
      ? Number(c.between_templates_min_min)
      : 15;
    const betweenTemplatesMinMax = Number.isFinite(c.between_templates_min_max)
      ? Number(c.between_templates_min_max)
      : 60;

    const waveRes = await this.createWaveAndEnqueue({
      campaignId,
      userId: c.user_id,
      tz,
      time_from,
      time_to,
      betweenGroupsSecMin,
      betweenGroupsSecMax,
      scaleGroupDelaysWithTemplateSpeed,
      betweenTemplatesMinMin,
      betweenTemplatesMinMax,
      baseIso: DateTime.now().setZone(tz).toISO()!,
      channel: c.channel === 'tg' ? 'tg' : 'wa',
      allowNoJobs: true,
    });

    if (!waveRes.success) return waveRes;

    this.logger.log(
      `Repeat wave created for ${campaignId}. Next at ${newNext}`,
    );

    const syncRes = await this.syncCampaignBetweenGroupsFromTemplates(
      campaignId,
      String(c.user_id),
      c.channel === 'tg' ? 'tg' : 'wa',
    );
    if (!syncRes.success) {
      this.logger.warn(
        `[Campaigns] syncCampaignBetweenGroupsFromTemplates after repeat: ${syncRes.message}`,
      );
    }

    return {
      success: true,
      message: 'repeat_wave_created',
      jobs: waveRes.jobs,
      nextRepeatAt: newNext,
    };
  }

  /** Загрузка включённых шаблонов с тем же select/fallback, что и при построении волны. */
  private async fetchEnabledMessageTemplates(userId: string): Promise<{
    templates: any[] | null;
    error: any;
  }> {
    const supabase = this.supabaseService.getClient();
    let templates: any[] | null = null;
    let tErr: any = null;

    const { data: dataTemplates, error: errTemplates } = await supabase
      .from('message_templates')
      .select(
        'id, title, text, media_url, enabled, "order", created_at, updated_at, wa_speed_factor, tg_speed_factor, wa_default_send_time, tg_default_send_time, wa_between_groups_sec_min, wa_between_groups_sec_max, tg_between_groups_sec_min, tg_between_groups_sec_max',
      )
      .eq('user_id', userId)
      .eq('enabled', true)
      .order('order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true });

    if (!errTemplates) {
      templates = dataTemplates ?? [];
    } else {
      const errMsg = String(errTemplates?.message ?? '');
      const missingColumn =
        errMsg.includes('does not exist') ||
        errMsg.includes('"order"') ||
        errMsg.includes('wa_speed_factor') ||
        errMsg.includes('tg_speed_factor') ||
        errMsg.includes('wa_default_send_time') ||
        errMsg.includes('tg_default_send_time') ||
        errMsg.includes('wa_between_groups_sec') ||
        errMsg.includes('tg_between_groups_sec');
      if (missingColumn) {
        this.logger.warn(
          `fetchEnabledMessageTemplates: message_templates select failed (${errTemplates?.code ?? 'unknown'}): ${errMsg}. Trying fallback without optional columns.`,
        );
        const { data: dataFallback, error: errFallback } = await supabase
          .from('message_templates')
          .select('id, title, text, media_url, enabled, updated_at')
          .eq('user_id', userId)
          .eq('enabled', true)
          .order('updated_at', { ascending: true });
        if (!errFallback) {
          templates = (dataFallback ?? []).map((row: any) => ({
            ...row,
            order: 0,
            wa_speed_factor: 100,
            tg_speed_factor: 100,
            wa_default_send_time: null,
            tg_default_send_time: null,
          }));
        } else {
          tErr = errFallback;
        }
      } else {
        tErr = errTemplates;
      }
    }

    if (tErr) {
      return { templates: null, error: tErr };
    }
    return { templates, error: null };
  }

  /** Обновить в кампании отображаемый диапазон пауз по текущим шаблонам (после повтора волны и т.п.). */
  private async syncCampaignBetweenGroupsFromTemplates(
    campaignId: string,
    userId: string,
    channel: 'wa' | 'tg',
  ): Promise<{ success: boolean; message?: string }> {
    const supabase = this.supabaseService.getClient();
    const { data: camp, error: cErr } = await supabase
      .from('campaigns')
      .select('between_groups_scale_template')
      .eq('id', campaignId)
      .eq('user_id', userId)
      .maybeSingle();
    if (cErr || !camp) {
      return { success: false, message: 'campaign_not_found' };
    }
    if ((camp as any).between_groups_scale_template === false) {
      return { success: true, message: 'scale_template_off_skip' };
    }
    const { templates, error: tErr } =
      await this.fetchEnabledMessageTemplates(userId);
    if (tErr || !templates?.length) {
      return { success: false, message: 'templates_load_failed' };
    }
    const pair = computeStoredBetweenGroupsForScaledTemplates(
      templates,
      channel,
    );
    const { error: uErr } = await supabase
      .from('campaigns')
      .update({
        between_groups_sec_min: pair.min,
        between_groups_sec_max: pair.max,
      })
      .eq('id', campaignId)
      .eq('user_id', userId);
    if (uErr) {
      return { success: false, message: String(uErr.message ?? 'update_failed') };
    }
    return { success: true };
  }

  private async createWaveAndEnqueue(params: {
    campaignId: string;
    userId: string;
    tz: string;
    time_from: string;
    time_to: string;
    betweenGroupsSecMin: number;
    betweenGroupsSecMax: number;
    /** false: пауза только из betweenGroupsSec*, без × speed_factor шаблона */
    scaleGroupDelaysWithTemplateSpeed: boolean;
    betweenTemplatesMinMin: number;
    betweenTemplatesMinMax: number;
    baseIso: string;
    channel: 'wa' | 'tg';
    allowNoJobs?: boolean;
  }) {
    const supabase = this.supabaseService.getClient();

    // ✅ 1) load groups by channel into unified shape { jid: string }
    let usableGroups: Array<{
      jid: string;
      is_announcement?: boolean;
      send_time?: string | null;
    }> = [];
    let tgActiveAccountKey: string | null = null;

    if (params.channel === 'wa') {
      const groups: any[] = [];
      for (let offset = 0; offset < GROUPS_SELECT_LIMIT; offset += SELECT_PAGE_SIZE) {
        const { data: page, error: gErr } = await supabase
          .from('whatsapp_groups')
          .select('wa_group_id, is_announcement, is_selected, send_time')
          .eq('user_id', params.userId)
          .eq('is_selected', true)
          .range(offset, offset + SELECT_PAGE_SIZE - 1);

        if (gErr)
          return {
            success: false,
            message: 'supabase_groups_error',
            error: gErr,
          };

        const rows = page ?? [];
        groups.push(...rows);
        if (rows.length < SELECT_PAGE_SIZE) break;
      }

      usableGroups = groups
        .filter((g: any) => !g.is_announcement)
        .map((g: any) => ({
          jid: String(g.wa_group_id),
          send_time: g.send_time ?? null,
        }));
    } else {
      tgActiveAccountKey = await this.telegramService.getActiveTgAccountKey(
        params.userId,
      );
      if (!tgActiveAccountKey) {
        this.logger.warn(
          `createWaveAndEnqueue: active_tg_account_missing for user=${params.userId}`,
        );
        return {
          success: false,
          message: 'no_active_tg_account',
          details: { channel: 'tg' },
        };
      }
      const groups: any[] = [];
      for (let offset = 0; offset < GROUPS_SELECT_LIMIT; offset += SELECT_PAGE_SIZE) {
        let q = supabase
          .from('telegram_groups')
          .select(
            'tg_chat_id, is_selected, send_time, quarantine_until, quarantine_reason, tg_phone',
          )
          .eq('user_id', params.userId)
          .eq('is_selected', true);
        q = applyTelegramGroupsTgPhoneScope(q, tgActiveAccountKey);
        const { data: page, error: gErr } = await q.range(
          offset,
          offset + SELECT_PAGE_SIZE - 1,
        );

        if (gErr)
          return {
            success: false,
            message: 'supabase_groups_error',
            error: gErr,
          };

        const rows = page ?? [];
        groups.push(...rows);
        if (rows.length < SELECT_PAGE_SIZE) break;
      }

      const nowMs = Date.now();
      usableGroups = groups
        .filter((g: any) => {
          const reason = String((g as any).quarantine_reason || '');
          if (reason.startsWith('stale_not_in_dialogs')) return false;
          const q = (g as any).quarantine_until;
          if (!q) return true;
          const t = new Date(String(q)).getTime();
          return !Number.isFinite(t) || t <= nowMs;
        })
        .map((g: any) => ({
          jid: String(g.tg_chat_id),
          send_time: g.send_time ?? null,
        }));

      // Guard: перед новым enqueue убираем "зависшие" TG jobs вне текущего active tgid scope.
      // Это предотвращает повторный пролив старого pending-хвоста после переключений аккаунта.
      await this.sanitizeTgInFlightJobsOutsideScope({
        campaignId: params.campaignId,
        userId: params.userId,
        allowedGroupIds: new Set(usableGroups.map((g) => String(g.jid))),
      });
    }

    // Дедупликация по jid — одна и та же группа (например «Лиды») не должна создавать два задания
    const seen = new Set<string>();
    usableGroups = usableGroups.filter((g) => {
      const key = String(g.jid).trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (!usableGroups.length) {
      this.logger.warn(
        `createWaveAndEnqueue: no_groups for user=${params.userId}, channel=${params.channel}`,
      );
      return {
        success: false,
        message: 'no_groups',
        details: {
          channel: params.channel,
        },
      };
    }

    // ✅ 2) templates (с fallback при отсутствии колонок миграций)
    const { templates, error: tErr } =
      await this.fetchEnabledMessageTemplates(params.userId);

    if (tErr) {
      this.logger.error('createWaveAndEnqueue: supabase_templates_error', {
        code: tErr?.code,
        message: tErr?.message,
        details: tErr?.details,
      });
      return {
        success: false,
        message: 'supabase_templates_error',
        error: tErr,
      };
    }
    if (!templates?.length) return { success: false, message: 'no_templates' };

    let links: any[] | null = null;
    let lErr: any = null;

    const tgTargetsSelect =
      'template_id, group_jid, send_time_override, tg_account_key';
    const waTargetsSelect =
      'template_id, group_jid, send_time_override';
    const runTargetsQuery = async (opts: {
      includeTgAccountKeyFilter: boolean;
      includeTgAccountKeyColumn: boolean;
      offset: number;
    }) => {
      const sel =
        params.channel === 'tg' && opts.includeTgAccountKeyColumn
          ? tgTargetsSelect
          : waTargetsSelect;
      let q = supabase
        .from('template_group_targets')
        .select(sel)
        .eq('user_id', params.userId)
        .eq('channel', params.channel)
        .eq('enabled', true);
      if (
        params.channel === 'tg' &&
        opts.includeTgAccountKeyFilter &&
        tgActiveAccountKey
      ) {
        q = q.in('tg_account_key', [
          tgActiveAccountKey,
          LEGACY_TEMPLATE_TG_ACCOUNT_KEY,
        ]);
      }
      return q.range(opts.offset, opts.offset + SELECT_PAGE_SIZE - 1);
    };

    let errLinks: any = null;
    const dataLinks: any[] = [];
    let includeTgAccountKeyFilter = params.channel === 'tg';
    let includeTgAccountKeyColumn = params.channel === 'tg';
    for (let offset = 0; offset < TARGETS_SELECT_LIMIT; offset += SELECT_PAGE_SIZE) {
      const first = await runTargetsQuery({
        includeTgAccountKeyFilter,
        includeTgAccountKeyColumn,
        offset,
      });
      let page = first.data ?? null;
      errLinks = first.error;
      if (
        errLinks &&
        params.channel === 'tg' &&
        isMissingTgAccountKeyColumn(errLinks)
      ) {
        includeTgAccountKeyFilter = false;
        includeTgAccountKeyColumn = false;
        const second = await runTargetsQuery({
          includeTgAccountKeyFilter,
          includeTgAccountKeyColumn,
          offset,
        });
        page = second.data ?? null;
        errLinks = second.error;
      }
      if (errLinks) break;
      const rows = page ?? [];
      dataLinks.push(...rows);
      if (rows.length < SELECT_PAGE_SIZE) break;
    }

    if (!errLinks) {
      links = dataLinks;
    } else {
      const errMsg = String(errLinks?.message ?? '');
      const missingColumn =
        errMsg.includes('does not exist') ||
        errMsg.includes('template_group_targets');

      if (missingColumn) {
        this.logger.warn(
          `createWaveAndEnqueue: template_group_targets select failed (${
            errLinks?.code ?? 'unknown'
          }): ${errMsg}. Treating as no per-template targets.`,
        );
        links = [];
      } else {
        lErr = errLinks;
      }
    }

    if (
      !lErr &&
      params.channel === 'tg' &&
      tgActiveAccountKey &&
      (links?.length ?? 0) > 0
    ) {
      const tgPoolNorm = new Set(
        usableGroups
          .map((g) => normalizeTgChatIdKey(String(g.jid)))
          .filter(Boolean),
      );
      const ak = tgActiveAccountKey;
      links = (links ?? []).filter((row: any) => {
        const acc = String(row.tg_account_key ?? '').trim();
        const hasCol = 'tg_account_key' in row;
        const k = normalizeTgChatIdKey(String(row.group_jid ?? ''));
        if (!k) return false;
        if (hasCol) {
          if (acc === ak) return true;
          if (acc === LEGACY_TEMPLATE_TG_ACCOUNT_KEY) return tgPoolNorm.has(k);
          return false;
        }
        return tgPoolNorm.has(k);
      });
    }

    const hasAnyTargets = (links ?? []).length > 0;
    if (lErr) {
      this.logger.error(
        'createWaveAndEnqueue: supabase_template_targets_error',
        { code: lErr?.code, message: lErr?.message, details: lErr?.details },
      );
      return {
        success: false,
        message: 'supabase_template_targets_error',
        error: lErr,
      };
    }

    // Map: templateId -> Map(groupKey -> overrideValue|null)
    const targetsMap = new Map<string, Map<string, string | null>>();
    for (const row of links ?? []) {
      const tid = String(row.template_id);
      const jidRaw = String(row.group_jid);
      const key =
        params.channel === 'tg' ? normalizeTgChatIdKey(jidRaw) : String(jidRaw);
      if (!key) continue;

      const ovRaw = row.send_time_override;
      const ov = ovRaw == null ? null : String(ovRaw).trim() || null;

      if (!targetsMap.has(tid))
        targetsMap.set(tid, new Map<string, string | null>());
      targetsMap.get(tid)!.set(key, ov);
    }

    const base = DateTime.fromISO(params.baseIso).setZone(params.tz);
    let cursor = clampToWindow(base, params.time_from, params.time_to);

    const jobsToInsert: any[] = [];

    // Любые незавершённые jobs по паре (group_jid|template_id) блокируют новую строку,
    // иначе при просроченном pending (очередь/сеть) или processing можно получить дубликат
    // и два фактических send в одну группу с одним шаблоном.
    const { data: existingJobs, error: existErr } = await supabase
      .from('campaign_jobs')
      .select('group_jid, template_id, scheduled_at, status')
      .eq('campaign_id', params.campaignId)
      .in('status', ['pending', 'processing']);

    if (existErr) {
      return {
        success: false,
        message: 'supabase_jobs_select_error',
        error: existErr,
      };
    }

    const inFlightPairKeys = new Set<string>();
    for (const j of existingJobs ?? []) {
      const key = `${String((j as any).group_jid)}|${String(
        (j as any).template_id,
      )}`;
      inFlightPairKeys.add(key);
    }

    const { data: allJobs, error: allErr } = await supabase
      .from('campaign_jobs')
      .select('group_jid, template_id, scheduled_at')
      .eq('campaign_id', params.campaignId);

    if (allErr) {
      return {
        success: false,
        message: 'supabase_jobs_select_error',
        error: allErr,
      };
    }

    const latestScheduledMap = new Map<string, string>();
    const latestScheduledGroupMap = new Map<string, string>();
    for (const j of allJobs ?? []) {
      const groupId = String((j as any).group_jid);
      const templateId = String((j as any).template_id);
      const key = `${groupId}|${templateId}`;
      const iso = String((j as any).scheduled_at || '');
      if (!iso) continue;
      const prev = latestScheduledMap.get(key);
      if (!prev || new Date(iso).getTime() > new Date(prev).getTime()) {
        latestScheduledMap.set(key, iso);
      }
      const gPrev = latestScheduledGroupMap.get(groupId);
      if (!gPrev || new Date(iso).getTime() > new Date(gPrev).getTime()) {
        latestScheduledGroupMap.set(groupId, iso);
      }
    }

    const perGroupNextAvailable = new Map<string, DateTime>();

    for (let ti = 0; ti < templates.length; ti++) {
      const template: any = templates[ti];

      // ✅ группы, выбранные для этого шаблона
      const selected = targetsMap.get(String(template.id));
      const hasExplicitTargetsForTemplate = !!selected && selected.size > 0;

      const targetGroups = hasExplicitTargetsForTemplate
        ? usableGroups.filter((g) => {
            if (params.channel !== 'tg') return selected!.has(String(g.jid));
            const key = normalizeTgChatIdKey(g.jid);
            return !!key && selected!.has(key);
          })
        : usableGroups;
      if (!hasExplicitTargetsForTemplate && hasAnyTargets) {
        this.logger.warn(
          `[Campaigns] createWaveAndEnqueue: template has no enabled ${params.channel} targets, fallback to all selected channel groups userId=${params.userId}, campaignId=${params.campaignId}, templateId=${String(template.id)}`,
        );
      }
      // ✅ если НЕТ вообще ни одной настройки targets — шлём во все группы (как раньше)

      // ✅ если для шаблона не выбрано ни одной группы — не создаём jobs
      if (!targetGroups.length) continue;

      if (params.scaleGroupDelaysWithTemplateSpeed) {
        const pauseOk = templateExplicitBetweenGroupsPause(
          template,
          params.channel,
        );
        if (!pauseOk) {
          return {
            success: false,
            message: 'template_between_groups_required',
            details: {
              channel: params.channel,
              templateId: String(template.id),
              templateTitle:
                template.title != null ? String(template.title) : null,
            },
          };
        }
      }

      const tplSpeedFactorBase =
        params.channel === 'tg'
          ? clampInt(template.tg_speed_factor, 10, 400, 100)
          : clampInt(template.wa_speed_factor, 10, 400, 100);

      const tplDefaultSendTime =
        params.channel === 'tg'
          ? (template.tg_default_send_time ?? null)
          : null;

      type Candidate = {
        group: any;
        groupId: string;
        scheduleSpec: GroupScheduleSpec | null;
        earliest: DateTime;
        tplSpeedFactor: number;
      };

      const candidates: Candidate[] = [];

      for (let gi = 0; gi < targetGroups.length; gi++) {
        const group: any = targetGroups[gi];
        const groupId = String(group?.jid ?? '');
        if (!groupId) continue;

        const key = `${groupId}|${String(template.id)}`;
        if (inFlightPairKeys.has(key)) continue;

        const groupKey =
          params.channel === 'tg' ? normalizeTgChatIdKey(groupId) : groupId;
        const overrideSendTime = selected?.get(groupKey) ?? null;

        // WA: ритм только из окна рассылки / пауз между группами — без send_time группы, default и override шаблона.
        const effectiveSendTime =
          params.channel === 'wa'
            ? null
            : overrideSendTime != null
              ? overrideSendTime
              : tplDefaultSendTime != null
                ? String(tplDefaultSendTime).trim() || null
                : (group?.send_time ?? null);

        const scheduleSpec = parseGroupScheduleSpec(effectiveSendTime);

        let earliest: DateTime;
        if (scheduleSpec?.kind === 'fixed') {
          const fixed = nextFixedTime(base, scheduleSpec.hhmm);
          const nextAvail = perGroupNextAvailable.get(groupId);
          earliest = nextAvail && nextAvail > fixed ? nextAvail : fixed;
        } else if (scheduleSpec?.kind === 'interval') {
          let nextAvail = perGroupNextAvailable.get(groupId);
          if (!nextAvail) {
            const lastGroupIso = latestScheduledGroupMap.get(groupId);
            nextAvail = lastGroupIso
              ? DateTime.fromISO(lastGroupIso)
                  .setZone(params.tz)
                  .plus({
                    minutes: randInt(
                      scheduleSpec.minMinutes,
                      scheduleSpec.maxMinutes,
                    ),
                  })
              : base;
          }
          if (nextAvail < base) nextAvail = base;
          earliest = clampToWindow(nextAvail, params.time_from, params.time_to);
        } else {
          // без send_time: только лимит потока, earliest = базовое время волны
          earliest = base;
        }

        candidates.push({
          group,
          groupId,
          scheduleSpec,
          earliest,
          tplSpeedFactor: tplSpeedFactorBase,
        });
      }

      // Сортируем по ближайшему доступному времени.
      // Это нужно, чтобы:
      // - не было "залпов" в будущем (много jobs с одинаковым scheduled_at),
      // - между шагами применялась пауза из карточки шаблона (или betweenGroupsSec* при scale=false).
      candidates.sort((a, b) => a.earliest.toMillis() - b.earliest.toMillis());

      for (const cand of candidates) {
        cursor = clampToWindow(cursor, params.time_from, params.time_to);

        let scheduledAt = clampToWindow(
          cand.earliest,
          params.time_from,
          params.time_to,
        );

        // Если мы "раньше", чем можно по расписанию группы — значит до scheduledAt просто нечего слать,
        // поэтому безопасно "прыгаем" cursor вперёд.
        if (cursor < scheduledAt) cursor = scheduledAt;

        // scheduledAt не может быть раньше cursor (лимит потока)
        if (scheduledAt < cursor) scheduledAt = cursor;
        scheduledAt = clampToWindow(
          scheduledAt,
          params.time_from,
          params.time_to,
        );

        jobsToInsert.push({
          campaign_id: params.campaignId,
          user_id: params.userId,
          group_jid: cand.group.jid,
          channel: params.channel,
          template_id: template.id,
          status: 'pending',
          scheduled_at: scheduledAt.toUTC().toISO(),
          created_at: new Date().toISOString(),
        });

        if (cand.scheduleSpec?.kind === 'interval') {
          perGroupNextAvailable.set(
            cand.groupId,
            scheduledAt.plus({
              minutes: randInt(
                cand.scheduleSpec.minMinutes,
                cand.scheduleSpec.maxMinutes,
              ),
            }),
          );
          latestScheduledGroupMap.set(
            cand.groupId,
            scheduledAt.toUTC().toISO(),
          );
          latestScheduledMap.set(
            `${cand.groupId}|${String(template.id)}`,
            scheduledAt.toUTC().toISO(),
          );
        }

        if (cand.scheduleSpec?.kind === 'fixed') {
          perGroupNextAvailable.set(
            cand.groupId,
            scheduledAt.plus({
              // Между шаблонами паузы намеренно нет.
              minutes: 0,
            }),
          );
          latestScheduledGroupMap.set(
            cand.groupId,
            scheduledAt.toUTC().toISO(),
          );
          latestScheduledMap.set(
            `${cand.groupId}|${String(template.id)}`,
            scheduledAt.toUTC().toISO(),
          );
        }

        const tplPauseRange = templateExplicitBetweenGroupsPause(
          template,
          params.channel,
        );
        const baseDelay =
          tplPauseRange != null
            ? randInt(tplPauseRange.min, tplPauseRange.max)
            : randInt(
                params.betweenGroupsSecMin,
                params.betweenGroupsSecMax,
              );
        const speedFactor =
          tplPauseRange || !params.scaleGroupDelaysWithTemplateSpeed
            ? 100
            : cand.tplSpeedFactor;
        const scaledDelay = applySpeedFactorToDelaySeconds(
          baseDelay,
          speedFactor,
        );
        cursor = cursor.plus({ seconds: scaledDelay });
      }

      if (ti < templates.length - 1) {
        // Между шаблонами паузы намеренно нет.
        cursor = cursor.plus({ minutes: 0 });
      }
    }

    if (!jobsToInsert.length) {
      const msg = hasAnyTargets ? 'no_targets_for_templates' : 'no_jobs';

      this.logger.warn(
        `createWaveAndEnqueue: ${msg} for user=${params.userId}, channel=${params.channel}; groups=${usableGroups.length}; templates=${templates.length}; hasAnyTargets=${hasAnyTargets}`,
      );

      if (params.allowNoJobs) {
        return {
          success: true,
          groups: usableGroups.length,
          templates: templates.length,
          jobs: 0,
          message: 'no_new_jobs',
        } as any;
      }

      return {
        success: false,
        message: msg,
        details: {
          channel: params.channel,
          groups: usableGroups.length,
          templates: templates.length,
          hasAnyTargets,
        },
      };
    }

    const inserted: any[] = [];
    const insertChunkSize = 500;
    for (let i = 0; i < jobsToInsert.length; i += insertChunkSize) {
      const chunk = jobsToInsert.slice(i, i + insertChunkSize);
      const { data, error: jErr } = await supabase
        .from('campaign_jobs')
        .insert(chunk)
        .select('id, user_id, group_jid, template_id, scheduled_at, channel');

      if (jErr || !data?.length) {
        return {
          success: false,
          message: 'supabase_jobs_insert_error',
          error: jErr,
        };
      }
      inserted.push(...data);
    }

    await this.enqueueRows(inserted);

    this.logger.log(
      `[Campaigns] WAVE CREATED: campaign=${params.campaignId}, userId=${params.userId}, channel=${params.channel}, groups=${usableGroups.length}, templates=${templates.length}, jobs=${inserted.length}`,
    );

    return {
      success: true,
      groups: usableGroups.length,
      templates: templates.length,
      jobs: inserted.length,
    };
  }

  private async sanitizeTgInFlightJobsOutsideScope(params: {
    campaignId: string;
    userId: string;
    allowedGroupIds: Set<string>;
  }): Promise<void> {
    const supabase = this.supabaseService.getClient();
    const { data: inFlight, error } = await supabase
      .from('campaign_jobs')
      .select('id, group_jid, status')
      .eq('campaign_id', params.campaignId)
      .eq('channel', 'tg')
      .in('status', ['pending', 'processing']);

    if (error) {
      this.logger.warn(
        `[Campaigns] TG sanitize skipped (select failed) campaign=${params.campaignId} user=${params.userId}: ${error.message}`,
      );
      return;
    }

    const toFailIds = (inFlight ?? [])
      .filter((j: any) => !params.allowedGroupIds.has(String(j.group_jid)))
      .map((j: any) => String(j.id));

    if (!toFailIds.length) return;

    const nowIso = new Date().toISOString();
    const chunkSize = 200;
    let updated = 0;
    for (let i = 0; i < toFailIds.length; i += chunkSize) {
      const chunk = toFailIds.slice(i, i + chunkSize);
      const { data, error: updErr } = await supabase
        .from('campaign_jobs')
        .update({
          status: 'failed',
          error: 'excluded_by_active_tgid_scope',
          sent_at: nowIso,
        })
        .in('id', chunk)
        .in('status', ['pending', 'processing'])
        .select('id');
      if (updErr) {
        this.logger.warn(
          `[Campaigns] TG sanitize update failed campaign=${params.campaignId} user=${params.userId}: ${updErr.message}`,
        );
        continue;
      }
      updated += (data ?? []).length;
    }

    if (updated > 0) {
      this.logger.warn(
        `[Campaigns] TG sanitize pruned in-flight jobs outside active scope: ${updated} (campaign=${params.campaignId}, user=${params.userId})`,
      );
    }
  }

  private async enqueueRows(rows: Array<any>) {
    const nowMs = Date.now();

    for (const row of rows) {
      const scheduledMs = new Date(row.scheduled_at as string).getTime();
      const delay = Math.max(0, scheduledMs - nowMs);

      const deterministicJobId = String(row.id);
      const retryJobId = `retry__${deterministicJobId}`;
      const retryLegacyJobId = `retry:${deterministicJobId}`;
      const q = this.queueService.getCampaignSendQueueForUser(
        String(row.user_id),
      );

      const existing = await q.getJob(deterministicJobId);
      if (existing) await existing.remove();
      const retryExisting = await q.getJob(retryJobId);
      if (retryExisting) await retryExisting.remove();
      const retryLegacyExisting = await q.getJob(retryLegacyJobId);
      if (retryLegacyExisting) await retryLegacyExisting.remove();

      // Защита от кратких сбоев Redis/BullMQ на этапе add после remove:
      // пробуем несколько раз, чтобы уменьшить риск "осиротевшего pending".
      let added = false;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await q.add(
            'send',
            {
              jobId: row.id,
              userId: row.user_id,
              groupJid: row.group_jid,
              templateId: row.template_id,
              channel: row.channel,
            },
            {
              jobId: deterministicJobId,
              delay,
              priority: this.campaignVip.getEnqueuePriority(String(row.user_id)),
              // Воркера намеренно не используют retry BullMQ (ошибку не пробрасываем).
              // attempts>1 приводит к тому, что мы помечаем строку как pending (не последний attempt),
              // но фактического повторного выполнения не происходит -> "вечное pending" и блок repeat.
              attempts: 1,
              removeOnComplete: true,
              removeOnFail: false,
            },
          );
          added = true;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 120 * attempt));
          }
        }
      }
      if (!added) {
        throw lastErr instanceof Error
          ? lastErr
          : new Error(`enqueue_failed_for_job_${deterministicJobId}`);
      }
    }
  }

  private async resumePausedJobsWithScheduleShift(
    pausedJobs: Array<any>,
    stepDelayMs = 1500,
  ) {
    if (!pausedJobs.length) return 0;
    const supabase = this.supabaseService.getClient();

    const nowMs = Date.now();
    const validTimes = pausedJobs
      .map((j) => new Date(String(j.scheduled_at || '')).getTime())
      .filter((ms) => Number.isFinite(ms)) as number[];
    const minOldMs =
      validTimes.length > 0 ? Math.min(...validTimes) : nowMs;

    const toEnqueue: any[] = [];
    for (let i = 0; i < pausedJobs.length; i++) {
      const row = pausedJobs[i];
      const oldMs = new Date(String(row.scheduled_at || '')).getTime();
      const deltaMs = Number.isFinite(oldMs) ? Math.max(0, oldMs - minOldMs) : 0;
      const newIso = new Date(nowMs + deltaMs + i * stepDelayMs).toISOString();

      // Переносим "paused" задачи в будущее относительно момента резюма, сохраняя
      // их исходный относительный порядок/интервалы.
      await supabase
        .from('campaign_jobs')
        .update({
          status: 'pending',
          error: null,
          sent_at: null,
          scheduled_at: newIso,
        })
        .eq('id', row.id);

      toEnqueue.push({
        id: row.id,
        user_id: row.user_id,
        group_jid: row.group_jid,
        template_id: row.template_id,
        scheduled_at: newIso,
        channel: row.channel,
      });
    }

    await this.enqueueRows(toEnqueue);
    return toEnqueue.length;
  }

  /**
   * Мягко растягивает "хвост" pending-задач (последние N), чтобы после реконнекта
   * не было плотного рывка и залипания конца очереди.
   *
   * Важно:
   * - меняем только tail pending;
   * - порядок задач сохраняем;
   * - время только сдвигается вперёд (никогда не ускоряем).
   */
  private async softStretchPendingTail(params: {
    campaignId: string;
    userId: string;
    channelHint?: 'wa' | 'tg';
    tailSize?: number;
    extraStepMs?: number;
    scanLimit?: number;
  }): Promise<number> {
    const campaignId = String(params.campaignId || '').trim();
    if (!campaignId) return 0;

    const tailSize = Math.max(5, Math.min(120, params.tailSize ?? 30));
    const baseExtraStepMs = Math.max(
      250,
      Math.min(15_000, params.extraStepMs ?? 2000),
    );
    const extraStepMs = await this.computeAdaptiveTailStepMs({
      userId: params.userId,
      channelHint: params.channelHint,
      baseStepMs: baseExtraStepMs,
    });
    const scanLimit = Math.max(50, Math.min(2000, params.scanLimit ?? 600));

    const supabase = this.supabaseService.getClient();
    const { data: pendingRows, error } = await supabase
      .from('campaign_jobs')
      .select('id, user_id, group_jid, template_id, channel, scheduled_at')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
      .order('scheduled_at', { ascending: true })
      .limit(scanLimit);

    if (error || !pendingRows?.length) return 0;
    if (pendingRows.length < tailSize + 5) return 0;

    const tail = pendingRows.slice(-tailSize);
    const firstTailMs = new Date(String((tail[0] as any).scheduled_at || '')).getTime();
    if (!Number.isFinite(firstTailMs)) return 0;

    const updates: Array<{
      id: string;
      user_id: string;
      group_jid: string;
      template_id: string;
      channel: string;
      scheduled_at: string;
    }> = [];

    for (let i = 0; i < tail.length; i++) {
      const row: any = tail[i];
      const oldMs = new Date(String(row.scheduled_at || '')).getTime();
      if (!Number.isFinite(oldMs)) continue;
      const targetMs = firstTailMs + i * extraStepMs;
      const newMs = Math.max(oldMs, targetMs);
      if (newMs <= oldMs) continue;
      updates.push({
        id: String(row.id),
        user_id: String(row.user_id),
        group_jid: String(row.group_jid),
        template_id: String(row.template_id),
        channel: String(row.channel || ''),
        scheduled_at: new Date(newMs).toISOString(),
      });
    }

    if (!updates.length) return 0;

    for (const u of updates) {
      await supabase
        .from('campaign_jobs')
        .update({ scheduled_at: u.scheduled_at })
        .eq('id', u.id)
        .eq('status', 'pending');
    }

    await this.enqueueRows(updates);

    this.logger.log(
      `[Campaigns] tail stretched: campaign=${campaignId}, updated=${updates.length}, tailSize=${tailSize}, extraStepMs=${extraStepMs}`,
    );
    return updates.length;
  }

  /**
   * Умный триггер перегруза:
   * - смотрим последние события лимитов за короткое окно;
   * - при росте частоты wa_rate_limit/tg_flood_wait увеличиваем шаг растяжки хвоста.
   */
  private async computeOverloadState(params: {
    userId: string;
    channelHint?: 'wa' | 'tg';
    windowMs?: number;
  }): Promise<{
    hits5m: number;
    level: 'normal' | 'elevated' | 'high' | 'critical';
    factor: number;
  }> {
    const userId = String(params.userId || '').trim();
    if (!userId) return { hits5m: 0, level: 'normal', factor: 1 };

    const windowMs = Math.max(
      60_000,
      Math.min(30 * 60_000, params.windowMs ?? 5 * 60_000),
    );
    const supabase = this.supabaseService.getClient();
    const sinceIso = new Date(Date.now() - windowMs).toISOString();
    const channelHint = params.channelHint;

    const overloadTypes =
      channelHint === 'wa'
        ? ['wa_rate_limit']
        : channelHint === 'tg'
          ? ['tg_flood_wait', 'tg_flood_wait_reschedule']
          : ['wa_rate_limit', 'tg_flood_wait', 'tg_flood_wait_reschedule'];

    try {
      const { data, error } = await supabase
        .from('limit_learning_events')
        .select('event_type, channel, created_at')
        .eq('user_id', userId)
        .in('event_type', overloadTypes)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(200);

      if (error || !Array.isArray(data)) {
        return { hits5m: 0, level: 'normal', factor: 1 };
      }

      const hits = data.length;
      if (hits >= 7) return { hits5m: hits, level: 'critical', factor: 2.0 };
      if (hits >= 4) return { hits5m: hits, level: 'high', factor: 1.6 };
      if (hits >= 2) return { hits5m: hits, level: 'elevated', factor: 1.25 };
      return { hits5m: hits, level: 'normal', factor: 1 };
    } catch {
      return { hits5m: 0, level: 'normal', factor: 1 };
    }
  }

  private async computeAdaptiveTailStepMs(params: {
    userId: string;
    channelHint?: 'wa' | 'tg';
    baseStepMs: number;
  }): Promise<number> {
    const userId = String(params.userId || '').trim();
    const base = Math.max(250, Math.min(15_000, Math.floor(params.baseStepMs)));
    if (!userId) return base;
    const channelHint = params.channelHint;
    const overload = await this.computeOverloadState({ userId, channelHint });
    const stepped = Math.max(
      250,
      Math.min(20_000, Math.round(base * overload.factor)),
    );
    if (overload.factor > 1) {
      this.logger.log(
        `[Campaigns] tail overload trigger: userId=${userId}, channel=${channelHint ?? 'all'}, hits5m=${overload.hits5m}, level=${overload.level}, step=${base}->${stepped}`,
      );
    }
    return stepped;
  }

  /**
   * Общая логика: из списка paused jobs (уже отфильтрованных) — группировка по кампании,
   * проверка коннекта, снятие paused с кампании, перенос части jobs в pending + очередь.
   *
   * @param channelHint — если задан, обрабатываем только этот канал (после реконнекта WA или TG).
   */
  private async resumeDisconnectedPausedRows(
    pausedRows: any[],
    options: {
      batchSizePerCampaign: number;
      stepDelayMs: number;
      channelHint?: 'wa' | 'tg';
    },
  ): Promise<{ resumed: number; campaigns: number }> {
    const { batchSizePerCampaign, stepDelayMs, channelHint } = options;
    const supabase = this.supabaseService.getClient();

    const byCampaign = new Map<string, { userId: string; rows: any[] }>();
    for (const r of pausedRows) {
      const campaignId = String(r.campaign_id || '').trim();
      const userId = String(r.user_id || '').trim();
      if (!campaignId || !userId) continue;
      if (!byCampaign.has(campaignId))
        byCampaign.set(campaignId, { userId, rows: [] });
      byCampaign.get(campaignId)!.rows.push(r);
    }

    let resumedTotal = 0;
    let campaignsTouched = 0;

    for (const [campaignId, entry] of byCampaign.entries()) {
      const userId = entry.userId;
      let waRows = entry.rows.filter(
        (r: any) =>
          String(r.channel || '') === 'wa' ||
          String(r.error || '') === 'wa_not_connected',
      );
      let tgRows = entry.rows.filter(
        (r: any) =>
          String(r.channel || '') === 'tg' ||
          String(r.error || '') === 'telegram_not_connected',
      );
      if (channelHint === 'wa') tgRows = [];
      if (channelHint === 'tg') waRows = [];

      const batchWa = waRows.slice(0, batchSizePerCampaign);
      const batchTg = tgRows.slice(0, batchSizePerCampaign);
      const batch = [...batchWa, ...batchTg];
      if (!batch.length) continue;

      if (batchWa.length) {
        let waStatus = await this.whatsappService.getStatus(userId);
        if (waStatus.status !== 'connected') {
          if (!runtimeHasCapability('worker')) {
            this.logger.log(
              `[Campaigns] skip scheduler-owned WA reconnect during paused resume: campaign=${campaignId}, userId=${userId}, status=${waStatus.status}`,
            );
            continue;
          }
          try {
            await this.whatsappService.startSession(userId);
          } catch {
            // best-effort
          }
          waStatus = await this.whatsappService.getStatus(userId);
        }
        if (waStatus.status !== 'connected') continue;
      }

      if (batchTg.length) {
        const tgStatus = await this.telegramService.getStatus(userId);
        if (tgStatus?.status !== 'connected') continue;
      }

      await supabase
        .from('campaigns')
        .update({ paused: false })
        .eq('id', campaignId);

      const resumed = await this.resumePausedJobsWithScheduleShift(
        batch,
        stepDelayMs,
      );

      // Защитный слой для "хвоста":
      // если резюмим большой батч, мягко растягиваем последние pending-задачи,
      // чтобы после реконнекта не было залпа в конце очереди.
      if (resumed >= 20 || batch.length >= 30) {
        const stretched = await this.softStretchPendingTail({
          campaignId,
          userId,
          channelHint:
            batchWa.length > 0 && batchTg.length === 0
              ? 'wa'
              : batchTg.length > 0 && batchWa.length === 0
                ? 'tg'
                : undefined,
          tailSize: Math.min(60, Math.max(20, Math.floor(batch.length / 2))),
          extraStepMs: Math.max(1200, stepDelayMs),
        });
        if (stretched > 0) {
          this.logger.log(
            `[Campaigns] tail protection applied: campaign=${campaignId}, stretched=${stretched}`,
          );
        }
      }

      resumedTotal += resumed;
      campaignsTouched += 1;
      this.logger.log(
        `[Campaigns] auto-resumed disconnected jobs: campaign=${campaignId}, userId=${userId}, jobs=${resumed}, stepDelayMs=${stepDelayMs}, hint=${channelHint ?? 'all'}`,
      );
    }

    return { resumed: resumedTotal, campaigns: campaignsTouched };
  }

  /**
   * Возобновление рассылок пользователя после реконнекта WA/TG.
   * Вызывается сразу из обработчиков connected (не зависит от CAMPAIGN_REPEAT_ENABLED).
   */
  async autoResumeDisconnectedJobsForUser(
    userId: string,
    params?: {
      batchSizePerCampaign?: number;
      stepDelayMs?: number;
      maxJobs?: number;
      channelHint?: 'wa' | 'tg';
    },
  ): Promise<{
    success: boolean;
    resumed: number;
    campaigns: number;
    message?: string;
  }> {
    const uid = String(userId || '').trim();
    if (!uid) {
      return { success: false, resumed: 0, campaigns: 0, message: 'no_user' };
    }

    const batchSizePerCampaign = Math.max(
      1,
      Math.min(500, params?.batchSizePerCampaign ?? 120),
    );
    const stepDelayMs = Math.max(
      250,
      Math.min(10_000, params?.stepDelayMs ?? 1500),
    );
    const maxJobs = Math.max(
      10,
      Math.min(2000, params?.maxJobs ?? 500),
    );

    const supabase = this.supabaseService.getClient();
    let pausedRows: any[] | null = null;
    let error: any = null;
    if (this.pausedJobStatusSupported !== false) {
      const first = await supabase
        .from('campaign_jobs')
        .select(
          'id, campaign_id, user_id, group_jid, template_id, channel, scheduled_at, error',
        )
        .eq('status', 'paused')
        .in('error', ['wa_not_connected', 'telegram_not_connected'])
        .eq('user_id', uid)
        .limit(maxJobs);
      pausedRows = first.data;
      error = first.error;
      if (error && this.isPausedJobStatusUnsupportedError(error)) {
        this.pausedJobStatusSupported = false;
        return { success: true, resumed: 0, campaigns: 0 };
      }
    }

    if (error) {
      this.logger.warn(
        `[Campaigns] autoResumeDisconnectedJobsForUser(${uid}): ${error.message || String(error)}`,
      );
      return {
        success: false,
        resumed: 0,
        campaigns: 0,
        message: 'supabase_jobs_select_error',
      };
    }

    if (!pausedRows?.length) {
      return { success: true, resumed: 0, campaigns: 0 };
    }

    const { resumed, campaigns } = await this.resumeDisconnectedPausedRows(
      pausedRows,
      {
        batchSizePerCampaign,
        stepDelayMs,
        channelHint: params?.channelHint,
      },
    );

    if (resumed > 0) {
      this.logger.log(
        `[Campaigns] autoResumeDisconnectedJobsForUser userId=${uid} resumed=${resumed} campaigns=${campaigns} hint=${params?.channelHint ?? 'all'}`,
      );
    }

    return { success: true, resumed, campaigns };
  }

  /**
   * Fast-path recovery:
   * если канал уже восстановился, не ждём старый backoff (scheduled_at) у pending retry-job.
   * Будим connectivity-retry задачи сразу и возвращаем их в очередь с минимальным шагом.
   */
  async autoWakeConnectivityRetryJobsForUser(
    userId: string,
    params?: {
      channelHint?: 'wa' | 'tg';
      maxJobs?: number;
      stepDelayMs?: number;
    },
  ): Promise<{
    success: boolean;
    woken: number;
    campaigns: number;
    message?: string;
  }> {
    const uid = String(userId || '').trim();
    if (!uid) {
      return { success: false, woken: 0, campaigns: 0, message: 'no_user' };
    }

    const maxJobs = Math.max(10, Math.min(2000, params?.maxJobs ?? 500));
    const stepDelayMs = Math.max(
      150,
      Math.min(5_000, params?.stepDelayMs ?? 350),
    );
    const channelHint = params?.channelHint;

    const supabase = this.supabaseService.getClient();
    let query = supabase
      .from('campaign_jobs')
      .select(
        'id, campaign_id, user_id, group_jid, template_id, channel, scheduled_at, error',
      )
      .eq('status', 'pending')
      .eq('user_id', uid)
      .order('scheduled_at', { ascending: true })
      .limit(maxJobs);

    if (channelHint === 'wa') {
      query = query.like('error', 'wa_connect_retry_%');
    } else if (channelHint === 'tg') {
      query = query.like('error', 'tg_connect_retry_%');
    } else {
      query = query.or('error.like.wa_connect_retry_%,error.like.tg_connect_retry_%');
    }

    const { data: retryRows, error } = await query;
    if (error) {
      this.logger.warn(
        `[Campaigns] autoWakeConnectivityRetryJobsForUser(${uid}) select error: ${error.message || String(error)}`,
      );
      return {
        success: false,
        woken: 0,
        campaigns: 0,
        message: 'supabase_jobs_select_error',
      };
    }

    if (!retryRows?.length) {
      return { success: true, woken: 0, campaigns: 0 };
    }

    const campaignIds = Array.from(
      new Set(
        retryRows
          .map((r: any) => String(r.campaign_id || '').trim())
          .filter(Boolean),
      ),
    );

    const runnableCampaignIds = new Set<string>();
    if (campaignIds.length > 0) {
      const { data: campaigns, error: cErr } = await supabase
        .from('campaigns')
        .select('id, status, paused')
        .in('id', campaignIds);
      if (cErr) {
        this.logger.warn(
          `[Campaigns] autoWakeConnectivityRetryJobsForUser(${uid}) campaigns select error: ${cErr.message || String(cErr)}`,
        );
      } else {
        for (const c of campaigns ?? []) {
          const cid = String((c as any)?.id || '').trim();
          if (!cid) continue;
          const status = String((c as any)?.status || '');
          const paused = !!(c as any)?.paused;
          if (status === 'running' && !paused) {
            runnableCampaignIds.add(cid);
          }
        }
      }
    }

    const filteredRows = retryRows.filter((r: any) => {
      const cid = String(r.campaign_id || '').trim();
      // Если campaign_id отсутствует, будим задачу: дополнительная защита в worker всё равно есть.
      if (!cid) return true;
      return runnableCampaignIds.has(cid);
    });

    if (!filteredRows.length) {
      return { success: true, woken: 0, campaigns: 0 };
    }

    const nowMs = Date.now();
    const validTimes = filteredRows
      .map((j: any) => new Date(String(j.scheduled_at || '')).getTime())
      .filter((ms: number) => Number.isFinite(ms)) as number[];
    const minOldMs = validTimes.length > 0 ? Math.min(...validTimes) : nowMs;

    const toEnqueue: Array<{
      id: string;
      user_id: string;
      group_jid: string;
      template_id: string;
      channel: 'wa' | 'tg';
      scheduled_at: string;
    }> = [];
    const fastWakeEvents: Array<{
      user_id: string;
      channel: 'wa' | 'tg';
      event_type: 'wa_fast_wake' | 'tg_fast_wake';
      campaign_id: string | null;
      job_id: string | null;
      group_jid: string | null;
      template_id: string | null;
      seconds: number;
      label: string | null;
      error: string | null;
    }> = [];

    for (let i = 0; i < filteredRows.length; i++) {
      const row: any = filteredRows[i];
      const oldMs = new Date(String(row.scheduled_at || '')).getTime();
      const deltaMs = Number.isFinite(oldMs) ? Math.max(0, oldMs - minOldMs) : 0;
      const newIso = new Date(nowMs + deltaMs + i * stepDelayMs).toISOString();

      await supabase
        .from('campaign_jobs')
        .update({
          status: 'pending',
          error: null,
          sent_at: null,
          scheduled_at: newIso,
        })
        .eq('id', row.id);

      toEnqueue.push({
        id: String(row.id),
        user_id: String(row.user_id),
        group_jid: String(row.group_jid),
        template_id: String(row.template_id),
        channel: String(row.channel || 'wa') === 'tg' ? 'tg' : 'wa',
        scheduled_at: newIso,
      });

      const ch: 'wa' | 'tg' = String(row.channel || 'wa') === 'tg' ? 'tg' : 'wa';
      fastWakeEvents.push({
        user_id: uid,
        channel: ch,
        event_type: ch === 'wa' ? 'wa_fast_wake' : 'tg_fast_wake',
        campaign_id: String(row.campaign_id || '').trim() || null,
        job_id: String(row.id || '').trim() || null,
        group_jid: String(row.group_jid || '').trim() || null,
        template_id: String(row.template_id || '').trim() || null,
        seconds: 0,
        label: 'connected_fast_path',
        error: null,
      });
    }

    await this.enqueueRows(toEnqueue);
    if (fastWakeEvents.length > 0) {
      try {
        await supabase.from('limit_learning_events').insert(fastWakeEvents);
      } catch (e: any) {
        this.logger.warn(
          `[Campaigns] autoWakeConnectivityRetryJobsForUser(${uid}) fast-wake metrics insert failed: ${e?.message ?? String(e)}`,
        );
      }
    }

    const campaignsTouched = new Set(
      filteredRows
        .map((r: any) => String(r.campaign_id || '').trim())
        .filter(Boolean),
    ).size;

    this.logger.log(
      `[Campaigns] autoWakeConnectivityRetryJobsForUser userId=${uid} hint=${channelHint ?? 'all'} woken=${toEnqueue.length} campaigns=${campaignsTouched} stepDelayMs=${stepDelayMs}`,
    );

    return {
      success: true,
      woken: toEnqueue.length,
      campaigns: campaignsTouched,
    };
  }

  /**
   * Safety-net для "осиротевших" pending-задач:
   * строка есть в БД, но job отсутствует во всех состояниях BullMQ (обычный/retry).
   * Такие задачи переочередиваются идемпотентно через enqueueRows.
   */
  async autoRequeueOrphanPendingJobs(params?: {
    userId?: string;
    channelHint?: 'wa' | 'tg';
    maxJobs?: number;
    stepDelayMs?: number;
  }): Promise<{
    success: boolean;
    scanned: number;
    orphaned: number;
    requeued: number;
    message?: string;
  }> {
    const supabase = this.supabaseService.getClient();
    const maxJobs = Math.max(20, Math.min(2000, params?.maxJobs ?? 300));
    const stepDelayMs = Math.max(100, Math.min(5000, params?.stepDelayMs ?? 250));
    const nowIso = new Date().toISOString();

    let query = supabase
      .from('campaign_jobs')
      .select(
        'id, campaign_id, user_id, group_jid, template_id, channel, scheduled_at, error, sent_at',
      )
      .eq('status', 'pending')
      .is('sent_at', null)
      .lte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: true })
      .limit(maxJobs);

    const uid = String(params?.userId || '').trim();
    if (uid) query = query.eq('user_id', uid);
    if (params?.channelHint) query = query.eq('channel', params.channelHint);

    const { data: rows, error } = await query;
    if (error) {
      this.logger.warn(
        `[Campaigns] autoRequeueOrphanPendingJobs: select error: ${error.message || String(error)}`,
      );
      return {
        success: false,
        scanned: 0,
        orphaned: 0,
        requeued: 0,
        message: 'supabase_jobs_select_error',
      };
    }

    if (!rows?.length) {
      return { success: true, scanned: 0, orphaned: 0, requeued: 0 };
    }

    const campaignIds = Array.from(
      new Set(
        rows
          .map((r: any) => String(r.campaign_id || '').trim())
          .filter(Boolean),
      ),
    );
    const runnableCampaignIds = new Set<string>();
    if (campaignIds.length > 0) {
      const { data: campaigns } = await supabase
        .from('campaigns')
        .select('id, status, paused')
        .in('id', campaignIds);
      for (const c of campaigns ?? []) {
        const id = String((c as any)?.id || '').trim();
        if (!id) continue;
        if (String((c as any)?.status || '') === 'running' && !(c as any)?.paused) {
          runnableCampaignIds.add(id);
        }
      }
    }

    const orphanedRows: Array<any> = [];
    for (const row of rows) {
      const campaignId = String((row as any).campaign_id || '').trim();
      if (campaignId && !runnableCampaignIds.has(campaignId)) continue;
      const userId = String((row as any).user_id || '').trim();
      if (!userId) continue;
      const q = this.queueService.getCampaignSendQueueForUser(userId);
      const id = String((row as any).id || '').trim();
      if (!id) continue;
      const regular = await q.getJob(id);
      const retry = await q.getJob(`retry__${id}`);
      const retryLegacy = await q.getJob(`retry:${id}`);
      if (!regular && !retry && !retryLegacy) orphanedRows.push(row);
    }

    if (!orphanedRows.length) {
      return {
        success: true,
        scanned: rows.length,
        orphaned: 0,
        requeued: 0,
      };
    }

    const nowMs = Date.now();
    const toEnqueue: Array<any> = [];
    for (let i = 0; i < orphanedRows.length; i++) {
      const row: any = orphanedRows[i];
      const newIso = new Date(nowMs + i * stepDelayMs).toISOString();
      await supabase
        .from('campaign_jobs')
        .update({
          status: 'pending',
          error: null,
          sent_at: null,
          scheduled_at: newIso,
        })
        .eq('id', row.id)
        .eq('status', 'pending');
      toEnqueue.push({
        id: row.id,
        user_id: row.user_id,
        group_jid: row.group_jid,
        template_id: row.template_id,
        channel: row.channel,
        scheduled_at: newIso,
      });
    }

    await this.enqueueRows(toEnqueue);
    if (toEnqueue.length > 0) {
      const first = toEnqueue[0];
      await this.persistRecoveryAuditEvent({
        userId: String(first.user_id || ''),
        channel: String(first.channel || 'wa') === 'tg' ? 'tg' : 'wa',
        eventType: 'orphan_requeue',
        campaignId: String((orphanedRows[0] as any)?.campaign_id || '') || null,
        label: `count=${toEnqueue.length};scope=${uid || 'all'};${
          params?.channelHint ?? 'all'
        }`,
        seconds: toEnqueue.length,
      });
    }
    const logScope = `${uid || 'all'}:${params?.channelHint ?? 'all'}`;
    const lastLogAt = this.orphanRequeueLogLastAt.get(logScope) ?? 0;
    if (Date.now() - lastLogAt >= 60_000) {
      this.orphanRequeueLogLastAt.set(logScope, Date.now());
      this.logger.warn(
        `[Campaigns] orphan pending requeue: scanned=${rows.length}, orphaned=${orphanedRows.length}, requeued=${toEnqueue.length}, user=${uid || 'all'}, channel=${params?.channelHint ?? 'all'}`,
      );
    }

    return {
      success: true,
      scanned: rows.length,
      orphaned: orphanedRows.length,
      requeued: toEnqueue.length,
    };
  }

  /**
   * Поднимает "исторические" failed из транзиентных причин обратно в pending.
   * Используется как консервативный авто-heal после деплоев/рестартов.
   */
  async autoRecoverTransientFailedJobs(params?: {
    userId?: string;
    channelHint?: 'wa' | 'tg';
    maxJobs?: number;
    stepDelayMs?: number;
    windowHours?: number;
  }): Promise<{
    success: boolean;
    scanned: number;
    recovered: number;
    message?: string;
  }> {
    const supabase = this.supabaseService.getClient();
    const maxJobs = Math.max(20, Math.min(2000, params?.maxJobs ?? 250));
    const stepDelayMs = Math.max(150, Math.min(8000, params?.stepDelayMs ?? 350));
    const windowHours = Math.max(1, Math.min(96, params?.windowHours ?? 24));
    const fromIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

    let query = supabase
      .from('campaign_jobs')
      .select(
        'id, campaign_id, user_id, group_jid, template_id, channel, error, sent_at',
      )
      .eq('status', 'failed')
      .not('error', 'is', null)
      .gte('sent_at', fromIso)
      .order('sent_at', { ascending: false })
      .limit(maxJobs);

    const uid = String(params?.userId || '').trim();
    if (uid) query = query.eq('user_id', uid);
    if (params?.channelHint) query = query.eq('channel', params.channelHint);

    const { data: rows, error } = await query;
    if (error) {
      this.logger.warn(
        `[Campaigns] autoRecoverTransientFailedJobs: select error: ${error.message || String(error)}`,
      );
      return {
        success: false,
        scanned: 0,
        recovered: 0,
        message: 'supabase_jobs_select_error',
      };
    }
    if (!rows?.length) {
      return { success: true, scanned: 0, recovered: 0 };
    }

    const campaignIds = Array.from(
      new Set(
        rows
          .map((r: any) => String(r.campaign_id || '').trim())
          .filter(Boolean),
      ),
    );
    const runnableCampaignIds = new Set<string>();
    if (campaignIds.length > 0) {
      const { data: campaigns } = await supabase
        .from('campaigns')
        .select('id, status, paused')
        .in('id', campaignIds);
      for (const c of campaigns ?? []) {
        const cid = String((c as any)?.id || '').trim();
        if (!cid) continue;
        if (String((c as any)?.status || '') === 'running' && !(c as any)?.paused) {
          runnableCampaignIds.add(cid);
        }
      }
    }

    const candidates: any[] = [];
    for (const row of rows) {
      const campaignId = String((row as any).campaign_id || '').trim();
      if (campaignId && !runnableCampaignIds.has(campaignId)) continue;
      const channel: 'wa' | 'tg' =
        String((row as any).channel || 'wa') === 'tg' ? 'tg' : 'wa';
      const classified = classifyDeliveryError(
        channel,
        String((row as any).error || ''),
      );
      if (classified.kind !== 'transient') continue;
      candidates.push(row);
    }

    if (!candidates.length) {
      return { success: true, scanned: rows.length, recovered: 0 };
    }

    const nowMs = Date.now();
    const toEnqueue: any[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const row: any = candidates[i];
      const newIso = new Date(nowMs + i * stepDelayMs).toISOString();
      await supabase
        .from('campaign_jobs')
        .update({
          status: 'pending',
          error: null,
          sent_at: null,
          scheduled_at: newIso,
        })
        .eq('id', row.id)
        .eq('status', 'failed');
      toEnqueue.push({
        id: row.id,
        user_id: row.user_id,
        group_jid: row.group_jid,
        template_id: row.template_id,
        channel: row.channel,
        scheduled_at: newIso,
      });
    }

    await this.enqueueRows(toEnqueue);
    if (toEnqueue.length > 0) {
      const first = toEnqueue[0];
      await this.persistRecoveryAuditEvent({
        userId: String(first.user_id || ''),
        channel: String(first.channel || 'wa') === 'tg' ? 'tg' : 'wa',
        eventType: 'transient_recover',
        campaignId: String((candidates[0] as any)?.campaign_id || '') || null,
        label: `count=${toEnqueue.length};windowHours=${windowHours}`,
        seconds: toEnqueue.length,
      });
    }
    this.logger.warn(
      `[Campaigns] transient failed recovered: scanned=${rows.length}, recovered=${toEnqueue.length}, user=${uid || 'all'}, channel=${params?.channelHint ?? 'all'}, windowHours=${windowHours}`,
    );

    return {
      success: true,
      scanned: rows.length,
      recovered: toEnqueue.length,
    };
  }

  /**
   * Поднимает failed=wa_connectivity_retry_exhausted обратно в pending,
   * но только если WA стабильно connected заданное время (gate).
   */
  async autoRecoverWaConnectivityExhaustedJobs(params?: {
    userId?: string;
    maxJobs?: number;
    stepDelayMs?: number;
    windowHours?: number;
    stableConnectedMs?: number;
  }): Promise<{
    success: boolean;
    scanned: number;
    recovered: number;
    skippedByGate: number;
    message?: string;
  }> {
    const supabase = this.supabaseService.getClient();
    const maxJobs = Math.max(20, Math.min(2000, params?.maxJobs ?? 180));
    const stepDelayMs = Math.max(150, Math.min(10_000, params?.stepDelayMs ?? 500));
    const windowHours = Math.max(1, Math.min(168, params?.windowHours ?? 72));
    const stableConnectedMs = Math.max(
      60_000,
      Math.min(
        12 * 60 * 60 * 1000,
        params?.stableConnectedMs ??
          Number(process.env.WA_EXHAUSTED_RECOVERY_STABLE_MS || 5 * 60_000),
      ),
    );
    const fromIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

    let query = supabase
      .from('campaign_jobs')
      .select(
        'id, campaign_id, user_id, group_jid, template_id, channel, error, sent_at',
      )
      .eq('status', 'failed')
      .eq('channel', 'wa')
      .eq('error', 'wa_connectivity_retry_exhausted')
      .gte('sent_at', fromIso)
      .order('sent_at', { ascending: false })
      .limit(maxJobs);

    const uid = String(params?.userId || '').trim();
    if (uid) query = query.eq('user_id', uid);

    const { data: rows, error } = await query;
    if (error) {
      this.logger.warn(
        `[Campaigns] autoRecoverWaConnectivityExhaustedJobs: select error: ${error.message || String(error)}`,
      );
      return {
        success: false,
        scanned: 0,
        recovered: 0,
        skippedByGate: 0,
        message: 'supabase_jobs_select_error',
      };
    }
    if (!rows?.length) {
      return { success: true, scanned: 0, recovered: 0, skippedByGate: 0 };
    }

    const campaignIds = Array.from(
      new Set(
        rows
          .map((r: any) => String(r.campaign_id || '').trim())
          .filter(Boolean),
      ),
    );
    const runnableCampaignIds = new Set<string>();
    if (campaignIds.length > 0) {
      const { data: campaigns } = await supabase
        .from('campaigns')
        .select('id, status, paused')
        .in('id', campaignIds);
      for (const c of campaigns ?? []) {
        const cid = String((c as any)?.id || '').trim();
        if (!cid) continue;
        if (String((c as any)?.status || '') === 'running' && !(c as any)?.paused) {
          runnableCampaignIds.add(cid);
        }
      }
    }

    const gatePassUsers = new Set<string>();
    let skippedByGate = 0;
    const candidates: any[] = [];
    for (const row of rows) {
      const campaignId = String((row as any).campaign_id || '').trim();
      if (campaignId && !runnableCampaignIds.has(campaignId)) continue;
      const userId = String((row as any).user_id || '').trim();
      if (!userId) continue;

      if (!gatePassUsers.has(userId)) {
        const st = await this.whatsappService.getStatus(userId);
        const stableMs = this.whatsappService.getConnectedStableMs(userId);
        if (st.status !== 'connected' || stableMs < stableConnectedMs) {
          skippedByGate += 1;
          continue;
        }
        gatePassUsers.add(userId);
      }

      candidates.push(row);
    }

    if (!candidates.length) {
      return {
        success: true,
        scanned: rows.length,
        recovered: 0,
        skippedByGate,
      };
    }

    const nowMs = Date.now();
    const toEnqueue: any[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const row: any = candidates[i];
      const newIso = new Date(nowMs + i * stepDelayMs).toISOString();
      await supabase
        .from('campaign_jobs')
        .update({
          status: 'pending',
          error: null,
          sent_at: null,
          scheduled_at: newIso,
        })
        .eq('id', row.id)
        .eq('status', 'failed')
        .eq('error', 'wa_connectivity_retry_exhausted');
      toEnqueue.push({
        id: row.id,
        user_id: row.user_id,
        group_jid: row.group_jid,
        template_id: row.template_id,
        channel: 'wa',
        scheduled_at: newIso,
      });
    }

    await this.enqueueRows(toEnqueue);
    if (toEnqueue.length > 0) {
      const first = toEnqueue[0];
      await this.persistRecoveryAuditEvent({
        userId: String(first.user_id || ''),
        channel: 'wa',
        eventType: 'wa_exhausted_recover',
        campaignId: String((candidates[0] as any)?.campaign_id || '') || null,
        label: `count=${toEnqueue.length};stableMs=${stableConnectedMs}`,
        seconds: toEnqueue.length,
      });
    }
    this.logger.warn(
      `[Campaigns] WA exhausted recovered: scanned=${rows.length}, recovered=${toEnqueue.length}, skippedByGate=${skippedByGate}, stableConnectedMs=${stableConnectedMs}, user=${uid || 'all'}`,
    );
    return {
      success: true,
      scanned: rows.length,
      recovered: toEnqueue.length,
      skippedByGate,
    };
  }

  /**
   * Автовосстановление paused-рассылок после реконнекта WA/TG.
   * Ищем jobs с error=wa_not_connected / telegram_not_connected, проверяем коннект,
   * снимаем paused с кампании и возвращаем часть jobs в pending со сдвигом по времени.
   *
   * Дополнение: при реконнете также дергается autoResumeDisconnectedJobsForUser из WA/TG —
   * этот метод остаётся как периодический safety-net (CAMPAIGN_REPEAT_ENABLED).
   */
  async autoResumeDisconnectedJobs(params?: {
    batchSizePerCampaign?: number;
    maxJobsScan?: number;
    stepDelayMs?: number;
  }) {
    const batchSizePerCampaign = Math.max(
      1,
      Math.min(500, params?.batchSizePerCampaign ?? 120),
    );
    const maxJobsScan = Math.max(
      50,
      Math.min(5000, params?.maxJobsScan ?? 2000),
    );
    const stepDelayMs = Math.max(
      250,
      Math.min(10_000, params?.stepDelayMs ?? 1500),
    );

    const supabase = this.supabaseService.getClient();
    const nowMs = Date.now();

    let pausedRows: any[] | null = null;
    let error: any = null;
    if (this.pausedJobStatusSupported !== false) {
      const first = await supabase
        .from('campaign_jobs')
        .select(
          'id, campaign_id, user_id, group_jid, template_id, channel, scheduled_at, error',
        )
        .eq('status', 'paused')
        .in('error', ['wa_not_connected', 'telegram_not_connected'])
        .limit(maxJobsScan);
      pausedRows = first.data;
      error = first.error;
      if (error && this.isPausedJobStatusUnsupportedError(error)) {
        this.pausedJobStatusSupported = false;
        return { success: true, resumed: 0, campaigns: 0, at: nowMs };
      }
    }

    if (error) {
      this.logger.warn(
        `[Campaigns] autoResumeDisconnectedJobs: select error: ${error.message || String(error)}`,
      );
      return { success: false, message: 'supabase_jobs_select_error' };
    }

    if (!pausedRows?.length) return { success: true, resumed: 0, campaigns: 0 };

    const { resumed: resumedTotal, campaigns: campaignsTouched } =
      await this.resumeDisconnectedPausedRows(pausedRows, {
        batchSizePerCampaign,
        stepDelayMs,
      });

    return {
      success: true,
      resumed: resumedTotal,
      campaigns: campaignsTouched,
      at: nowMs,
    };
  }

  /**
   * Автоматический "операторский" heal:
   * - если перегруз high/critical;
   * - и есть задачи failed/pending;
   * - и канал подключен;
   * => выполняем быстрый requeue failed+pending с cooldown.
   */
  async autoHealOverloadedCampaigns(params?: {
    maxCampaignsScan?: number;
    minOverloadLevel?: 'high' | 'critical';
    cooldownMs?: number;
  }): Promise<{ success: boolean; touched: number; healed: number }> {
    const supabase = this.supabaseService.getClient();
    const maxCampaignsScan = Math.max(
      5,
      Math.min(100, params?.maxCampaignsScan ?? 30),
    );
    const mode = this.campaignHealMode();
    const minOverloadLevel =
      params?.minOverloadLevel ?? (mode === 'incident' ? 'critical' : 'high');
    const cooldownMs = Math.max(
      60_000,
      Math.min(
        60 * 60_000,
        params?.cooldownMs ?? (mode === 'incident' ? 20 * 60_000 : 8 * 60_000),
      ),
    );

    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select('id, user_id, channel, status, paused')
      .eq('status', 'running')
      .eq('paused', false)
      .limit(maxCampaignsScan);

    if (error || !campaigns?.length) {
      return { success: !error, touched: 0, healed: 0 };
    }

    let touched = 0;
    let healed = 0;
    const now = Date.now();

    for (const c of campaigns as any[]) {
      touched += 1;
      const campaignId = String(c.id || '');
      const userId = String(c.user_id || '');
      const channel: 'wa' | 'tg' = c.channel === 'tg' ? 'tg' : 'wa';
      if (!campaignId || !userId) continue;

      const lastRunMs = this.autoHealLastRunByCampaign.get(campaignId) ?? 0;
      if (now - lastRunMs < cooldownMs) continue;

      const overload = await this.computeOverloadState({
        userId,
        channelHint: channel,
      });
      const severity =
        overload.level === 'critical'
          ? 3
          : overload.level === 'high'
            ? 2
            : overload.level === 'elevated'
              ? 1
              : 0;
      const minSeverity = minOverloadLevel === 'critical' ? 3 : 2;
      if (severity < minSeverity) continue;

      // Есть ли что лечить: failed/pending
      const { count: pendingOrFailedCount } = await supabase
        .from('campaign_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .in('status', ['pending', 'failed']);

      if (!pendingOrFailedCount || pendingOrFailedCount < 3) continue;

      // Канал должен быть живой, иначе requeue сейчас только усилит шум.
      if (channel === 'wa') {
        let st = await this.whatsappService.getStatus(userId);
        if (st.status !== 'connected') {
          if (!runtimeHasCapability('worker')) continue;
          try {
            await this.whatsappService.startSession(userId);
          } catch {
            // best-effort
          }
          st = await this.whatsappService.getStatus(userId);
        }
        if (st.status !== 'connected') continue;
      } else {
        const tg = await this.telegramService.getStatus(userId);
        if (tg?.status !== 'connected') continue;
      }

      const statuses: Array<'failed' | 'pending'> =
        mode === 'incident' ? ['failed'] : ['failed', 'pending'];
      const res = await this.requeueCampaign(campaignId, userId, {
        forceNow: true,
        statuses,
      });
      if (res?.success) {
        healed += 1;
        this.autoHealLastRunByCampaign.set(campaignId, now);
        await this.persistRecoveryAuditEvent({
          userId,
          channel,
          eventType: 'auto_heal_applied',
          campaignId,
          label: `mode=${mode};overload=${overload.level};hits5m=${overload.hits5m};statuses=${statuses.join(',')}`,
        });
        this.logger.warn(
          `[Campaigns] auto-heal applied: campaign=${campaignId}, userId=${userId}, channel=${channel}, mode=${mode}, overload=${overload.level}, hits5m=${overload.hits5m}, requeued=${(res as any).enqueued ?? 'n/a'}`,
        );
      }
    }

    return { success: true, touched, healed };
  }
}
