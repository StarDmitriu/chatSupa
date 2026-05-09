import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import IORedis, { RedisOptions } from 'ioredis';
import { getRuntimeInstanceId } from './runtime-role';

export type MessengerChannel = 'wa' | 'tg';

function buildRedisOptions(): RedisOptions {
  const redisUrl = (process.env.REDIS_URL || '').trim();
  const common: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  if (redisUrl) {
    const url = new URL(redisUrl);
    const isTls = url.protocol === 'rediss:';
    const dbFromPath = (url.pathname || '').replace('/', '');
    const db = dbFromPath ? Number(dbFromPath) : undefined;

    return {
      ...common,
      host: url.hostname,
      port: url.port ? Number(url.port) : isTls ? 6380 : 6379,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: Number.isFinite(db as any) ? db : undefined,
      tls: isTls ? {} : undefined,
    };
  }

  return {
    ...common,
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT || 6379),
    password: (process.env.REDIS_PASSWORD || '').trim() || undefined,
    db: process.env.REDIS_DB ? Number(process.env.REDIS_DB) : undefined,
  };
}

@Injectable()
export class RuntimeCoordinationService implements OnModuleDestroy {
  private readonly logger = new Logger(RuntimeCoordinationService.name);
  private readonly redis = new IORedis(buildRedisOptions());
  private readonly instanceId = getRuntimeInstanceId();

  constructor() {
    this.redis.on('error', (err) => {
      this.logger.warn(`Redis coordination error: ${(err as any)?.message ?? err}`);
    });
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  private messengerLeaseKey(channel: MessengerChannel, userId: string): string {
    return `runtime:session-lease:${channel}:${userId}`;
  }

  private messengerStateKey(channel: MessengerChannel, userId: string): string {
    return `runtime:session-state:${channel}:${userId}`;
  }

  async acquireOrRenewLease(key: string, ttlMs: number): Promise<boolean> {
    const ttl = Math.max(5_000, Math.floor(ttlMs));
    const acquired = await this.redis.set(key, this.instanceId, 'PX', ttl, 'NX');
    if (acquired === 'OK') return true;

    const renewed = await this.redis.eval(
      `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('pexpire', KEYS[1], ARGV[2])
        end
        return 0
      `,
      1,
      key,
      this.instanceId,
      String(ttl),
    );

    return Number(renewed) === 1;
  }

  async releaseLease(key: string): Promise<void> {
    await this.redis.eval(
      `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        end
        return 0
      `,
      1,
      key,
      this.instanceId,
    );
  }

  async acquireMessengerLease(params: {
    channel: MessengerChannel;
    userId: string;
    ttlMs: number;
  }): Promise<{ acquired: boolean; ownerInstanceId: string | null }> {
    const key = this.messengerLeaseKey(params.channel, params.userId);
    const acquired = await this.acquireOrRenewLease(key, params.ttlMs);
    if (acquired) {
      return { acquired: true, ownerInstanceId: this.instanceId };
    }
    const ownerInstanceId = await this.redis.get(key);
    return { acquired: false, ownerInstanceId };
  }

  async releaseMessengerLease(
    channel: MessengerChannel,
    userId: string,
  ): Promise<void> {
    await this.releaseLease(this.messengerLeaseKey(channel, userId));
  }

  async getMessengerLeaseOwner(
    channel: MessengerChannel,
    userId: string,
  ): Promise<string | null> {
    return this.redis.get(this.messengerLeaseKey(channel, userId));
  }

  async writeMessengerState(
    channel: MessengerChannel,
    userId: string,
    state: Record<string, any>,
    ttlSec = 24 * 60 * 60,
  ): Promise<void> {
    const key = this.messengerStateKey(channel, userId);
    const payload = JSON.stringify({
      ...state,
      runtimeInstanceId: this.instanceId,
      updatedAt: new Date().toISOString(),
    });
    await this.redis.set(key, payload, 'EX', Math.max(60, Math.floor(ttlSec)));
  }

  async readMessengerState<T = Record<string, any>>(
    channel: MessengerChannel,
    userId: string,
  ): Promise<T | null> {
    const raw = await this.redis.get(this.messengerStateKey(channel, userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async clearMessengerState(
    channel: MessengerChannel,
    userId: string,
  ): Promise<void> {
    await this.redis.del(this.messengerStateKey(channel, userId));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
