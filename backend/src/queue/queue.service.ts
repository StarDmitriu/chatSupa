import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis, { RedisOptions } from 'ioredis';
import { CampaignVipService } from './campaign-vip.service';
import { SupabaseService } from '../supabase/supabase.service';
import { classifyDeliveryError } from './delivery-error-classifier';

/** Имя очереди до шардирования (и при CAMPAIGN_SEND_SHARD_COUNT===1). */
export const CAMPAIGN_SEND_QUEUE_LEGACY = 'campaign-send';

/**
 * Если CAMPAIGN_SEND_SHARD_COUNT не задан: ориентир на ~20 одновременно активных аккаунтов (WA+TG на userId в одном шарде).
 */
export const CAMPAIGN_SEND_DEFAULT_SHARD_COUNT = 20;

/** Верхняя граница шардов (переопределение: CAMPAIGN_SEND_MAX_SHARD_COUNT). */
export const CAMPAIGN_SEND_SHARD_CAP_DEFAULT = 64;
/** Абсолютный защитный лимит (можно переопределять env, но не выше этого порога). */
export const CAMPAIGN_SEND_SHARD_HARD_CAP = 1024;

export function campaignSendMaxShardCount(): number {
  const rawStr = (process.env.CAMPAIGN_SEND_MAX_SHARD_COUNT ?? '').trim();
  if (!rawStr) return CAMPAIGN_SEND_SHARD_CAP_DEFAULT;
  const raw = Number(rawStr);
  if (!Number.isFinite(raw) || raw < 1) return CAMPAIGN_SEND_SHARD_CAP_DEFAULT;
  return Math.min(CAMPAIGN_SEND_SHARD_HARD_CAP, Math.floor(raw));
}

/**
 * Имена очередей BullMQ, которые обслуживает воркер рассылки (шарды + легаси при N>1).
 */
export function campaignSendBullQueueNames(): string[] {
  const n = campaignSendShardCount();
  if (n <= 1) return [CAMPAIGN_SEND_QUEUE_LEGACY];
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    names.push(`${CAMPAIGN_SEND_QUEUE_LEGACY}-${i}`);
  }
  names.push(CAMPAIGN_SEND_QUEUE_LEGACY);
  return names;
}

/**
 * Число параллельных воркеров рассылки: userId → очередь campaign-send-{shard}, shard = hash(userId)%N.
 * На шард один воркер с concurrency=1 → не более одной активной отправки на пользователя, до N пользователей параллельно.
 */
export function campaignSendShardCount(): number {
  const max = campaignSendMaxShardCount();
  const rawStr = (process.env.CAMPAIGN_SEND_SHARD_COUNT ?? '').trim();
  if (!rawStr) return Math.min(max, CAMPAIGN_SEND_DEFAULT_SHARD_COUNT);
  const raw = Number(rawStr);
  if (!Number.isFinite(raw) || raw < 1) {
    return Math.min(max, CAMPAIGN_SEND_DEFAULT_SHARD_COUNT);
  }
  return Math.min(max, Math.floor(raw));
}

export function campaignSendQueueNameForUser(userId: string): string {
  const n = campaignSendShardCount();
  if (n <= 1) return CAMPAIGN_SEND_QUEUE_LEGACY;
  let h = 0;
  const s = String(userId || '');
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  const shard = Math.abs(h) % n;
  return `${CAMPAIGN_SEND_QUEUE_LEGACY}-${shard}`;
}

/** Счётчики BullMQ по одной очереди (ключи совместимы с getJobCounts). */
export type CampaignSendQueueCounts = {
  waiting: number;
  active: number;
  delayed: number;
  paused: number;
  prioritized: number;
  waitingChildren: number;
  failed: number;
};

export type CampaignFailureSnapshot = {
  windowHours: 1 | 24;
  totalsByChannel: Record<'wa' | 'tg', number>;
  topReasonsByChannel: Record<'wa' | 'tg', Array<{ code: string; count: number }>>;
};

export type CampaignRecoverySnapshot = {
  windowHours: 1 | 24;
  totalsByEvent: Array<{ eventType: string; count: number }>;
};

