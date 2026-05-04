import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProdamusService } from '../payments/prodamus.service';
import { PRODAMUS_SUBSCRIPTION_IDS } from '../payments/prodamus.constants';
import { SubscriptionsService } from './subscriptions.service';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';

@Controller('subscriptions')
@UseGuards(JwtAuthGuard)
export class SubscriptionsController {
  constructor(
    private readonly subs: SubscriptionsService,
    private readonly prodamus: ProdamusService,
  ) {}

  @Get('me')
  async me(@Req() req: any) {
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };
    return this.subs.getMySubscription(userId);
  }

  @Post('start-trial')
  async startTrial(@Req() req: any) {
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };
    return this.subs.startTrial(userId, 3);
  }

  @Post('cancel')
  async cancelAutoRenew(@Req() req: any, @Body() dto: CancelSubscriptionDto) {
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };
    const cancel = dto?.cancel === true;

    const { user, sub } = await this.subs.getUserAndSub(userId);
    if (!user) return { success: false, message: 'user_not_found' };
    if (!sub) return { success: false, message: 'subscription_not_found' };

    // Нормализуем план и берём ID подписки в Prodamus (если он вообще есть).
    const planCode = String(sub.plan_code || 'wa_tg')
      .toLowerCase()
      .trim();
    const subscriptionId = PRODAMUS_SUBSCRIPTION_IDS[planCode];

    // Если подписка не провайдер Prodamus или для неё нет subscriptionId
    // (например, бесплатный/вручную выданный доступ с plan_code='base'),
    // просто обновляем флаг cancel_at_period_end в нашей БД без обращения к Prodamus.
    if (
      !subscriptionId ||
      String(sub.provider || '')
        .toLowerCase()
        .trim() !== 'prodamus'
    ) {
      return this.subs.setCancelAtPeriodEnd(userId, cancel);
    }

    const customerEmail = user.email || undefined;
    const customerPhone = user.phone || undefined;
    if (!customerEmail && !customerPhone) {
      return { success: false, message: 'customer_contact_missing' };
    }

    const res = await this.prodamus.setSubscriptionActivity({
      subscriptionId,
      customerEmail,
      customerPhone,
      activeUser: cancel ? false : undefined,
      activeManager: cancel ? undefined : true,
    });

    if (!res.ok) {
      return {
        success: false,
        message: 'prodamus_set_activity_failed',
        status: res.status,
        body: res.body,
      };
    }

    return this.subs.setCancelAtPeriodEnd(userId, cancel);
  }
}
