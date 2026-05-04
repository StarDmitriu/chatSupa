import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * VIP для приоритета job в BullMQ: меньшее число priority = раньше в очереди.
 * Источники (объединяются): CAMPAIGN_VIP_USER_IDS и users.campaign_send_vip = true.
 */
@Injectable()
export class CampaignVipService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampaignVipService.name);
  /** Текущее объединённое множество id (снимок после последнего refresh). */
  private vipUserIds = new Set<string>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastRefreshAt: string | null = null;
  private lastDbError: string | null = null;
  private campaignVipColumnSupported = true;

  constructor(private readonly supabaseService: SupabaseService) {
    this.vipUserIds = this.parseEnvVipIds();
  }

  onModuleInit() {
    void this.refreshMergedVipSet().catch((e) =>
      this.logger.warn(
        `[CampaignVip] initial refresh failed: ${(e as Error)?.message ?? e}`,
      ),
    );
    const ms = this.refreshIntervalMs();
    this.interval = setInterval(() => {
      void this.refreshMergedVipSet().catch((e) =>
        this.logger.warn(
          `[CampaignVip] refresh failed: ${(e as Error)?.message ?? e}`,
        ),
      );
    }, ms);
  }

  onModuleDestroy() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Синхронно: актуально после первого refresh (env уже в конструкторе). */
  getEnqueuePriority(userId: string): number {
    const id = String(userId || '').trim();
    if (!id) return this.priorityNormal();
    return this.vipUserIds.has(id) ? this.priorityVip() : this.priorityNormal();
  }

  /** Для метрик / отладки (без перечисления id). */
  getVipStats(): {
    mergedCount: number;
    lastRefreshAt: string | null;
    lastDbError: string | null;
    dbSyncEnabled: boolean;
  } {
    return {
      mergedCount: this.vipUserIds.size,
      lastRefreshAt: this.lastRefreshAt,
      lastDbError: this.lastDbError,
      dbSyncEnabled: this.dbSyncEnabled(),
    };
  }

  private refreshIntervalMs(): number {
    const raw = (process.env.CAMPAIGN_VIP_REFRESH_INTERVAL_MS || '').trim();
    const n = raw ? Number(raw) : 60_000;
    if (!Number.isFinite(n)) return 60_000;
    return Math.max(5_000, Math.min(3_600_000, Math.floor(n)));
  }

  private dbSyncEnabled(): boolean {
    const v = (process.env.CAMPAIGN_VIP_DB_SYNC || 'true').trim().toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'no';
  }

  private priorityVip(): number {
    const raw = (process.env.CAMPAIGN_VIP_JOB_PRIORITY || '0').trim();
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.floor(n), this.priorityNormal() - 1);
  }

  private priorityNormal(): number {
    const raw = (process.env.CAMPAIGN_NORMAL_JOB_PRIORITY || '100000').trim();
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return 100_000;
    return Math.floor(n);
  }

  private parseEnvVipIds(): Set<string> {
    const raw = (process.env.CAMPAIGN_VIP_USER_IDS || '').trim();
    return new Set(
      raw
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  private async refreshMergedVipSet(): Promise<void> {
    const fromEnv = this.parseEnvVipIds();
    const merged = new Set(fromEnv);

    this.lastDbError = null;

    if (this.dbSyncEnabled() && this.campaignVipColumnSupported) {
      try {
        const { data, error } = await this.supabaseService
          .getClient()
          .from('users')
          .select('id')
          .eq('campaign_send_vip', true);

        if (error) {
          this.lastDbError = error.message || String(error);
          if ((this.lastDbError || '').includes('campaign_send_vip')) {
            this.campaignVipColumnSupported = false;
            this.logger.warn(
              '[CampaignVip] users.campaign_send_vip is missing; DB VIP sync disabled for current schema',
            );
          } else {
            this.logger.warn(`[CampaignVip] DB select failed: ${this.lastDbError}`);
          }
        } else {
          for (const row of data || []) {
            const id = String((row as { id?: string }).id || '').trim();
            if (id) merged.add(id);
          }
        }
      } catch (e: any) {
        this.lastDbError = e?.message ?? String(e);
        if ((this.lastDbError || '').includes('campaign_send_vip')) {
          this.campaignVipColumnSupported = false;
          this.logger.warn(
            '[CampaignVip] users.campaign_send_vip is missing; DB VIP sync disabled for current schema',
          );
        } else {
          this.logger.warn(`[CampaignVip] DB sync exception: ${this.lastDbError}`);
        }
      }
    }

    this.vipUserIds = merged;
    this.lastRefreshAt = new Date().toISOString();
  }
}
