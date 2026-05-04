import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Logger,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { ProdamusService } from './prodamus.service';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import {
  PLAN_BY_SUBSCRIPTION_ID,
  PRODAMUS_SUBSCRIPTION_IDS,
} from './prodamus.constants';
import { normalizePhoneE164 } from '../utils/phone.util';
import { CampaignsService } from '../campaigns/campaigns.service';

@Controller('payments/prodamus')
export class ProdamusController {
  private readonly logger = new Logger(ProdamusController.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prodamus: ProdamusService,
    private readonly campaignsService: CampaignsService,
  ) {}

  // POST /api/payments/prodamus/create
  @Post('create')
  @UseGuards(JwtAuthGuard)
  async create(@Req() req: any, @Body() body: any) {
    const userId = req?.user?.userId;
    if (!userId) throw new ForbiddenException('no_user');

    if (!this.prodamus.isConfigReady()) {
      this.logger.warn('[Prodamus create] Prodamus env not configured');
      return {
        success: false,
        message: 'payment_config_error',
        error: 'Платёжная система не настроена на сервере',
      };
    }

    try {
      const supabase = this.supabaseService.getClient();

      const { data: user, error: uErr } = await supabase
        .from('users')
        .select('id,phone,email')
        .eq('id', userId)
        .maybeSingle();

      if (uErr) {
        this.logger.warn(`[Prodamus create] users error: ${uErr.message}`);
        return {
          success: false,
          message: 'supabase_users_error',
          error: uErr.message,
        };
      }
      if (!user) {
        return { success: false, message: 'user_not_found' };
      }

      const planCode = String(body?.plan_code || 'wa_tg').trim();
      const plans: Record<string, { price: number; productName: string }> = {
        wa: { price: 2000, productName: 'Подписка WhatsApp (30 дней)' },
        tg: { price: 1000, productName: 'Подписка Telegram (30 дней)' },
        wa_tg: {
          price: 2500,
          productName: 'Подписка WhatsApp + Telegram (30 дней)',
        },
      };

      const plan = plans[planCode];
      if (!plan) {
        return { success: false, message: 'invalid_plan_code' };
      }

      const amountRub = plan.price;

      const { data: payment, error: pErr } = await supabase
        .from('payments')
        .insert({
          user_id: userId,
          provider: 'prodamus',
          amount_rub: amountRub,
          status: 'created',
          order_id: null,
        })
        .select()
        .single();

      if (pErr || !payment) {
        this.logger.warn(
          `[Prodamus create] payments insert error: ${pErr?.message}`,
        );
        return {
          success: false,
          message: 'supabase_payments_insert_error',
          error: pErr?.message,
        };
      }

      const internalOrderId = `${String(payment.id)}|${planCode}`;

      await supabase
        .from('payments')
        .update({ order_id: internalOrderId })
        .eq('id', payment.id);

      const payformUrl = this.prodamus.buildPaymentLink({
        orderId: internalOrderId,
        customerPhone:
          (user.phone && normalizePhoneE164(user.phone)) ||
          user.phone ||
          undefined,
        customerEmail: user.email || undefined,
        customerExtra: `user_id=${userId};payment_id=${payment.id};plan_code=${planCode}`,
        subscriptionId: PRODAMUS_SUBSCRIPTION_IDS[planCode],
        productName: plan.productName,
        productPrice: amountRub,
        quantity: 1,
      });
      const paymentUrl = await this.prodamus.resolvePaymentLink(payformUrl);

      return {
        success: true,
        payment_url: paymentUrl,
      };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const stack = err?.stack;
      this.logger.error(`[Prodamus create] ${msg}${stack ? `\n${stack}` : ''}`);
      return {
        success: false,
        message: 'payment_provider_error',
        error: msg,
      };
    }
  }

