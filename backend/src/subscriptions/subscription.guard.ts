import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private readonly subs: SubscriptionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId = req?.user?.userId;

    if (!userId) {
      throw new ForbiddenException('no_user');
    }

    const channelRaw = req?.body?.channel;
    const channelNorm = String(channelRaw || '').toLowerCase();
    const channel =
      channelNorm === 'tg' ? 'tg' : channelNorm === 'wa' ? 'wa' : null;

    const check = channel
      ? await this.subs.hasAccessForChannel(userId, channel)
      : await this.subs.hasAccess(userId);
    if (check.allowed) return true;

    // ✅ фронту будет понятно, что случилось
    throw new ForbiddenException(check.reason || 'no_access');
  }
}
