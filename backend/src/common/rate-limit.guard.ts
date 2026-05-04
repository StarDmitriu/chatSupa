import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';

const WINDOW_MS = 60_000; // 1 минута

interface Slot {
  count: number;
  resetAt: number;
}

const store = new Map<string, Slot>();

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim().slice(0, 64) || 'unknown';
  }
  return (req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

/**
 * Guard: лимит запросов по IP за минуту.
 * Использовать на публичных эндпоинтах (leads, log-client-error).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly maxPerMinute: number) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = getClientIp(req);
    const now = Date.now();

    let slot = store.get(ip);
    if (!slot || now >= slot.resetAt) {
      slot = { count: 0, resetAt: now + WINDOW_MS };
      store.set(ip, slot);
    }

    slot.count += 1;

    if (slot.count > this.maxPerMinute) {
      throw new HttpException(
        { statusCode: 429, message: 'too_many_requests' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}

/** 60 запросов/мин — для POST /leads */
@Injectable()
export class RateLimitLeadsGuard extends RateLimitGuard {
  constructor() {
    super(60);
  }
}

/** 30 запросов/мин — для POST /log-client-error */
@Injectable()
export class RateLimitLogGuard extends RateLimitGuard {
  constructor() {
    super(30);
  }
}