  // POST /api/payments/prodamus/webhook
  @Post('webhook')
  @UseInterceptors(AnyFilesInterceptor())
  async webhook(
    @Req() req: any,
    @Headers('sign') signLower?: string,
    @Headers('Sign') signUpper?: string,
    @Body() body?: any,
  ) {
    const signature = (signLower || signUpper || '').trim();

    const rawBody = (req?.body ?? body ?? {}) as Record<string, any>;
    const expanded = this.prodamus.expandBracketKeys(rawBody);

    const dataToVerify = expanded?.submit ? expanded.submit : expanded;
    const ok = this.prodamus.verify(dataToVerify, signature);

    if (!ok) {
      throw new ForbiddenException('invalid_signature');
    }
    // В проде нельзя логировать подпись/секреты. Логируем только безопасные агрегаты.
    this.logger.log(
      `[Prodamus webhook] order_num=${String(expanded?.order_num ?? expanded?.submit?.order_num ?? '')} order_id=${String(expanded?.order_id ?? expanded?.submit?.order_id ?? '')} payment_status=${String(expanded?.payment_status ?? expanded?.submit?.payment_status ?? '')}`,
    );

    try {
      return await this.handleWebhookBody(
        expanded,
        this.supabaseService.getClient(),
      );
    } catch (e: any) {
      this.logger.error(
        `[Prodamus webhook] processing error: ${e?.message ?? e}`,
        e?.stack,
      );
      return { success: false, error: 'webhook_processing_error' };
    }
  }

