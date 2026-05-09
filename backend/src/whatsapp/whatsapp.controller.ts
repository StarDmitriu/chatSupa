// backend/src/whatsapp/whatsapp.controller.ts
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { WhatsappService, SessionInfo } from './whatsapp.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('whatsapp')
@UseGuards(JwtAuthGuard)
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  private authUserId(req: { user?: { userId?: string } }): string {
    const id = req?.user?.userId;
    if (!id) throw new ForbiddenException('no_user');
    return id;
  }

  private ensureUserParam(
    req: { user?: { userId?: string } },
    paramUserId: string,
  ): string {
    const id = this.authUserId(req);
    if (paramUserId !== id) throw new ForbiddenException('user_id_mismatch');
    return id;
  }

  private extractClientIp(req: any): string | null {
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '').trim();
    const first = forwarded ? forwarded.split(',')[0]?.trim() : '';
    const direct = String(req?.socket?.remoteAddress || '').trim();
    const ip = first || direct;
    return ip ? ip.slice(0, 200) : null;
  }

  @Post('start')
  async start(
    @Req() req: any,
  ): Promise<
    { success: false; message: string } | { success: true; status: SessionInfo }
  > {
    const userId = this.authUserId(req);
    const status = await this.whatsapp.startSession(userId, { force: true });
    return { success: true, status };
  }

  @Get('proxy-settings')
  async getProxySettings(@Req() req: any) {
    const userId = this.authUserId(req);
    return await this.whatsapp.getUserProxySettings(userId);
  }

  @Post('proxy-settings')
  async setProxySettings(
    @Req() req: any,
    @Body()
    body: {
      enabled?: boolean;
      proxyUrl?: string | null;
      failOpenDirect?: boolean;
      maxConsecutiveFailures?: number;
    },
  ) {
    const userId = this.authUserId(req);
    return await this.whatsapp.setUserProxySettings(userId, body || {});
  }

  @Get('status/:userId')
  async status(
    @Req() req: any,
    @Param('userId') paramUserId: string,
  ): Promise<
    { success: false; message: string } | { success: true; status: SessionInfo }
  > {
    const userId = this.ensureUserParam(req, paramUserId);
    const status = await this.whatsapp.getStatus(userId);
    return { success: true, status };
  }

  @Get('network-incident')
  async networkIncident(@Req() req: any) {
    this.authUserId(req);
    return this.whatsapp.getNetworkIncidentSummary();
  }

  @Get('account-info/:userId')
  async getAccountInfo(@Req() req: any, @Param('userId') paramUserId: string) {
    const userId = this.ensureUserParam(req, paramUserId);
    return this.whatsapp.getAccountInfo(userId);
  }

  @Post('sync-groups')
  async syncGroups(@Req() req: any) {
    const userId = this.authUserId(req);
    return await this.whatsapp.syncGroups(userId);
  }

  @Get('groups/:userId')
  async getGroups(
    @Req() req: any,
    @Param('userId') paramUserId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('selectedOnly') selectedOnly?: string,
    @Query('waPhone') waPhone?: string,
  ) {
    const userId = this.ensureUserParam(req, paramUserId);
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    const offsetNum = offset ? parseInt(offset, 10) : undefined;
    const selectedOnlyBool = selectedOnly === 'true' || selectedOnly === '1';
    const waPhoneVal = waPhone && waPhone.trim() ? waPhone.trim() : undefined;
    return await this.whatsapp.getGroupsFromDb(
      userId,
      limitNum,
      offsetNum,
      selectedOnlyBool,
      waPhoneVal,
    );
  }

  @Get('groups/:userId/phones')
  async getGroupsPhones(@Req() req: any, @Param('userId') paramUserId: string) {
    const userId = this.ensureUserParam(req, paramUserId);
    return await this.whatsapp.getGroupsPhones(userId);
  }

  @Get('groups/:userId/count')
  async getGroupsCount(@Req() req: any, @Param('userId') paramUserId: string) {
    const userId = this.ensureUserParam(req, paramUserId);
    return await this.whatsapp.getSelectedGroupsCount(userId);
  }

  @Get('group-avatar/:userId')
  async getGroupAvatar(
    @Req() req: any,
    @Param('userId') paramUserId: string,
    @Query('wa_group_id') waGroupId?: string,
  ) {
    const userId = this.ensureUserParam(req, paramUserId);
    const jid = String(waGroupId || '').trim();
    if (!jid) return { success: false, message: 'wa_group_id is required' };
    return await this.whatsapp.getGroupAvatarUrl(userId, jid);
  }

  @Get('group-avatar-content/:userId')
  async getGroupAvatarContent(
    @Req() req: any,
    @Param('userId') paramUserId: string,
    @Query('wa_group_id') waGroupId: string,
    @Res() res: any,
  ) {
    const userId = this.ensureUserParam(req, paramUserId);
    const jid = String(waGroupId || '').trim();
    if (!jid) {
      return res
        .status(400)
        .json({ success: false, message: 'wa_group_id is required' });
    }

    const avatar = await this.whatsapp.getGroupAvatarContent(userId, jid);
    if (!avatar.success || !avatar.data) {
      // Не спамим 404 в браузерной консоли на <img>.
      // Если аватар недоступен (часто из-за истёкшей временной ссылки или ограничений),
      // отдаём плейсхолдер из фронта.
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.redirect(302, '/logo-heart.png');
    }

    res.setHeader('Content-Type', avatar.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(avatar.data);
  }

  @Get('account-avatar/:userId')
  async getAccountAvatar(
    @Req() req: any,
    @Param('userId') paramUserId: string,
  ) {
    const userId = this.ensureUserParam(req, paramUserId);
    return await this.whatsapp.getAccountAvatarUrl(userId);
  }

  /**
   * Аватар подключённого аккаунта: при ошибке — 404, без редиректа на бренд-логотип
   * (в отличие от group-avatar-content для списков групп).
   */
  @Get('account-avatar-content/:userId')
  async getAccountAvatarContent(
    @Req() req: any,
    @Param('userId') paramUserId: string,
    @Res() res: any,
  ) {
    const userId = this.ensureUserParam(req, paramUserId);
    const avatar = await this.whatsapp.getAccountAvatarContent(userId);
    if (!avatar.success || !avatar.data) {
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.status(404).end();
    }
    res.setHeader('Content-Type', avatar.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(avatar.data);
  }

  @Post('groups/select')
  async setSelected(
    @Req() req: any,
    @Body()
    body: { wa_group_id?: string; is_selected?: boolean | string | number },
  ) {
    const userId = this.authUserId(req);
    const waGroupId = body?.wa_group_id;
    const isSelected =
      body?.is_selected === true ||
      body?.is_selected === 'true' ||
      body?.is_selected === 1 ||
      body?.is_selected === '1';

    if (!waGroupId)
      return { success: false, message: 'wa_group_id is required' };

    return await this.whatsapp.setGroupSelected({
      userId,
      waGroupId,
      isSelected,
    });
  }

  @Post('groups/select-batch')
  async setSelectedBatch(
    @Req() req: any,
    @Body()
    body: { wa_group_ids?: string[]; is_selected?: boolean | string | number },
  ) {
    const userId = this.authUserId(req);
    const waGroupIds = body?.wa_group_ids;
    const isSelected =
      body?.is_selected === true ||
      body?.is_selected === 'true' ||
      body?.is_selected === 1 ||
      body?.is_selected === '1';

    if (!waGroupIds || !Array.isArray(waGroupIds) || waGroupIds.length === 0) {
      return { success: false, message: 'wa_group_ids array is required' };
    }

    return await this.whatsapp.setGroupsSelectedBatch({
      userId,
      waGroupIds,
      isSelected,
    });
  }

  @Post('groups/time')
  async setSendTime(
    @Req() req: any,
    @Body() body: { wa_group_id?: string; send_time?: string | null },
  ) {
    const userId = this.authUserId(req);
    const waGroupId = body?.wa_group_id;
    const sendTime =
      body?.send_time === '' || body?.send_time == null
        ? null
        : String(body?.send_time);

    if (!waGroupId)
      return { success: false, message: 'wa_group_id is required' };

    return await this.whatsapp.setGroupSendTime({
      userId,
      waGroupId,
      sendTime,
    });
  }

  @Post('disconnect')
  async disconnect(
    @Req() req: any,
    @Body() body?: { source?: string | null },
  ) {
    const userId = this.authUserId(req);
    const requesterId = this.authUserId(req);
    const sourceRaw = String(body?.source ?? '').trim();
    const source = sourceRaw ? sourceRaw.slice(0, 120) : 'unknown';
    const userAgent = String(req?.headers?.['user-agent'] || '')
      .trim()
      .slice(0, 400);
    const ip = this.extractClientIp(req);
    return this.whatsapp.disconnect(userId, {
      requesterId,
      source,
      ip,
      userAgent: userAgent || null,
    });
  }

  @Post('reset')
  async reset(@Req() req: any) {
    const userId = this.authUserId(req);
    this.whatsapp.resetSession(userId);
    return { success: true };
  }
}