function normalizeCampaignJobCounts(raw: Record<string, number>): CampaignSendQueueCounts {
  return {
    waiting: raw.waiting ?? 0,
    active: raw.active ?? 0,
    delayed: raw.delayed ?? 0,
    paused: raw.paused ?? 0,
    prioritized: raw.prioritized ?? 0,
    waitingChildren: raw['waiting-children'] ?? 0,
    failed: raw.failed ?? 0,
  };
}

function buildRedisOptions(): RedisOptions {
  const redisUrl = (process.env.REDIS_URL || '').trim();

  // общие опции, критичные для BullMQ
  const common: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  if (redisUrl) {
    const u = new URL(redisUrl);

    const isTls = u.protocol === 'rediss:';
    const port = u.port ? Number(u.port) : isTls ? 6380 : 6379;

    const dbFromPath = (u.pathname || '').replace('/', '');
    const db = dbFromPath ? Number(dbFromPath) : undefined;

    return {
      ...common,
      host: u.hostname,
      port,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      db: Number.isFinite(db as any) ? db : undefined,
      tls: isTls ? {} : undefined,
    };
  }

  // fallback на host/port
  return {
    ...common,
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT || 6379),
    password: (process.env.REDIS_PASSWORD || '').trim() || undefined,
    db: process.env.REDIS_DB ? Number(process.env.REDIS_DB) : undefined,
  };
}

@Injectable()
export class QueueService {
  public readonly connectionOptions: RedisOptions;
  public readonly connection: IORedis;
  /** @deprecated Используйте getCampaignSendQueueForUser(userId) — очередь шардируется по userId. */
  public readonly campaignQueue: Queue;

  private readonly campaignQueuesByName = new Map<string, Queue>();

  constructor(
    private readonly campaignVip: CampaignVipService,
    private readonly supabaseService: SupabaseService,
  ) {
    this.connectionOptions = buildRedisOptions();

    this.connection = new IORedis(this.connectionOptions);

    // чтобы не было "Unhandled error event" и было видно причину
    this.connection.on('error', (e) => {
      console.warn('[Redis] error:', (e as any)?.message ?? e);
    });
    this.connection.on('connect', () => {
      console.log(
        `[Redis] connected to ${this.connectionOptions.host}:${this.connectionOptions.port}`,
      );
    });

    this.campaignQueue = this.getOrCreateQueue(CAMPAIGN_SEND_QUEUE_LEGACY);
  }

  /** Очередь BullMQ для рассылки данного пользователя (стабильный шард по userId). */
  getCampaignSendQueueForUser(userId: string): Queue {
    return this.getOrCreateQueue(campaignSendQueueNameForUser(userId));
  }