  private async handleWebhookBody(
    expanded: Record<string, any>,
    supabase: any,
  ) {
    const parseCustomerExtra = (value: string) => {
      const result: Record<string, string> = {};
      if (!value) return result;
      value
        .split(/[;&]/)
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((part) => {
          const [rawKey, rawValue] = part.split('=');
          if (!rawKey) return;
          const key = decodeURIComponent(rawKey.trim());
          const val = decodeURIComponent((rawValue ?? '').trim());
          result[key] = val;
        });
      return result;
    };

    const customerExtraRaw = String(
      expanded?.customer_extra || expanded?.submit?.customer_extra || '',
    ).trim();
    const customerExtra = parseCustomerExtra(customerExtraRaw);

    const subscriptionInfo =
      expanded?.subscription || expanded?.submit?.subscription || null;

    const parseProdamusDate = (value: string) => {
      if (!value) return null;
      const trimmed = String(value).trim();
      if (!trimmed) return null;
      if (trimmed.includes('T')) {
        const d = new Date(trimmed);
        return isNaN(d.getTime()) ? null : d;
      }
      const normalized = trimmed.replace(' ', 'T');
      const withSeconds = /\d{2}:\d{2}:\d{2}/.test(normalized)
        ? normalized
        : `${normalized}:00`;
      const d = new Date(withSeconds);
      return isNaN(d.getTime()) ? null : d;
    };

    const orderNum = String(
      expanded?.order_num || expanded?.submit?.order_num || '',
    ).trim();
    const prodamusOrderId = String(
      expanded?.order_id || expanded?.submit?.order_id || '',
    ).trim();

    const planCodeFromOrder = orderNum.includes('|')
      ? orderNum.split('|')[1]
      : null;
    const allowedPlans = new Set(['wa', 'tg', 'wa_tg']);
    const planCodeCandidate =
      planCodeFromOrder ||
      customerExtra.plan_code ||
      PLAN_BY_SUBSCRIPTION_ID[String(subscriptionInfo?.id || '')] ||
      '';
    const planCode = allowedPlans.has(String(planCodeCandidate))
      ? String(planCodeCandidate)
      : 'wa_tg';

    const paymentStatus = String(expanded?.payment_status || '').trim();

    let paymentRow: any = null;

    if (orderNum) {
      const { data, error } = await supabase
        .from('payments')
        .select('*')
        .eq('order_id', orderNum)
        .maybeSingle();
      if (!error) paymentRow = data;
    }

    if (!paymentRow && customerExtra.payment_id) {
      const { data } = await supabase
        .from('payments')
        .select('*')
        .eq('id', customerExtra.payment_id)
        .maybeSingle();
      paymentRow = data;
    }

    if (!paymentRow && orderNum) {
      const { data } = await supabase
        .from('payments')
        .select('*')
        .eq('id', orderNum)
        .maybeSingle();
      paymentRow = data;
    }

    if (!paymentRow && customerExtra.user_id) {
      paymentRow = { id: null, user_id: customerExtra.user_id };
    }

    if (!paymentRow) {
      return { success: true, ignored: true, reason: 'payment_not_found' };
    }

    if (paymentRow?.status === 'paid') {
      return { success: true, already_processed: true };
    }

    const isSuccess = paymentStatus === 'success';
    const newPaymentStatus = isSuccess ? 'paid' : 'failed';

    if (paymentRow?.id) {
      await supabase
        .from('payments')
        .update({
          provider_payment_id:
            prodamusOrderId || paymentRow.provider_payment_id,
          status: newPaymentStatus,
          paid_at: isSuccess ? new Date().toISOString() : null,
          raw: expanded,
        })
        .eq('id', paymentRow.id);
    }

    if (!isSuccess) {
      return { success: true };
    }

    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('plan_code')
      .eq('user_id', paymentRow.user_id)
      .maybeSingle();

    const normalizePlan = (value: any) =>
      String(value || '')
        .toLowerCase()
        .trim();
    const existingPlan = normalizePlan(existingSub?.plan_code);
    const incomingPlan = normalizePlan(planCode);
    const mergedPlan =
      existingPlan === 'wa_tg' || incomingPlan === 'wa_tg'
        ? 'wa_tg'
        : existingPlan && incomingPlan && existingPlan !== incomingPlan
          ? 'wa_tg'
          : incomingPlan || existingPlan || 'wa_tg';

    const nowMs = Date.now();
    let baseEndMs = nowMs;

    if (
      paymentRow.current_period_end &&
      new Date(paymentRow.current_period_end).getTime() > nowMs
    ) {
      baseEndMs = new Date(paymentRow.current_period_end).getTime();
    }

    const startIso = new Date(baseEndMs).toISOString();

    const nextPaymentDate = subscriptionInfo?.date_next_payment
      ? parseProdamusDate(String(subscriptionInfo.date_next_payment))
      : null;

    const endIso = nextPaymentDate
      ? nextPaymentDate.toISOString()
      : new Date(baseEndMs + 30 * 24 * 60 * 60 * 1000).toISOString();

    await supabase.from('subscriptions').upsert(
      {
        user_id: paymentRow.user_id,
        status: 'active',
        plan_code: mergedPlan,
        provider: 'prodamus',
        current_period_start: startIso,
        current_period_end: endIso,
        cancel_at_period_end: false,
        updated_at: startIso,
      },
      { onConflict: 'user_id' },
    );

    // Важно: сначала обновлена подписка выше, затем снимаем паузу. setPause(..., false) внутри
    // проверяет hasAccessForChannel — без актуальной подписки в БД снятие паузы вернёт ошибку.
    // После оплаты снимаем паузу с рассылок (WA и TG) и переставляем в очередь job'ы со статусом paused.
    try {
      const [wa, tg] = await Promise.all([
        this.campaignsService.setPause(paymentRow.user_id, 'wa', false),
        this.campaignsService.setPause(paymentRow.user_id, 'tg', false),
      ]);
      const enq = (wa?.enqueued ?? 0) + (tg?.enqueued ?? 0);
      if (enq > 0) {
        this.logger.log(
          `[Prodamus webhook] auto-resume campaigns for user=${paymentRow.user_id}, enqueued=${enq}`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `[Prodamus webhook] auto-resume campaigns failed for user=${paymentRow.user_id}: ${(e as Error)?.message}`,
      );
    }

    // --- referral reward: add days to referrer when referred user pays ---
    try {
      const { data: referral } = await supabase
        .from('referrals')
        .select('id, referrer_user_id, status, reward_type, reward_value')
        .eq('referred_user_id', paymentRow.user_id)
        .maybeSingle();

      const isRegistered =
        String(referral?.status || '').trim() === 'registered';
      const rewardDays =
        String(referral?.reward_type || '').trim() === 'days'
          ? Number(referral?.reward_value || 0)
          : 0;

      if (referral?.referrer_user_id && isRegistered && rewardDays > 0) {
        const { data: refSub } = await supabase
          .from('subscriptions')
          .select('*')
          .eq('user_id', referral.referrer_user_id)
          .maybeSingle();

        const nowMs = Date.now();
        const currentEndMs = refSub?.current_period_end
          ? new Date(refSub.current_period_end).getTime()
          : 0;
        const baseEndMs = currentEndMs > nowMs ? currentEndMs : nowMs;
        const newEndIso = new Date(
          baseEndMs + rewardDays * 24 * 60 * 60 * 1000,
        ).toISOString();

        if (refSub) {
          await supabase
            .from('subscriptions')
            .update({
              status: 'active',
              current_period_end: newEndIso,
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', referral.referrer_user_id);
        } else {
          await supabase.from('subscriptions').insert({
            user_id: referral.referrer_user_id,
            status: 'active',
            plan_code: 'wa_tg',
            provider: 'referral',
            current_period_start: new Date().toISOString(),
            current_period_end: newEndIso,
            cancel_at_period_end: false,
            updated_at: new Date().toISOString(),
          });
        }

        await supabase
          .from('referrals')
          .update({ status: 'rewarded' })
          .eq('id', referral.id);
      }
    } catch (e) {
      console.warn('referral reward skipped due to error:', e);
    }

    return { success: true };
  }
}
