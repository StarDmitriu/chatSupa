import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

@Injectable()
export class AdminPasswordGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const required = String(process.env.ADMIN_PANEL_PASSWORD || '').trim();

    // Пароль админки опциональный: если переменная не задана — пропускаем.
    if (!required) return true;

    const req = context.switchToHttp().getRequest();
    const provided = String(
      req?.headers?.['x-admin-password'] ??
        req?.headers?.['X-Admin-Password'] ??
        '',
    ).trim();

    if (!provided) throw new ForbiddenException('admin_password_required');

    // constant-time compare
    if (!safeEqual(provided, required))
      throw new ForbiddenException('admin_password_invalid');

    return true;
  }
}