  private getOrCreateQueue(name: string): Queue {
    let q = this.campaignQueuesByName.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connectionOptions });
      this.campaignQueuesByName.set(name, q);
    }
    return q;
  }

  /**
   * Счётчики BullMQ по всем очередям рассылки (для мониторинга «хвоста» и залипаний).
   */
  async getCampaignSendQueuesMetrics(): Promise<{
    shardCount: number;
    maxShardCount: number;
    workerListenerCount: number;
    concurrencyPerListener: number;
    queues: Record<string, CampaignSendQueueCounts>;
    summary: {
      totals: CampaignSendQueueCounts;
      maxWaitingQueue: { name: string; waiting: number } | null;
      maxDelayedQueue: { name: string; delayed: number } | null;
      maxFailedQueue: { name: string; failed: number } | null;
    };
    skew: {
      /** Только `campaign-send-{n}`, без легаси `campaign-send`. */
      shardQueueCount: number;
      meanWaiting: number | null;
      coefficientOfVariation: number | null;
      max: { name: string; waiting: number } | null;
      min: { name: string; waiting: number } | null;
      legacyWaiting: number | null;
    };
    campaignVip: ReturnType<CampaignVipService['getVipStats']>;
    failedSummary: {
      sampleLimit: number;
      windows: CampaignFailureSnapshot[];
    };
    recoverySummary: {
      sampleLimit: number;
      windows: CampaignRecoverySnapshot[];
    };
    config: {
      repeatOverlapRaw: boolean;
      repeatOverlapEffective: boolean;
      repeatOverlapForceUnsafe: boolean;
      healMode: 'normal' | 'incident';
    };
    at: string;
  }> {
    const countTypes = [
      'waiting',
      'active',
      'delayed',
      'paused',
      'prioritized',
      'waiting-children',
      'failed',
    ] as const;

    const names = campaignSendBullQueueNames();
    const shardN = campaignSendShardCount();
    const queues: Record<string, CampaignSendQueueCounts> = {};

    const emptyTotals = (): CampaignSendQueueCounts => ({
      waiting: 0,
      active: 0,
      delayed: 0,
      paused: 0,
      prioritized: 0,
      waitingChildren: 0,
      failed: 0,
    });

    const totals = emptyTotals();

    for (const name of names) {
      const q = this.getOrCreateQueue(name);
      const c = await q.getJobCounts(...countTypes);
      const row = normalizeCampaignJobCounts(c);
      queues[name] = row;
      totals.waiting += row.waiting;
      totals.active += row.active;
      totals.delayed += row.delayed;
      totals.paused += row.paused;
      totals.prioritized += row.prioritized;
      totals.waitingChildren += row.waitingChildren;
      totals.failed += row.failed;
    }

    let maxWaitingQueue: { name: string; waiting: number } | null = null;
    let maxDelayedQueue: { name: string; delayed: number } | null = null;
    let maxFailedQueue: { name: string; failed: number } | null = null;
    for (const name of Object.keys(queues)) {
      const row = queues[name];
      if (!maxWaitingQueue || row.waiting > maxWaitingQueue.waiting) {
        maxWaitingQueue = { name, waiting: row.waiting };
      }
      if (!maxDelayedQueue || row.delayed > maxDelayedQueue.delayed) {
        maxDelayedQueue = { name, delayed: row.delayed };
      }
      if (!maxFailedQueue || row.failed > maxFailedQueue.failed) {
        maxFailedQueue = { name, failed: row.failed };
      }
    }

    const shardRe = /^campaign-send-\d+$/;
    const shardWaitingEntries = Object.entries(queues).filter(([n]) =>
      shardRe.test(n),
    );
    const wVals = shardWaitingEntries.map(([, r]) => r.waiting);
    const shardQueueCount = wVals.length;
    let meanWaiting: number | null = null;
    let coefficientOfVariation: number | null = null;
    let max: { name: string; waiting: number } | null = null;
    let min: { name: string; waiting: number } | null = null;

    if (shardQueueCount > 0) {
      const sum = wVals.reduce((a, b) => a + b, 0);
      meanWaiting = sum / shardQueueCount;
      if (shardQueueCount > 1 && meanWaiting > 0) {
        const variance =
          wVals.reduce((acc, v) => acc + (v - meanWaiting!) ** 2, 0) /
          shardQueueCount;
        const st = Math.sqrt(variance);
        coefficientOfVariation = st / meanWaiting;
      } else if (meanWaiting === 0) {
        coefficientOfVariation = 0;
      }
      for (const [n, r] of shardWaitingEntries) {
        if (!max || r.waiting > max.waiting) max = { name: n, waiting: r.waiting };
        if (!min || r.waiting < min.waiting) min = { name: n, waiting: r.waiting };
      }
    }

    const legacyWaiting =
      shardN > 1 && queues[CAMPAIGN_SEND_QUEUE_LEGACY]
        ? queues[CAMPAIGN_SEND_QUEUE_LEGACY].waiting
        : null;

    const buildFailureSnapshot = async (
      windowHours: 1 | 24,
      sampleLimit = 3000,
    ): Promise<CampaignFailureSnapshot> => {
      const fromIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
      const rowsRes = await this.supabaseService
        .getClient()
        .from('campaign_jobs')
        .select('channel,error,sent_at')
        .eq('status', 'failed')
        .gte('sent_at', fromIso)
        .order('sent_at', { ascending: false })
        .limit(sampleLimit);

      const totalsByChannel: Record<'wa' | 'tg', number> = { wa: 0, tg: 0 };
      const reasonsMap: Record<'wa' | 'tg', Record<string, number>> = {
        wa: {},
        tg: {},
      };

      if (!rowsRes.error) {
        for (const row of rowsRes.data ?? []) {
          const ch: 'wa' | 'tg' = String((row as any).channel || 'wa') === 'tg' ? 'tg' : 'wa';
          totalsByChannel[ch] += 1;
          const code = classifyDeliveryError(ch, String((row as any).error || '')).normalizedCode;
          reasonsMap[ch][code] = (reasonsMap[ch][code] || 0) + 1;
        }
      }

      const toTop = (m: Record<string, number>) =>
        Object.entries(m)
          .map(([code, count]) => ({ code, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);

      return {
        windowHours,
        totalsByChannel,
        topReasonsByChannel: {
          wa: toTop(reasonsMap.wa),
          tg: toTop(reasonsMap.tg),
        },
      };
    };

    const [failed1h, failed24h] = await Promise.all([
      buildFailureSnapshot(1),
      buildFailureSnapshot(24),
    ]);

    const buildRecoverySnapshot = async (
      windowHours: 1 | 24,
      sampleLimit = 3000,
    ): Promise<CampaignRecoverySnapshot> => {
      const fromIso = new Date(
        Date.now() - windowHours * 60 * 60 * 1000,
      ).toISOString();
      const rowsRes = await this.supabaseService
        .getClient()
        .from('limit_learning_events')
        .select('event_type,created_at')
        .gte('created_at', fromIso)
        .in('event_type', [
          'orphan_requeue',
          'transient_recover',
          'wa_exhausted_recover',
          'wave_tail_blocked',
          'auto_heal_applied',
        ])
        .order('created_at', { ascending: false })
        .limit(sampleLimit);

      const byEvent: Record<string, number> = {};
      if (!rowsRes.error) {
        for (const row of rowsRes.data ?? []) {
          const ev = String((row as any).event_type || 'unknown');
          byEvent[ev] = (byEvent[ev] || 0) + 1;
        }
      }
      const totalsByEvent = Object.entries(byEvent)
        .map(([eventType, count]) => ({ eventType, count }))
        .sort((a, b) => b.count - a.count);
      return { windowHours, totalsByEvent };
    };

    const [recovery1h, recovery24h] = await Promise.all([
      buildRecoverySnapshot(1),
      buildRecoverySnapshot(24),
    ]);

    const repeatOverlapRaw =
      String(process.env.CAMPAIGN_REPEAT_ALLOW_OVERLAP || '').toLowerCase() ===
      'true';
    const repeatOverlapForceUnsafe =
      String(process.env.CAMPAIGN_REPEAT_OVERLAP_FORCE_UNSAFE || '').toLowerCase() ===
      'true';
    const healMode =
      String(process.env.CAMPAIGN_HEAL_MODE || 'normal').toLowerCase().trim() ===
      'incident'
        ? 'incident'
        : 'normal';

    return {
      shardCount: shardN,
      maxShardCount: campaignSendMaxShardCount(),
      workerListenerCount: names.length,
      concurrencyPerListener: 1,
      queues,
      summary: {
        totals,
        maxWaitingQueue,
        maxDelayedQueue,
        maxFailedQueue,
      },
      skew: {
        shardQueueCount,
        meanWaiting,
        coefficientOfVariation,
        max,
        min,
        legacyWaiting,
      },
      campaignVip: this.campaignVip.getVipStats(),
      failedSummary: {
        sampleLimit: 3000,
        windows: [failed1h, failed24h],
      },
      recoverySummary: {
        sampleLimit: 3000,
        windows: [recovery1h, recovery24h],
      },
      config: {
        repeatOverlapRaw,
        repeatOverlapEffective: repeatOverlapRaw && repeatOverlapForceUnsafe,
        repeatOverlapForceUnsafe,
        healMode,
      },
      at: new Date().toISOString(),
    };
  }
}
