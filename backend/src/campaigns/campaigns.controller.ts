//backend/src/campaigns/campaigns.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StartCampaignDto } from './dto/start-campaign.dto';
import { SetPauseDto } from './dto/set-pause.dto';
import { SubscriptionGuard } from '../subscriptions/subscription.guard';

function toBool(v: any) {
  return v === true || v === 'true' || v === 1 || v === '1';
}
function toNum(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function normChannel(v: any): 'wa' | 'tg' {
  return String(v || 'wa').toLowerCase() === 'tg' ? 'tg' : 'wa';
}
function normalizeRequeueStatuses(v: any) {
  const allowed = new Set<
    'pending' | 'processing' | 'failed' | 'skipped' | 'sent' | 'paused'
  >(['pending', 'processing', 'failed', 'skipped', 'sent', 'paused']);
  if (!Array.isArray(v)) return undefined;
  const list = v.reduce<
    Array<'pending' | 'processing' | 'failed' | 'skipped' | 'sent' | 'paused'>
  >((acc, item) => {
    const x = String(item || '').trim().toLowerCase();
    if (allowed.has(x as any)) {
      acc.push(
        x as 'pending' | 'processing' | 'failed' | 'skipped' | 'sent' | 'paused',
      );
    }
    return acc;
  }, []);
  return list.length ? list : undefined;
}

@Controller('campaigns')
@UseGuards(JwtAuthGuard)
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  // ✅ Active по конкретному каналу
  @Get('active/:channel')
  async activeByChannel(@Req() req: any, @Param('channel') channel: string) {
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };
    return this.campaigns.getActiveCampaign(userId, normChannel(channel));
  }

  // ✅ Active сразу для двух каналов (удобно для фронта)
  @Get('active')
  async activeAll(@Req() req: any) {
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };

    const wa = await this.campaigns.getActiveCampaign(userId, 'wa');
    const tg = await this.campaigns.getActiveCampaign(userId, 'tg');

    if (!wa.success) return wa;
    if (!tg.success) return tg;

    return { success: true, wa: wa.active, tg: tg.active };
  }

  /** Список рассылок пользователя (история). */
  @Get('list')
  async list(@Req() req: any) {
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };
    return this.campaigns.getCampaignsList(userId);
  }

  /** Статус паузы рассылок по каналу (для кнопки Пауза/Play в ЛК). */
  @Get('pause-state/:channel')
  async pauseState(@Req() req: any, @Param('channel') channel: string) {
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };
    return this.campaigns.getPauseState(userId, normChannel(channel));
  }

  /** Включить или выключить паузу всех рассылок по каналу. */
  @Post('set-pause')
  async setPause(@Req() req: any, @Body() body: SetPauseDto) {
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };
    const paused = toBool(body?.paused);
    return this.campaigns.setPause(userId, normChannel(body?.channel), paused);
  }

  @Post('start-multi')
  @UseGuards(JwtAuthGuard, SubscriptionGuard)
  async startMulti(@Req() req: any, @Body() body: StartCampaignDto) {
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };

    const channel = normChannel(body?.channel);
    const scaleTemplate = toBool(body?.betweenGroupsScaleTemplate ?? true);

    const repOn = toBool(body?.repeatEnabled);
    const kind = String(body?.repeatScheduleKind || '')
      .toLowerCase()
      .trim();
    let repeatScheduleKind: 'minutes' | 'next_day' | 'clock_time' | undefined =
      kind === 'next_day' || kind === 'clock_time' || kind === 'minutes'
        ? (kind as 'minutes' | 'next_day' | 'clock_time')
        : undefined;
    if (repOn && !repeatScheduleKind) {
      repeatScheduleKind = 'next_day';
    }

    return this.campaigns.startMulti(userId, {
      timeFrom: body?.timeFrom,
      timeTo: body?.timeTo,
      betweenGroupsSecMin: toNum(body?.betweenGroupsSecMin),
      betweenGroupsSecMax: toNum(body?.betweenGroupsSecMax),
      betweenGroupsScaleWithTemplateSpeed: scaleTemplate,
      betweenTemplatesMinMin: toNum(body?.betweenTemplatesMinMin),
      betweenTemplatesMinMax: toNum(body?.betweenTemplatesMinMax),

      repeatEnabled: repOn,
      repeatMinMin: toNum(body?.repeatMinMin),
      repeatMinMax: toNum(body?.repeatMinMax),
      repeatScheduleKind,
      repeatClockTime:
        typeof body?.repeatClockTime === 'string'
          ? body.repeatClockTime
          : undefined,

      channel,
    });
  }

  @Get('preflight/tg')
  async tgPreflight(@Req() req: any, @Query('threshold') threshold?: string) {
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };
    const n = Number(threshold);
    return this.campaigns.tgPreflight(userId, Number.isFinite(n) ? n : 0.15);
  }

  @Get(':campaignId/progress')
  async progress(@Req() req: any, @Param('campaignId') campaignId: string) {
    if (!campaignId)
      return { success: false, message: 'campaignId is required' };
    const userId = req?.user?.userId;
    return this.campaigns.getProgress(campaignId, userId);
  }

  @Get(':campaignId/recent-outcomes')
  async recentOutcomes(
    @Req() req: any,
    @Param('campaignId') campaignId: string,
    @Query('windowMin') windowMin?: string,
  ) {
    if (!campaignId)
      return { success: false, message: 'campaignId is required' };
    const userId = req?.user?.userId;
    return this.campaigns.getRecentOutcomes(campaignId, userId, toNum(windowMin) ?? 5);
  }

  @Get(':campaignId/jobs')
  async jobs(@Req() req: any, @Param('campaignId') campaignId: string) {
    if (!campaignId)
      return { success: false, message: 'campaignId is required' };
    const userId = req?.user?.userId;
    return this.campaigns.getJobs(campaignId, userId);
  }

  @Post('group-delivery-summary')
  async groupDeliverySummary(@Req() req: any, @Body() body: any) {
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };
    const channel = normChannel(body?.channel);
    const groupJids = Array.isArray(body?.groupJids) ? body.groupJids : [];
    const lookbackDays = toNum(body?.lookbackDays);
    const includeTemplatesIncluded = toBool(body?.includeTemplatesIncluded);
    return this.campaigns.getGroupDeliverySummary(userId, {
      channel,
      groupJids,
      lookbackDays:
        typeof lookbackDays === 'number' && lookbackDays > 0
          ? lookbackDays
          : undefined,
      includeTemplatesIncluded,
    });
  }

  @Post(':campaignId/requeue')
  @UseGuards(JwtAuthGuard, SubscriptionGuard)
  async requeue(
    @Req() req: any,
    @Param('campaignId') campaignId: string,
    @Body() body: any,
  ) {
    if (!campaignId)
      return { success: false, message: 'campaignId is required' };
    const userId = req?.user?.userId;
    return this.campaigns.requeueCampaign(campaignId, userId, {
      includeSent: toBool(body?.includeSent),
      forceNow: toBool(body?.forceNow),
      statuses: normalizeRequeueStatuses(body?.statuses),
    });
  }

  /** Пересчитать время pending job'ов по текущим паузам из шаблонов (без остановки кампании). */
  @Post(':campaignId/resync-schedule-from-templates')
  @UseGuards(JwtAuthGuard, SubscriptionGuard)
  async resyncScheduleFromTemplates(
    @Req() req: any,
    @Param('campaignId') campaignId: string,
  ) {
    if (!campaignId)
      return { success: false, message: 'campaignId is required' };
    const userId = req?.user?.userId;
    if (!userId) return { success: false, message: 'userId is required' };
    return this.campaigns.resyncPendingJobsScheduleFromTemplates(
      campaignId,
      userId,
    );
  }

  @Post(':campaignId/stop')
  async stop(@Req() req: any, @Param('campaignId') campaignId: string) {
    if (!campaignId)
      return { success: false, message: 'campaignId is required' };
    const userId = req?.user?.userId;
    return this.campaigns.stopCampaign(campaignId, userId);
  }
}
