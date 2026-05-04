//backend/src/admin/admin.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { AdminPasswordGuard } from './admin-password.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { CampaignsService } from '../campaigns/campaigns.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard, AdminPasswordGuard)
export class AdminController {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly campaignsService: CampaignsService,
  ) {}

  @Get('users')
  async users() {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase
      .from('users')
      .select(
        'id,phone,full_name,gender,telegram,birthday,email,email_verified,is_blocked,is_admin,created_at,last_login,subscriptions(*)',
      )
      .order('created_at', { ascending: false })
      .limit(500);

    if (error)
      return { success: false, message: 'supabase_select_error', error };

    // ✅ приводим subscriptions (массив) -> subscription (объект)
    const users = (data ?? []).map((u: any) => ({
      ...u,
      subscription: Array.isArray(u.subscriptions)
        ? (u.subscriptions[0] ?? null)
        : (u.subscriptions ?? null),
      subscriptions: undefined,
    }));

    return { success: true, users };
  }

  @Post('users/:id/block')
  async block(@Param('id') userId: string, @Body() body: { blocked: boolean }) {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase
      .from('users')
      .update({ is_blocked: !!body?.blocked })
      .eq('id', userId)
      .select('id,is_blocked')
      .maybeSingle();

    if (error)
      return { success: false, message: 'supabase_update_error', error };
    if (!data) return { success: false, message: 'user_not_found' };

    return { success: true, user: data };
  }

  @Post('users/:id/grant-trial')
  async grantTrial(
    @Param('id') userId: string,
    @Body() body: { days: number },
  ) {
    const days = Math.max(1, Math.min(30, Number(body?.days || 3)));

    const supabase = this.supabaseService.getClient();

    // берём текущую подписку
    const { data: sub, error: subErr } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (subErr)
      return {
        success: false,
        message: 'supabase_select_error',
        error: subErr,
      };

    // если trial ещё действует — продлеваем от trial_ends_at, иначе от now
    const base = sub?.trial_ends_at ? new Date(sub.trial_ends_at) : new Date();
    const baseTime = Math.max(base.getTime(), Date.now());

    const ends = new Date(baseTime);
    ends.setDate(ends.getDate() + days);

    const nowIso = new Date().toISOString();

    const row = {
      user_id: userId,
      status: 'trial',
      plan_code: 'base',
      trial_started_at: sub?.trial_started_at || nowIso,
      trial_ends_at: ends.toISOString(),
      cancel_at_period_end: false,
      updated_at: nowIso,
    };

    const { data, error } = await supabase
      .from('subscriptions')
      .upsert(row, { onConflict: 'user_id' })
      .select()
      .single();

    if (error)
      return { success: false, message: 'supabase_upsert_error', error };

    return { success: true, subscription: data };
  }

  @Post('users/:id/grant-access')
  async grantAccess(
    @Param('id') userId: string,
    @Body() body: { days: number },
  ) {
    const days = Math.max(1, Math.min(365, Number(body?.days || 30)));

    const supabase = this.supabaseService.getClient();

    // берём текущую подписку
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    const base = sub?.current_period_end
      ? new Date(sub.current_period_end)
      : new Date();
    const baseTime = Math.max(base.getTime(), Date.now());

    const end = new Date(baseTime);
    end.setDate(end.getDate() + days);

    const nowIso = new Date().toISOString();

    const row = {
      user_id: userId,
      status: 'active',
      plan_code: 'base',
      current_period_start: nowIso,
      current_period_end: end.toISOString(),
      cancel_at_period_end: false,
      updated_at: nowIso,
    };

    const { data, error } = await supabase
      .from('subscriptions')
      .upsert(row, { onConflict: 'user_id' })
      .select()
      .single();

    if (error)
      return { success: false, message: 'supabase_upsert_error', error };
    return { success: true, subscription: data };
  }

  @Post('users/:id/reduce-trial')
  async reduceTrial(
    @Param('id') userId: string,
    @Body() body: { days: number },
  ) {
    const days = Math.max(1, Math.min(30, Number(body?.days || 1)));
    const supabase = this.supabaseService.getClient();

    const { data: sub, error: subErr } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (subErr)
      return {
        success: false,
        message: 'supabase_select_error',
        error: subErr,
      };
    if (!sub) return { success: false, message: 'subscription_not_found' };

    // если trial_ends_at пустой — нечего уменьшать
    if (!sub.trial_ends_at) return { success: false, message: 'trial_not_set' };

    const now = Date.now();
    const curEnd = new Date(sub.trial_ends_at).getTime();
    const newEndTime = curEnd - days * 86400000;

    // если ушли в прошлое — заканчиваем прямо сейчас
    const finalEnd = new Date(Math.max(newEndTime, now)).toISOString();
    const finalStatus = sub.status; // не меняем статус тут

    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from('subscriptions')
      .upsert(
        {
          user_id: userId,
          status: finalStatus,
          plan_code: sub.plan_code || 'base',
          trial_started_at: sub.trial_started_at,
          trial_ends_at: finalEnd,
          cancel_at_period_end: false,
          updated_at: nowIso,
        },
        { onConflict: 'user_id' },
      )
      .select()
      .single();

    if (error)
      return { success: false, message: 'supabase_upsert_error', error };
    return { success: true, subscription: data };
  }

  @Post('users/:id/reduce-access')
  async reduceAccess(
    @Param('id') userId: string,
    @Body() body: { days: number },
  ) {
    const days = Math.max(1, Math.min(365, Number(body?.days || 1)));
    const supabase = this.supabaseService.getClient();

    const { data: sub, error: subErr } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (subErr)
      return {
        success: false,
        message: 'supabase_select_error',
        error: subErr,
      };
    if (!sub) return { success: false, message: 'subscription_not_found' };

    if (!sub.current_period_end)
      return { success: false, message: 'paid_period_not_set' };

    const now = Date.now();
    const curEnd = new Date(sub.current_period_end).getTime();
    const newEndTime = curEnd - days * 86400000;

    const finalEnd = new Date(Math.max(newEndTime, now)).toISOString();
    const finalStatus = newEndTime <= now ? 'expired' : 'active';

    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from('subscriptions')
      .upsert(
        {
          user_id: userId,
          status: finalStatus,
          plan_code: sub.plan_code || 'base',
          current_period_start: sub.current_period_start || nowIso,
          current_period_end: finalEnd,
          cancel_at_period_end: false,
          updated_at: nowIso,
        },
        { onConflict: 'user_id' },
      )
      .select()
      .single();

    if (error)
      return { success: false, message: 'supabase_upsert_error', error };
    return { success: true, subscription: data };
  }

  @Get('campaigns/diagnostics')
  async campaignDiagnostics(@Query('limit') limitRaw?: string, @Query('userId') userId?: string) {
    const limit = Math.max(1, Math.min(100, Number(limitRaw || 40)));
    return this.campaignsService.getAdminCampaignDiagnostics({
      limit,
      userId: String(userId || '').trim() || undefined,
    });
  }
}
