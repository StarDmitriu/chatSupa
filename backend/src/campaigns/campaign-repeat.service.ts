// backend/src/campaigns/campaign-repeat.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CampaignsService } from './campaigns.service';
import { TelegramService } from '../telegram/telegram.service';
import { RuntimeCoordinationService } from '../runtime/runtime-coordination.service';
import {
  getRuntimeInstanceId,
  runtimeCapabilitiesLabel,
  runtimeHasCapability,
} from '../runtime/runtime-role';

@Injectable()
export class CampaignRepeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampaignRepeatService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly tgSyncLastRunByUser = new Map<string, number>();
  private campaignPausedColumnSupported = true;

  private readonly enabled =
    String(process.env.CAMPAIGN_REPEAT_ENABLED || '').toLowerCase() === 'true';

  private readonly intervalMs = Number(
    process.env.CAMPAIGN_REPEAT_TICK_MS || 10_000,
  );
  private readonly schedulerLeaseKey = String(
    process.env.CAMPAIGN_REPEAT_LEADER_KEY || 'runtime:scheduler:campaign-repeat',
  ).trim();
  private readonly schedulerLeaseTtlMs = Math.max(
    Number(process.env.CAMPAIGN_REPEAT_LEADER_TTL_MS || this.intervalMs * 4) ||
      this.intervalMs * 4,
    this.intervalMs * 2,
  );

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly campaignsService: CampaignsService,
    private readonly telegramService: TelegramService,
    private readonly runtimeCoordinationService: RuntimeCoordinationService,
  ) {}

  private tgSyncCronEnabled(): boolean {
    return String(process.env.TG_SYNC_CRON_ENABLED || 'true')
      .toLowerCase()
      .trim() !== 'false';
  }

  private tgSyncCronIntervalMs(): number {
    const raw = Number(
      (process.env.TG_SYNC_CRON_INTERVAL_MS || String(8 * 60 * 60 * 1000)).trim(),
    );
    if (!Number.isFinite(raw)) return 8 * 60 * 60 * 1000;
    return Math.max(30 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, Math.floor(raw)));
  }

  private tgSyncCronBatchSize(): number {
    const raw = Number((process.env.TG_SYNC_CRON_BATCH_SIZE || '3').trim());
    if (!Number.isFinite(raw)) return 3;
    return Math.max(1, Math.min(20, Math.floor(raw)));
  }

  private isMissingCampaignPausedColumnError(err: unknown): boolean {
    return String((err as any)?.message ?? err).includes('campaigns.paused');
  }

  private async runTgScheduledBatchSync(nowIso: string): Promise<void> {
    if (!this.tgSyncCronEnabled()) return;
    const nowMs = Date.now();
    const minIntervalMs = this.tgSyncCronIntervalMs();
    const supabase = this.supabaseService.getClient();
    let query = supabase
      .from('campaigns')
      .select('user_id')
      .eq('channel', 'tg')
      .eq('status', 'running')
      .limit(200);

    if (this.campaignPausedColumnSupported) {
      query = query.eq('paused', false);
    }

    let data: any[] | null = null;
    let error: any = null;
    const first = await query;
    data = first.data;
    error = first.error;
    if (error && this.isMissingCampaignPausedColumnError(error)) {
      this.campaignPausedColumnSupported = false;
      const fallback = await supabase
        .from('campaigns')
        .select('user_id')
        .eq('channel', 'tg')
        .eq('status', 'running')
        .limit(200);
      data = fallback.data;
      error = fallback.error;
    }
    if (error) return;
    const uniq = Array.from(
      new Set((data ?? []).map((r: any) => String((r as any).user_id || '')).filter(Boolean)),
    );
    const due = uniq.filter((userId) => {
      const last = this.tgSyncLastRunByUser.get(userId) ?? 0;
      return nowMs - last >= minIntervalMs;
    });
    const batch = due.slice(0, this.tgSyncCronBatchSize());
    for (const userId of batch) {
      const res = await this.telegramService.syncGroups(userId);
      this.tgSyncLastRunByUser.set(userId, nowMs);
      this.logger.log(
        `[CampaignRepeat] tg scheduled sync userId=${userId} success=${res?.success === true} at=${nowIso}`,
      );
    }
  }

  onModuleInit() {
    if (!runtimeHasCapability('scheduler')) {
      this.logger.log(
        `Campaign repeat watcher skipped for runtime=${runtimeCapabilitiesLabel()} instance=${getRuntimeInstanceId()}`,
      );
      return;
    }

    const overlapRaw = String(
      process.env.CAMPAIGN_REPEAT_ALLOW_OVERLAP || '',
    ).toLowerCase();
    const unsafeRaw = String(
      process.env.CAMPAIGN_REPEAT_OVERLAP_FORCE_UNSAFE || '',
    ).toLowerCase();
    if (overlapRaw === 'true' && unsafeRaw !== 'true') {
      this.logger.error(
        'Invariant guard active: CAMPAIGN_REPEAT_ALLOW_OVERLAP=true ignored unless CAMPAIGN_REPEAT_OVERLAP_FORCE_UNSAFE=true',
      );
    }

    if (!this.enabled) {
      this.logger.warn(
        'Campaign repeat watcher disabled (set CAMPAIGN_REPEAT_ENABLED=true to enable)',
      );
      return;
    }

    // каждые 10 сек (или из env)
    this.timer = setInterval(
      () => this.tick().catch(() => undefined),
      this.intervalMs,
    );
    this.logger.log(`Campaign repeat watcher started (${this.intervalMs}ms)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.runtimeCoordinationService
      .releaseLease(this.schedulerLeaseKey)
      .catch(() => undefined);
  }

  private async tick() {
    const isLeader = await this.runtimeCoordinationService.acquireOrRenewLease(
      this.schedulerLeaseKey,
      this.schedulerLeaseTtlMs,
    );
    if (!isLeader) return;

    const supabase = this.supabaseService.getClient();
    const nowIso = new Date().toISOString();
    await this.campaignsService.detectAndApplyIncidentMode().catch(() => undefined);
    const healMode = this.campaignsService.getEffectiveHealMode();

    try {
      await this.runTgScheduledBatchSync(nowIso);
    } catch {
      // best-effort
    }

    // 1) Восстанавливаем paused-jobs после реконнекта WA/TG (best-effort).
    // Делается в каждом тике, чтобы рестарты/краткие reconnection'ы не ломали рассылки.
    try {
      await this.campaignsService.autoResumeDisconnectedJobs();
    } catch {
      // best-effort
    }

    // 1.1) Авто-heal перегруженных running кампаний (best-effort):
    // при high/critical и наличии failed/pending выполняем безопасный быстрый requeue.
    if (healMode === 'normal') {
      try {
        await this.campaignsService.autoHealOverloadedCampaigns();
      } catch {
        // best-effort
      }
    }

    // 1.2) Safety-net: requeue осиротевших pending (есть в БД, нет в BullMQ).
    try {
      await this.campaignsService.autoRequeueOrphanPendingJobs({
        maxJobs: 120,
        stepDelayMs: 220,
      });
    } catch {
      // best-effort
    }

    // 1.3) Мягко восстанавливаем недавние transient failed после реконнектов/рестартов.
    if (healMode === 'normal') {
      try {
        await this.campaignsService.autoRecoverTransientFailedJobs({
          maxJobs: 120,
          stepDelayMs: 300,
          windowHours: 24,
        });
      } catch {
        // best-effort
      }
    }

    // 1.4) WA exhausted-recovery только через stable-connect gate.
    if (healMode === 'normal') {
      try {
        await this.campaignsService.autoRecoverWaConnectivityExhaustedJobs({
          maxJobs: 100,
          stepDelayMs: 500,
          windowHours: 72,
        });
      } catch {
        // best-effort
      }
    }

    // ВАЖНО: берём только те, у которых next_repeat_at НЕ null и уже <= now
    let query = supabase
      .from('campaigns')
      .select('id')
      .eq('repeat_enabled', true)
      .eq('status', 'running')
      .not('next_repeat_at', 'is', null)
      .lte('next_repeat_at', nowIso)
      .limit(20);

    if (this.campaignPausedColumnSupported) {
      query = query.eq('paused', false);
    }

    let camps: any[] | null = null;
    let error: any = null;
    const first = await query;
    camps = first.data;
    error = first.error;
    if (error && this.isMissingCampaignPausedColumnError(error)) {
      this.campaignPausedColumnSupported = false;
      const fallback = await supabase
        .from('campaigns')
        .select('id')
        .eq('repeat_enabled', true)
        .eq('status', 'running')
        .not('next_repeat_at', 'is', null)
        .lte('next_repeat_at', nowIso)
        .limit(20);
      camps = fallback.data;
      error = fallback.error;
    }

    if (error) {
      const msg = error.message || String(error);

      // Если Supabase ограничил проект по egress (exceed_egress_quota),
      // не продолжаем долбиться в API каждые N секунд — останавливаем вотчер до рестарта.
      if (msg.includes('exceed_egress_quota')) {
        this.logger.warn(
          `repeat select error (egress quota): ${msg} — disabling CampaignRepeatService until restart`,
        );
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        return;
      }

      this.logger.warn(`repeat select error: ${msg}`);
      return;
    }

    if ((camps ?? []).length > 0) {
      this.logger.log(
        `repeat tick now=${nowIso} due=${(camps ?? []).length} healMode=${healMode}`,
      );
    }

    for (const c of camps ?? []) {
      await this.campaignsService.repeatWaveIfReady((c as any).id);
    }
  }
}
