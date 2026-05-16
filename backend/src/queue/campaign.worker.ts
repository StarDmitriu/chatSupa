//backend/src/queue/campaign.worker.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { CampaignVipService } from './campaign-vip.service';
import { classifyDeliveryError } from './delivery-error-classifier';
import {
  CAMPAIGN_SEND_QUEUE_LEGACY,
  campaignSendBullQueueNames,
  campaignSendShardCount,
  QueueService,
} from './queue.service';
import { TelegramService } from '../telegram/telegram.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  getRuntimeInstanceId,
  runtimeCapabilitiesLabel,
  runtimeHasCapability,
} from '../runtime/runtime-role';

type SendJobData = {
  jobId: string;
  userId: string;
  groupJid: string;
  templateId: string;
  channel?: 'wa' | 'tg';
};

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label = 'timeout',
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

type CampaignSendRhythmState = {
  /** wall clock после завершения обработки предыдущего job этой кампании */
  lastCompletedAtMs: number;
  /** scheduled_at предыдущего job (мс) — для интервала между слотами */
  lastScheduledAtMs: number;
};

@Injectable()
export class CampaignBullWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampaignBullWorker.name);
  private workers: Worker<SendJobData>[] = [];
  private isShuttingDown = false;
  private inFlightProcessors = 0;

  /**
   * Сохраняем интервалы из campaign_jobs.scheduled_at даже при «догоне» (Bull delay=0):
   * следующая отправка не раньше, чем lastCompleted + (этот scheduled − прошлый scheduled).
   * Сброс после простоя — новая волна / рестарт процесса / долгий перерыв.
   */
  private readonly campaignSendRhythmByCampaignId = new Map<
    string,
    CampaignSendRhythmState
  >();
  private static readonly RHYTHM_IDLE_RESET_MS = 60 * 60 * 1000;
  private static readonly RHYTHM_SCHEDULE_BACK_JUMP_MS = 120_000;

  // =========================
  // LIMIT LEARNING (in-memory)
  // =========================
  private readonly limitLearningWindowMs = 5 * 60_000; // 5 мин
  private tgFloodLearningByUser = new Map<
    string,
    { ts: number[]; lastSeconds?: number }
  >();

  private recordTgFloodWait(params: {
    userId: string;
    seconds: number;
    err: string;
  }) {
    const { userId, seconds, err } = params;
    const now = Date.now();
    const existing =
      this.tgFloodLearningByUser.get(userId) ??
      ({ ts: [], lastSeconds: undefined } as any);

    existing.ts = existing.ts.filter(
      (t: number) => now - t <= this.limitLearningWindowMs,
    );
    existing.ts.push(now);
    existing.lastSeconds = seconds;
    this.tgFloodLearningByUser.set(userId, existing);

    const hits5m = existing.ts.length;
    this.logger.warn(
      `[LIMIT LEARN][TG] flood_wait userId=${userId} seconds=${seconds} hits5m=${hits5m} err="${String(
        err || '',
      ).slice(0, 120)}"`,
    );
  }

  private getTgFloodHits5m(userId: string): number {
    const now = Date.now();
    const existing = this.tgFloodLearningByUser.get(userId);
    if (!existing) return 0;
    existing.ts = existing.ts.filter(
      (t: number) => now - t <= this.limitLearningWindowMs,
    );
    this.tgFloodLearningByUser.set(userId, existing);
    return existing.ts.length;
  }

  private buildTgFloodDelayMs(userId: string, seconds: number): number {
    const baseMs = Math.max(1_000, seconds * 1000);
    const hits5m = this.getTgFloodHits5m(userId);
    // "Обучающий" буфер: чем чаще ловим flood за 5 минут, тем длиннее пауза.
    const adaptiveExtraMs = Math.min(120_000, hits5m * 5_000);
    const jitterMs = 2_000 + Math.floor(Math.random() * 4_000); // 2-6s
    return baseMs + adaptiveExtraMs + jitterMs;
  }

  // Мягкий retry для WA-коннекта: не ставим всю кампанию на паузу из-за краткого обрыва.
  private static readonly WA_CONNECTIVITY_RETRY_MAX_ATTEMPTS = 8;
  private static readonly TG_CONNECTIVITY_RETRY_MAX_ATTEMPTS = 8;
  private static readonly CONNECTIVITY_RETRY_MAX_WINDOW_MS_DEFAULT =
    24 * 60 * 60_000;
  private parseWaConnectivityRetryAttempt(errorText: string | null | undefined): number {
    const raw = String(errorText || '').trim();
    const m = raw.match(/^wa_connect_retry_(\d+)$/i);
    if (!m) return 0;
    const n = Number(m[1] || 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  private parseTgConnectivityRetryAttempt(errorText: string | null | undefined): number {
    const raw = String(errorText || '').trim();
    const m = raw.match(/^tg_connect_retry_(\d+)$/i);
    if (!m) return 0;
    const n = Number(m[1] || 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  private buildWaConnectivityRetryDelayMs(attempt: number): number {
    // 15s, 30s, 45s ... с потолком 120s и небольшим jitter.
    const baseStepMs = 15_000;
    const cappedAttempt = Math.max(1, Math.min(8, Math.floor(attempt)));
    const linearMs = Math.min(120_000, baseStepMs * cappedAttempt);
    const jitterMs = 1_500 + Math.floor(Math.random() * 2_500);
    return linearMs + jitterMs;
  }

  private buildTgConnectivityRetryDelayMs(attempt: number): number {
    // 12s, 24s, 36s ... с потолком 120s и небольшим jitter.
    const baseStepMs = 12_000;
    const cappedAttempt = Math.max(1, Math.min(8, Math.floor(attempt)));
    const linearMs = Math.min(120_000, baseStepMs * cappedAttempt);
    const jitterMs = 1_000 + Math.floor(Math.random() * 2_000);
    return linearMs + jitterMs;
  }

  private async persistLimitLearningEvent(params: {
    userId: string;
    channel: 'wa' | 'tg';
    eventType: string;
    seconds?: number | null;
    campaignId?: string | null;
    jobId?: string | null;
    groupJid?: string | null;
    templateId?: string | null;
    label?: string | null;
    error?: string | null;
  }) {
    const supabase = this.supabaseService.getClient();
    try {
      const payload: any = {
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
      };
      await supabase.from('limit_learning_events').insert(payload);
    } catch (e: any) {
      this.logger.warn(
        `[LIMIT LEARN] db insert failed: ${e?.message ?? String(e)}`,
      );
    }
  }

  private normalizeTemplateText(raw: string | null | undefined): string {
    return String(raw ?? '').trim();
  }

  private sleepMs(ms: number): Promise<void> {
    const n = Math.max(0, Math.floor(ms));
    if (n <= 0) return Promise.resolve();
    return new Promise((r) => setTimeout(r, n));
  }

  private tgAutoUnselectThreshold(): number {
    const raw = Number((process.env.TG_AUTO_UNSELECT_FAIL_THRESHOLD || '5').trim());
    if (!Number.isFinite(raw)) return 5;
    return Math.max(1, Math.min(10, Math.floor(raw)));
  }

  private tgAutoUnselectWindowMs(): number {
    const raw = Number((process.env.TG_AUTO_UNSELECT_WINDOW_MS || String(24 * 60 * 60 * 1000)).trim());
    if (!Number.isFinite(raw)) return 24 * 60 * 60 * 1000;
    return Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Math.floor(raw)));
  }

  private tgAutoUnselectGraceSentMs(): number {
    const raw = Number((process.env.TG_AUTO_UNSELECT_GRACE_SENT_MS || String(6 * 60 * 60 * 1000)).trim());
    if (!Number.isFinite(raw)) return 6 * 60 * 60 * 1000;
    return Math.max(0, Math.min(7 * 24 * 60 * 60 * 1000, Math.floor(raw)));
  }

  private tgSoftQuarantineEnabled(): boolean {
    return String(process.env.TG_SOFT_QUARANTINE_ENABLED || 'true')
      .toLowerCase()
      .trim() !== 'false';
  }

  private tgSoftQuarantineDurationMs(): number {
    const raw = Number(
      (process.env.TG_SOFT_QUARANTINE_DURATION_MS || String(2 * 60 * 60 * 1000)).trim(),
    );
    if (!Number.isFinite(raw)) return 2 * 60 * 60 * 1000;
    return Math.max(10 * 60 * 1000, Math.min(7 * 24 * 60 * 60 * 1000, Math.floor(raw)));
  }

  private tgKeepSelectedOnAutoQuarantine(): boolean {
    return String(process.env.TG_KEEP_SELECTED_ON_AUTO_QUARANTINE || 'true')
      .toLowerCase()
      .trim() !== 'false';
  }

  private waConnectivityRetryMaxWindowMs(): number {
    const raw = Number(
      (process.env.WA_CONNECTIVITY_RETRY_MAX_WINDOW_MS || '').trim(),
    );
    if (!Number.isFinite(raw) || raw <= 0) {
      return CampaignBullWorker.CONNECTIVITY_RETRY_MAX_WINDOW_MS_DEFAULT;
    }
    return Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Math.floor(raw)));
  }

  private tgConnectivityRetryMaxWindowMs(): number {
    const raw = Number(
      (process.env.TG_CONNECTIVITY_RETRY_MAX_WINDOW_MS || '').trim(),
    );
    if (!Number.isFinite(raw) || raw <= 0) {
      return CampaignBullWorker.CONNECTIVITY_RETRY_MAX_WINDOW_MS_DEFAULT;
    }
    return Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Math.floor(raw)));
  }

  private async enqueueRetryJob(
    dbJob: {
      id: string;
      user_id: string;
      group_jid: string;
      template_id: string;
    },
    channel: 'wa' | 'tg',
    delayMs: number,
    templateId: string,
  ) {
    const q = this.queueService.getCampaignSendQueueForUser(String(dbJob.user_id));
    const retryQueueJobId = `retry__${dbJob.id}`;
    const existing = await q.getJob(retryQueueJobId);
    if (existing) {
      await existing.remove().catch(() => undefined);
    }
    const legacyExisting = await q.getJob(`retry:${dbJob.id}`);
    if (legacyExisting) {
      await legacyExisting.remove().catch(() => undefined);
    }
    await q.add(
      'send',
      {
        jobId: dbJob.id,
        userId: dbJob.user_id,
        groupJid: dbJob.group_jid,
        templateId,
        channel,
      },
      {
        jobId: retryQueueJobId,
        delay: delayMs,
        priority: this.campaignVip.getEnqueuePriority(String(dbJob.user_id)),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  private async maybeAutoUnselectTgGroup(params: {
    userId: string;
    tgChatId: string;
    errorText: string;
  }): Promise<void> {
    const supabase = this.supabaseService.getClient();
    const threshold = this.tgAutoUnselectThreshold();
    const windowMs = this.tgAutoUnselectWindowMs();
    const graceSentMs = this.tgAutoUnselectGraceSentMs();
    const fromIso = new Date(Date.now() - windowMs).toISOString();
    const reasons = [
      'CHAT_WRITE_FORBIDDEN',
      'USER_BANNED_IN_CHANNEL',
      'CHAT_ADMIN_REQUIRED',
      'PEER_ID_INVALID',
      'CHANNEL_INVALID',
      'CHANNEL_PRIVATE',
    ];
    try {
      let q = supabase
        .from('campaign_jobs')
        .select('error, sent_at')
        .eq('user_id', params.userId)
        .eq('group_jid', params.tgChatId)
        .eq('channel', 'tg')
        .eq('status', 'failed')
        .gte('sent_at', fromIso)
        .limit(200);
      const { data, error } = await q;
      if (error) {
        this.logger.warn(
          `[CampaignBullWorker] TG auto-unselect precheck failed: ${error.message || String(error)} (userId=${params.userId}, tgChatId=${params.tgChatId})`,
        );
        return;
      }
      let matched = 1; // + текущее падение
      for (const r of data || []) {
        const code = classifyDeliveryError('tg', String((r as any).error || '')).normalizedCode;
        if (reasons.includes(code)) matched += 1;
      }
      if (matched < threshold) return;

      // Защита от ложного карантина: если в недавнем окне были успешные отправки в этот чат,
      // считаем чат потенциально рабочим и не выключаем автоматически.
      if (graceSentMs > 0) {
        const sentSinceIso = new Date(Date.now() - graceSentMs).toISOString();
        const { count: recentSentCount } = await supabase
          .from('campaign_jobs')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', params.userId)
          .eq('group_jid', params.tgChatId)
          .eq('channel', 'tg')
          .eq('status', 'sent')
          .gte('sent_at', sentSinceIso);
        if ((recentSentCount ?? 0) > 0) {
          this.logger.warn(
            `[CampaignBullWorker] TG auto-unselect skipped by grace sent window (userId=${params.userId}, tgChatId=${params.tgChatId}, recentSent=${recentSentCount}, graceMs=${graceSentMs})`,
          );
          return;
        }
      }

      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const quarantineUntilIso = new Date(
        now + this.tgSoftQuarantineDurationMs(),
      ).toISOString();
      const keepSelected = this.tgKeepSelectedOnAutoQuarantine();
      const { error: updErr } = await supabase
        .from('telegram_groups')
        .update({
          is_selected: keepSelected ? true : false,
          quarantine_until: this.tgSoftQuarantineEnabled()
            ? quarantineUntilIso
            : null,
          quarantine_reason: this.tgSoftQuarantineEnabled()
            ? `auto_fail_${threshold}_in_${windowMs}ms`
            : null,
          updated_at: nowIso,
          last_send_error: params.errorText.slice(0, 500),
          last_send_error_at: nowIso,
        })
        .eq('user_id', params.userId)
        .eq('tg_chat_id', params.tgChatId);
      if (updErr) {
        this.logger.warn(
          `[CampaignBullWorker] TG auto-unselect apply failed: ${updErr.message || String(updErr)} (userId=${params.userId}, tgChatId=${params.tgChatId})`,
        );
      } else {
        await this.persistLimitLearningEvent({
          userId: params.userId,
          channel: 'tg',
          eventType: this.tgSoftQuarantineEnabled()
            ? 'tg_group_soft_quarantine'
            : 'tg_group_auto_unselect',
          groupJid: params.tgChatId,
          label: this.tgSoftQuarantineEnabled() ? quarantineUntilIso : null,
          error: params.errorText,
        });
        this.logger.warn(
          `[CampaignBullWorker] TG quarantine mark applied threshold=${threshold} windowMs=${windowMs} keepSelected=${keepSelected} (userId=${params.userId}, tgChatId=${params.tgChatId}, matched=${matched})`,
        );
      }
    } catch (e: any) {
      this.logger.warn(
        `[CampaignBullWorker] TG auto-unselect exception: ${e?.message ?? String(e)} (userId=${params.userId}, tgChatId=${params.tgChatId})`,
      );
    }
  }

  /**
   * Перед отправкой: при опоздании относительно Bull всё равно выдерживаем шаг сетки из scheduled_at.
   */
  private async enforceCampaignSendRhythm(
    campaignId: string,
    scheduledAtMs: number,
  ): Promise<void> {
    const now = Date.now();
    let st = this.campaignSendRhythmByCampaignId.get(campaignId);

    if (st) {
      if (now - st.lastCompletedAtMs > CampaignBullWorker.RHYTHM_IDLE_RESET_MS) {
        st = undefined;
      } else if (
        scheduledAtMs <
        st.lastScheduledAtMs - CampaignBullWorker.RHYTHM_SCHEDULE_BACK_JUMP_MS
      ) {
        st = undefined;
      }
    }

    if (!st) {
      if (scheduledAtMs > now) {
        await this.sleepMs(scheduledAtMs - now);
      }
      return;
    }

    const gapMs = Math.max(0, scheduledAtMs - st.lastScheduledAtMs);
    const waitUntil = st.lastCompletedAtMs + gapMs;
    if (now < waitUntil) {
      await this.sleepMs(waitUntil - now);
    } else if (scheduledAtMs > Date.now()) {
      await this.sleepMs(scheduledAtMs - Date.now());
    }
  }

  private recordCampaignSendRhythm(
    campaignId: string,
    scheduledAtMs: number,
  ): void {
    this.campaignSendRhythmByCampaignId.set(campaignId, {
      lastCompletedAtMs: Date.now(),
      lastScheduledAtMs: scheduledAtMs,
    });
  }

  private async stopCampaignIfDone(campaignId: string) {
    const cid = String(campaignId || '').trim();
    if (!cid) return;
    const supabase = this.supabaseService.getClient();
    try {
      const { data: camp } = await supabase
        .from('campaigns')
        .select('id, status, repeat_enabled, paused')
        .eq('id', cid)
        .maybeSingle();

      const c: any = camp;
      if (!c) return;
      if (c.status !== 'running') return;
      if (c.paused === true) return;
      if (c.repeat_enabled === true) return;

      const { data: inFlight } = await supabase
        .from('campaign_jobs')
        .select('id')
        .eq('campaign_id', cid)
        .in('status', ['pending', 'processing', 'paused'])
        .limit(1);

      if (inFlight?.length) return;

      await supabase
        .from('campaigns')
        .update({ status: 'stopped', next_repeat_at: null })
        .eq('id', cid)
        .eq('status', 'running')
        .eq('repeat_enabled', false);
    } catch (e: any) {
      this.logger.warn(
        `[CampaignBullWorker] stopCampaignIfDone failed: ${e?.message ?? e}`,
      );
    }
  }

  private async releaseWaOwnershipIfUserIdle(userId: string) {
    const uid = String(userId || '').trim();
    if (!uid) return;
    const supabase = this.supabaseService.getClient();
    try {
      const { data: activeJobs } = await supabase
        .from('campaign_jobs')
        .select('id')
        .eq('user_id', uid)
        .eq('channel', 'wa')
        .in('status', ['pending', 'processing', 'paused'])
        .limit(1);

      if (activeJobs?.length) return;

      await this.whatsapp.releaseSessionOwnership(
        uid,
        'worker_no_active_jobs',
      );
    } catch (e: any) {
      this.logger.warn(
        `[CampaignBullWorker] releaseWaOwnershipIfUserIdle failed: ${e?.message ?? e} (userId=${uid})`,
      );
    }
  }

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly whatsapp: WhatsappService,
    private readonly telegram: TelegramService,
    private readonly queueService: QueueService,
    private readonly subscriptions: SubscriptionsService,
    private readonly campaignVip: CampaignVipService,
  ) {}

  onModuleInit() {
    if (!runtimeHasCapability('worker')) {
      this.logger.log(
        `Campaign worker skipped for runtime=${runtimeCapabilitiesLabel()} instance=${getRuntimeInstanceId()}`,
      );
      return;
    }

    this.logger.warn(
      '### WORKER VERSION: 2026-04-06 campaign-send-sharded ###',
    );
    const connection = this.queueService.connectionOptions as any;
    const workerOpts = {
      connection,
      concurrency: 1,
      // TG send timeout 90s — lock должен быть больше, иначе job помечается stalled
      lockDuration: 120_000,
    };
    const processor = async (job: Job<SendJobData>) => this.process(job);

    const shards = campaignSendShardCount();
    const names = campaignSendBullQueueNames();
    if (shards <= 1) {
      this.workers = [
        new Worker<SendJobData>(
          CAMPAIGN_SEND_QUEUE_LEGACY,
          processor,
          workerOpts,
        ),
      ];
      this.logger.log(
        `BullMQ campaign-send: single queue "${CAMPAIGN_SEND_QUEUE_LEGACY}" (CAMPAIGN_SEND_SHARD_COUNT=1)`,
      );
    } else {
      this.workers = names.map(
        (name) => new Worker<SendJobData>(name, processor, workerOpts),
      );
      const sharded = names.filter((n) => n !== CAMPAIGN_SEND_QUEUE_LEGACY);
      this.logger.log(
        `BullMQ campaign-send: ${sharded.length} sharded queues + legacy drain; names=[${names.join(', ')}]; up to ~${shards} parallel user lanes`,
      );
    }

    for (const w of this.workers) {
      w.on('completed', (job) => {
        this.logger.log(`completed bull job ${job.id}`);
      });
      w.on('failed', (job, err) => {
        this.logger.error(`failed bull job ${job?.id}: ${err?.message ?? err}`);
      });
    }
  }

  async onModuleDestroy() {
    this.isShuttingDown = true;
    await Promise.all(this.workers.map((w) => w.pause().catch(() => undefined)));
    const timeoutAt = Date.now() + 45_000;
    while (this.inFlightProcessors > 0 && Date.now() < timeoutAt) {
      await this.sleepMs(200);
    }
    if (this.inFlightProcessors > 0) {
      this.logger.warn(
        `[CampaignBullWorker] shutdown with in-flight processors: ${this.inFlightProcessors}`,
      );
    }
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
    this.workers = [];
  }

  /**
   * Все воркеры (шард + легаси-очередь) в одном процессе:
   * сериализуем по паре userId+channel, чтобы WA и TG у одного пользователя
   * не блокировали друг друга, но внутри канала сохранялся строгий порядок.
   */
  private readonly userProcessTail = new Map<string, Promise<unknown>>();

  private runSerializedByUserChannel<T>(
    userId: string,
    channel: "wa" | "tg",
    fn: () => Promise<T>,
  ): Promise<T> {
    const k = `${String(userId)}:${channel}`;
    const prev = this.userProcessTail.get(k) ?? Promise.resolve();
    const run = prev.then(fn);
    this.userProcessTail.set(
      k,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async process(job: Job<SendJobData>) {
    this.inFlightProcessors += 1;
    const data = job.data;
    try {
      const laneChannel: "wa" | "tg" = data.channel === "tg" ? "tg" : "wa";
      return await this.runSerializedByUserChannel(String(data.userId), laneChannel, async () => {
    if (this.isShuttingDown) return;
    const supabase = this.supabaseService.getClient();

    const { data: dbJob, error: jobErr } = await supabase
      .from('campaign_jobs')
      .select(
        'id, user_id, group_jid, template_id, status, channel, campaign_id, scheduled_at, error, sent_at, created_at',
      )
      .eq('id', data.jobId)
      .maybeSingle();

    if (jobErr) {
      this.logger.warn(
        `[CampaignBullWorker] db fetch error for jobId=${data.jobId}: ${
          (jobErr as any)?.message ?? jobErr
        }`,
      );
      // Оставляем задачу для повторной попытки — это уже обрабатывается BullMQ.
      throw jobErr;
    }

    if (!dbJob) {
      // Ситуация: задача осталась в Redis, но строки в campaign_jobs уже нет (очистка / миграция).
      // Это «мертвая» задача: удаляем её из очереди и не считаем это ошибкой.
      this.logger.warn(
        `[CampaignBullWorker] stale queue job without DB row, removing jobId=${data.jobId}`,
      );
      try {
        await job.remove();
      } catch (e: any) {
        this.logger.warn(
          `[CampaignBullWorker] failed to remove stale jobId=${data.jobId}: ${
            e?.message ?? e
          }`,
        );
      }
      return;
    }

    if (dbJob.status !== 'pending') return;
    if ((dbJob as any).sent_at) return;

    const campaignId = (dbJob as any).campaign_id;
    const scheduledAtMs = new Date(
      String((dbJob as any).scheduled_at || ''),
    ).getTime();
    const useSendRhythm = !!(
      campaignId &&
      Number.isFinite(scheduledAtMs) &&
      scheduledAtMs > 0
    );
    if (campaignId) {
      const { data: camp } = await supabase
        .from('campaigns')
        .select('paused, status')
        .eq('id', campaignId)
        .maybeSingle();
      const campAny = camp as { paused?: boolean; status?: string } | null;
      if (campAny?.status === 'stopped') {
        await supabase
          .from('campaign_jobs')
          .update({
            status: 'skipped',
            error: 'campaign_stopped',
            sent_at: new Date().toISOString(),
          })
          .eq('id', dbJob.id);
        this.logger.log(
          `[CampaignBullWorker] job=${data.jobId} skipped: campaign stopped (campaignId=${campaignId})`,
        );
        return;
      }
      if (campAny?.paused === true) {
        await supabase
          .from('campaign_jobs')
          .update({ status: 'paused', error: 'campaign_paused' })
          .eq('id', dbJob.id);
        this.logger.log(
          `[CampaignBullWorker] job=${data.jobId} skipped: campaign paused (campaignId=${campaignId})`,
        );
        return;
      }
    }

    const { error: lockErr } = await supabase
      .from('campaign_jobs')
      .update({ status: 'processing', error: null })
      .eq('id', dbJob.id)
      .eq('status', 'pending');

    if (lockErr) return;

    // Повторная проверка после блокировки: пользователь мог нажать «Остановить» пока job ждал в очереди
    if (campaignId) {
      const { data: campAgain } = await supabase
        .from('campaigns')
        .select('status')
        .eq('id', campaignId)
        .maybeSingle();
      if ((campAgain as any)?.status === 'stopped') {
        await supabase
          .from('campaign_jobs')
          .update({
            status: 'skipped',
            error: 'campaign_stopped',
            sent_at: new Date().toISOString(),
          })
          .eq('id', dbJob.id);
        this.logger.log(
          `[CampaignBullWorker] job=${data.jobId} skipped after lock: campaign stopped (campaignId=${campaignId})`,
        );
        return;
      }
    }

    const tplRes = await supabase
      .from('message_templates')
      .select(
        'id, text, media_url, send_media_as_file, enabled',
      )
      .eq('id', data.templateId)
      .maybeSingle();

    let tpl = tplRes.data;
    if (tplRes.error) {
      const errMsg = String((tplRes.error as any)?.message ?? '').toLowerCase();
      if (
        errMsg.includes('send_media_as_file') ||
        (errMsg.includes('schema cache') &&
          errMsg.includes('message_templates'))
      ) {
        const fallback = await supabase
          .from('message_templates')
          .select('id, text, media_url, enabled')
          .eq('id', data.templateId)
          .maybeSingle();
        if (!fallback.error && fallback.data)
          tpl = {
            ...fallback.data,
            send_media_as_file: false,
          } as any;
        else
          tpl = fallback.data
            ? ({
                ...fallback.data,
                send_media_as_file: false,
              } as any)
            : null;
      }
    }
    if (!tpl) {
      await supabase
        .from('campaign_jobs')
        .update({
          status: 'failed',
          error: 'template_not_found',
          sent_at: new Date().toISOString(),
        })
        .eq('id', dbJob.id);
      if (campaignId) await this.stopCampaignIfDone(String(campaignId));
      return;
    }

    if (tpl.enabled === false) {
      await supabase
        .from('campaign_jobs')
        .update({
          status: 'skipped',
          error: 'template_disabled',
          sent_at: new Date().toISOString(),
        })
        .eq('id', dbJob.id);
      if (campaignId) await this.stopCampaignIfDone(String(campaignId));
      return;
    }

    const channel = String((dbJob as any).channel || 'wa') as 'wa' | 'tg';
    const pauseCampaignForConnectivity = async (reason: string) => {
      const campaignIdLocal = String((dbJob as any).campaign_id || '');
      if (campaignIdLocal) {
        await supabase
          .from('campaigns')
          .update({ paused: true })
          .eq('id', campaignIdLocal);

        await supabase
          .from('campaign_jobs')
          .update({
            status: 'paused',
            error: reason,
            sent_at: null,
          })
          .eq('campaign_id', campaignIdLocal)
          .in('status', ['pending', 'processing']);
      } else {
        await supabase
          .from('campaign_jobs')
          .update({
            status: 'paused',
            error: reason,
            sent_at: null,
          })
          .eq('id', dbJob.id);
      }
    };

    const rescheduleWaConnectivityRetry = async (
      reason: string,
      source: 'precheck' | 'send_error',
    ): Promise<boolean> => {
      if (channel !== 'wa') return false;
      const prevAttempt = this.parseWaConnectivityRetryAttempt(
        String((dbJob as any).error || ''),
      );
      const firstSeenMs = new Date(
        String((dbJob as any).created_at || ''),
      ).getTime();
      const retryWindowMs = this.waConnectivityRetryMaxWindowMs();
      if (Number.isFinite(firstSeenMs) && Date.now() - firstSeenMs > retryWindowMs) {
        await supabase
          .from('campaign_jobs')
          .update({
            status: 'failed',
            error: 'wa_connectivity_retry_exhausted',
            sent_at: new Date().toISOString(),
          })
          .eq('id', dbJob.id);
        if (campaignId) await this.stopCampaignIfDone(String(campaignId));
        this.logger.warn(
          `[CampaignBullWorker] job=${data.jobId} failed: WA connectivity retry window exhausted (windowMs=${retryWindowMs}, userId=${dbJob.user_id}, campaignId=${campaignId || 'n/a'})`,
        );
        return true;
      }
      // Не переводим кампанию в paused из-за кратких WA-разрывов:
      // после достижения MAX продолжаем мягкий retry с capped attempt.
      const nextAttempt = Math.min(
        CampaignBullWorker.WA_CONNECTIVITY_RETRY_MAX_ATTEMPTS,
        prevAttempt + 1,
      );
      const nowMs = Date.now();
      const delayMs = this.buildWaConnectivityRetryDelayMs(nextAttempt);
      const newIso = new Date(nowMs + delayMs).toISOString();
      const retryTag = `wa_connect_retry_${nextAttempt}`;

      await supabase
        .from('campaign_jobs')
        .update({
          status: 'pending',
          error: retryTag,
          sent_at: null,
          scheduled_at: newIso,
        })
        .eq('id', dbJob.id);

      await this.enqueueRetryJob(
        dbJob as any,
        'wa',
        delayMs,
        data.templateId,
      );

      await this.persistLimitLearningEvent({
        userId: dbJob.user_id,
        channel: 'wa',
        eventType: 'wa_connectivity_reschedule',
        seconds: Math.ceil(delayMs / 1000),
        campaignId: String((dbJob as any).campaign_id || '') || null,
        jobId: String(dbJob.id || '') || null,
        groupJid: String((dbJob as any).group_jid || '') || null,
        templateId: String((dbJob as any).template_id || '') || null,
        label: `${source}:${reason}`,
        error: reason,
      });

      this.logger.warn(
        `[CampaignBullWorker] job=${data.jobId} rescheduled: WA connectivity (${source}, attempt=${nextAttempt}/${CampaignBullWorker.WA_CONNECTIVITY_RETRY_MAX_ATTEMPTS}, nextIn=${Math.round(
          delayMs / 1000,
        )}s, userId=${dbJob.user_id}, campaignId=${campaignId || 'n/a'})`,
      );
      return true;
    };

    const rescheduleTgConnectivityRetry = async (
      reason: string,
      source: 'precheck' | 'send_error',
    ): Promise<boolean> => {
      if (channel !== 'tg') return false;
      const prevAttempt = this.parseTgConnectivityRetryAttempt(
        String((dbJob as any).error || ''),
      );
      const firstSeenMs = new Date(
        String((dbJob as any).created_at || ''),
      ).getTime();
      const retryWindowMs = this.tgConnectivityRetryMaxWindowMs();
      if (Number.isFinite(firstSeenMs) && Date.now() - firstSeenMs > retryWindowMs) {
        await supabase
          .from('campaign_jobs')
          .update({
            status: 'failed',
            error: 'tg_connectivity_retry_exhausted',
            sent_at: new Date().toISOString(),
          })
          .eq('id', dbJob.id);
        if (campaignId) await this.stopCampaignIfDone(String(campaignId));
        this.logger.warn(
          `[CampaignBullWorker] job=${data.jobId} failed: TG connectivity retry window exhausted (windowMs=${retryWindowMs}, userId=${dbJob.user_id}, campaignId=${campaignId || 'n/a'})`,
        );
        return true;
      }
      const nextAttempt = Math.min(
        CampaignBullWorker.TG_CONNECTIVITY_RETRY_MAX_ATTEMPTS,
        prevAttempt + 1,
      );

      const nowMs = Date.now();
      const delayMs = this.buildTgConnectivityRetryDelayMs(nextAttempt);
      const newIso = new Date(nowMs + delayMs).toISOString();
      const retryTag = `tg_connect_retry_${nextAttempt}`;

      await supabase
        .from('campaign_jobs')
        .update({
          status: 'pending',
          error: retryTag,
          sent_at: null,
          scheduled_at: newIso,
        })
        .eq('id', dbJob.id);

      await this.enqueueRetryJob(
        dbJob as any,
        'tg',
        delayMs,
        data.templateId,
      );

      await this.persistLimitLearningEvent({
        userId: dbJob.user_id,
        channel: 'tg',
        eventType: 'tg_connectivity_reschedule',
        seconds: Math.ceil(delayMs / 1000),
        campaignId: String((dbJob as any).campaign_id || '') || null,
        jobId: String(dbJob.id || '') || null,
        groupJid: String((dbJob as any).group_jid || '') || null,
        templateId: String((dbJob as any).template_id || '') || null,
        label: `${source}:${reason}`,
        error: reason,
      });

      this.logger.warn(
        `[CampaignBullWorker] job=${data.jobId} rescheduled: TG connectivity (${source}, attempt=${nextAttempt}/${CampaignBullWorker.TG_CONNECTIVITY_RETRY_MAX_ATTEMPTS}, nextIn=${Math.round(
          delayMs / 1000,
        )}s, userId=${dbJob.user_id}, campaignId=${campaignId || 'n/a'})`,
      );
      return true;
    };

    // Проверка подписки: не отправляем, если доступ истёк после постановки в очередь
    const access = await this.subscriptions.hasAccessForChannel(
      dbJob.user_id,
      channel,
    );
    if (!access.allowed) {
      const reason = access.reason || 'subscription_expired';
      const userId = String((dbJob as any).user_id ?? '');
      this.logger.warn(
        `[CampaignBullWorker] job=${data.jobId} skipped: ${reason} (userId=${userId}, channel=${channel})`,
      );
      // Подписка истекла — ставим на паузу все running-рассылки пользователя (и WA, и TG),
      // чтобы после оплаты их можно было автоматически возобновить через webhook.
      const { data: runningCampaigns, error: campErr } = await supabase
        .from('campaigns')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'running');

      if (!campErr && runningCampaigns?.length) {
        const campaignIds = (runningCampaigns as { id: string }[]).map(
          (c) => c.id,
        );
        await supabase
          .from('campaigns')
          .update({ paused: true })
          .in('id', campaignIds);

        await supabase
          .from('campaign_jobs')
          .update({ status: 'paused', error: reason, sent_at: null })
          .in('campaign_id', campaignIds)
          .in('status', ['pending', 'processing']);
      } else {
        const campaignId = (dbJob as any).campaign_id;
        if (campaignId) {
          await supabase
            .from('campaigns')
            .update({ paused: true })
            .eq('id', campaignId);
          await supabase
            .from('campaign_jobs')
            .update({ status: 'paused', error: reason, sent_at: null })
            .eq('campaign_id', campaignId)
            .in('status', ['pending', 'processing']);
        } else {
          await supabase
            .from('campaign_jobs')
            .update({ status: 'paused', error: reason, sent_at: null })
            .eq('id', dbJob.id);
        }
      }
      return;
    }

    const jid = String((dbJob as any).group_jid || '');

    if (channel === 'tg' && jid.includes('@g.us')) {
      await supabase
        .from('campaign_jobs')
        .update({
          status: 'failed',
          error: 'wrong_target_for_tg',
          sent_at: new Date().toISOString(),
        })
        .eq('id', dbJob.id);
      if (campaignId) await this.stopCampaignIfDone(String(campaignId));
      return;
    }

    if (channel === 'wa' && /^-?\d+$/.test(jid)) {
      await supabase
        .from('campaign_jobs')
        .update({
          status: 'failed',
          error: 'wrong_target_for_wa',
          sent_at: new Date().toISOString(),
        })
        .eq('id', dbJob.id);
      if (campaignId) await this.stopCampaignIfDone(String(campaignId));
      return;
    }

    // Перед отправкой всегда проверяем коннект канала.
    // Если канала нет — ставим кампанию на паузу и НЕ теряем pending jobs.
    if (channel === 'tg') {
      const tgStatus = await this.telegram.getStatus(dbJob.user_id);
      if (tgStatus?.status !== 'connected') {
        const rescheduled = await rescheduleTgConnectivityRetry(
          'telegram_not_connected',
          'precheck',
        );
        if (rescheduled) return;
      }
    } else {
      let waStatus = await this.whatsapp.getStatus(dbJob.user_id);
      if (waStatus.status !== 'connected') {
        try {
          await this.whatsapp.startSession(dbJob.user_id);
        } catch {
          // best-effort
        }
        waStatus = await this.whatsapp.getStatus(dbJob.user_id);
      }
      if (waStatus.status !== 'connected') {
        // Если WA требует явного переподключения через QR/ручного действия,
        // не выжигаем хвост pending в retry_exhausted — ставим кампанию на паузу.
        if (
          waStatus.status === 'pending_qr' ||
          waStatus.status === 'not_connected' ||
          waStatus.status === 'error'
        ) {
          await pauseCampaignForConnectivity('wa_not_connected');
          this.logger.warn(
            `[CampaignBullWorker] job=${data.jobId} paused: WA requires reconnect (status=${waStatus.status}, userId=${dbJob.user_id}, campaignId=${campaignId || 'n/a'})`,
          );
          return;
        }
        const rescheduled = await rescheduleWaConnectivityRetry(
          'wa_not_connected',
          'precheck',
        );
        if (rescheduled) return;
      }
    }

    if (useSendRhythm) {
      await this.enforceCampaignSendRhythm(
        String(campaignId),
        scheduledAtMs,
      );
    }

    try {
      this.logger.warn(
        `### ROUTE job=${dbJob.id} channel=${channel} group=${dbJob.group_jid} tpl=${data.templateId} ###`,
      );
      if (channel === 'tg') {
        // TG FloodWait может ждать до 60+ сек — увеличиваем таймаут
        await withTimeout(
          this.telegram.sendToGroup(dbJob.user_id, dbJob.group_jid, {
            text: this.normalizeTemplateText(tpl.text),
            mediaUrl: tpl.media_url ?? null,
            // В Telegram всегда отправляем медиа как медиа (фото/видео),
            // переключатель "Отправлять медиа как файл" относится только к WhatsApp.
            sendMediaAsFile: false,
          }),
          90_000,
          'send_timeout',
        );
      } else {
        // wa
        const hasWaMedia = !!String(tpl.media_url || '').trim();
        const waSendTimeoutMs = hasWaMedia ? 120_000 : 60_000;
        await withTimeout(
          this.whatsapp.sendToGroup(dbJob.user_id, dbJob.group_jid, {
            text: this.normalizeTemplateText(tpl.text),
            mediaUrl: tpl.media_url ?? null,
            sendMediaAsFile: !!tpl.send_media_as_file,
          }),
          waSendTimeoutMs,
          'send_timeout',
        );
      }

      await supabase
        .from('campaign_jobs')
        .update({
          status: 'sent',
          error: null,
          sent_at: new Date().toISOString(),
        })
        .eq('id', dbJob.id);
      if (channel === 'wa') {
        const uid = String((dbJob as any).user_id ?? '');
        const jid = String((dbJob as any).group_jid ?? '');
        if (uid && jid) {
          this.whatsapp.clearSendError(uid, jid).catch((err) =>
            this.logger.warn(
              `[CampaignBullWorker] clearSendError wa: ${err?.message ?? err}`,
            ),
          );
        }
      }
      if (campaignId) await this.stopCampaignIfDone(String(campaignId));
      if (channel === 'wa') {
        await this.releaseWaOwnershipIfUserIdle(String(dbJob.user_id));
      }
      if (useSendRhythm) {
        this.recordCampaignSendRhythm(String(campaignId), scheduledAtMs);
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);

      if (
        msg === 'whatsapp_session_busy' ||
        msg === 'whatsapp_not_connected' ||
        msg === 'telegram_session_busy' ||
        msg === 'telegram_not_connected' ||
        msg === 'send_timeout'
      ) {
        const reason =
          msg === 'telegram_not_connected' || msg === 'telegram_session_busy'
            ? 'telegram_not_connected'
            : msg === 'whatsapp_not_connected' || msg === 'whatsapp_session_busy'
              ? 'wa_not_connected'
              : channel === 'tg'
                ? 'telegram_not_connected'
                : 'wa_not_connected';
        if (reason === 'wa_not_connected' && channel === 'wa') {
          const rescheduled = await rescheduleWaConnectivityRetry(
            'wa_not_connected',
            'send_error',
          );
          if (rescheduled) return;
        }
        if (reason === 'telegram_not_connected' && channel === 'tg') {
          const rescheduled = await rescheduleTgConnectivityRetry(
            'telegram_not_connected',
            'send_error',
          );
          if (rescheduled) return;
        }
        await pauseCampaignForConnectivity(reason);
        if (channel === 'wa') {
          await this.releaseWaOwnershipIfUserIdle(String(dbJob.user_id));
        }
        this.logger.warn(
          `[CampaignBullWorker] job=${data.jobId} paused on connectivity error: ${msg} (mapped=${reason}, userId=${dbJob.user_id}, campaignId=${campaignId || 'n/a'})`,
        );
        return;
      }

      // WA media-host upload часто падает в моменты сетевой деградации (ETIMEDOUT/route down).
      // Это не "перманентная" ошибка шаблона: уводим в мягкий connectivity retry, как и wa_not_connected.
      if (
        channel === 'wa' &&
        /media upload failed on all hosts/i.test(String(msg || ''))
      ) {
        const rescheduled = await rescheduleWaConnectivityRetry(
          'wa_not_connected',
          'send_error',
        );
        if (rescheduled) return;
        await pauseCampaignForConnectivity('wa_not_connected');
        await this.releaseWaOwnershipIfUserIdle(String(dbJob.user_id));
        this.logger.warn(
          `[CampaignBullWorker] job=${data.jobId} paused on WA media-host upload failure: ${msg} (userId=${dbJob.user_id}, campaignId=${campaignId || 'n/a'})`,
        );
        return;
      }

      // Limit learning for Telegram flood wait.
      if (channel === 'tg') {
        const m = String(msg || '').match(
          /A wait of (\d+) seconds is required/i,
        );
        if (m) {
          const seconds = Number(m[1] || 0);
          if (Number.isFinite(seconds) && seconds > 0) {
            this.recordTgFloodWait({
              userId: dbJob.user_id,
              seconds,
              err: msg,
            });
            await this.persistLimitLearningEvent({
              userId: dbJob.user_id,
              channel: 'tg',
              eventType: 'tg_flood_wait',
              seconds,
              campaignId: String((dbJob as any).campaign_id || '') || null,
              jobId: String(dbJob.id || '') || null,
              groupJid: String((dbJob as any).group_jid || '') || null,
              templateId: String((dbJob as any).template_id || '') || null,
              label: null,
              error: msg,
            });

            const nowMs = Date.now();
            const delayMs = this.buildTgFloodDelayMs(dbJob.user_id, seconds);
            const newIso = new Date(nowMs + delayMs).toISOString();

            await supabase
              .from('campaign_jobs')
              .update({
                status: 'pending',
                error: `tg_flood_wait_${seconds}s`,
                sent_at: null,
                scheduled_at: newIso,
              })
              .eq('id', dbJob.id);

            await this.enqueueRetryJob(
              dbJob as any,
              'tg',
              delayMs,
              data.templateId,
            );

            await this.persistLimitLearningEvent({
              userId: dbJob.user_id,
              channel: 'tg',
              eventType: 'tg_flood_wait_reschedule',
              seconds: Math.ceil(delayMs / 1000),
              campaignId: String((dbJob as any).campaign_id || '') || null,
              jobId: String(dbJob.id || '') || null,
              groupJid: String((dbJob as any).group_jid || '') || null,
              templateId: String((dbJob as any).template_id || '') || null,
              label: 'adaptive_delay',
              error: msg,
            });

            this.logger.warn(
              `[CampaignBullWorker] job=${data.jobId} rescheduled: TG flood wait (userId=${dbJob.user_id}, wait=${seconds}s, nextIn=${Math.round(
                delayMs / 1000,
              )}s)`,
            );
            return;
          }
        }
      }

      // TG peer/media-level ошибки цели: чтобы не повторять фейл на каждой волне,
      // автоматически выключаем проблемную группу из выбранных для рассылок.
      const classified = classifyDeliveryError(channel, msg);
      if (channel === 'tg' && classified.shouldAutoUnselectTarget) {
        await this.maybeAutoUnselectTgGroup({
          userId: String(dbJob.user_id),
          tgChatId: String((dbJob as any).group_jid || ''),
          errorText: msg,
        });
      }

      await supabase
        .from('campaign_jobs')
        .update({
          // Мы НЕ используем auto-retry BullMQ (ошибку не пробрасываем).
          // Поэтому job должен финализироваться в БД как failed, иначе зависнет "в процессе" и заблокирует repeat.
          status: 'failed',
          error: msg,
          sent_at: new Date().toISOString(),
        })
        .eq('id', dbJob.id);
      if (campaignId) await this.stopCampaignIfDone(String(campaignId));
      if (channel === 'wa') {
        await this.releaseWaOwnershipIfUserIdle(String(dbJob.user_id));
      }
      if (useSendRhythm) {
        this.recordCampaignSendRhythm(String(campaignId), scheduledAtMs);
      }

      // Сохраняем ошибку в группу (TG/WA), чтобы показывать ограничения в списках выбора групп
      const uid = String((dbJob as any).user_id ?? '');
      const jid = String((dbJob as any).group_jid ?? '');
      if (uid && jid) {
        if (channel === 'tg') {
          this.telegram
            .persistSendError(uid, jid, msg)
            .catch((err) =>
              this.logger.warn(
                `[CampaignBullWorker] persistSendError tg: ${err?.message ?? err}`,
              ),
            );
        } else if (channel === 'wa') {
          this.whatsapp
            .persistSendError(uid, jid, msg)
            .catch((err) =>
              this.logger.warn(
                `[CampaignBullWorker] persistSendError wa: ${err?.message ?? err}`,
              ),
            );
        }
      }

      // Не пробрасываем ошибку — завершаем обработку job без retry в BullMQ.
      // Иначе одно и то же сообщение (особенно WA) крутится по кругу до исчерпания attempts.
      // Повторная отправка — через «Повторить рассылку» в ЛК.
    }
      });
    } finally {
      this.inFlightProcessors = Math.max(0, this.inFlightProcessors - 1);
    }
  }
}
