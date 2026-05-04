//backend/src/telegram/telegram.controller.ts
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramQrService } from './telegram.qr';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('telegram')
@UseGuards(JwtAuthGuard)
export class TelegramController {
  constructor(
    private readonly telegram: TelegramService,
    private readonly telegramQr: TelegramQrService,
  ) {}

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

  @Post('qr/start')
  async startQr(@Req() req: any) {
    const userId = this.authUserId(req);
    return this.telegramQr.start(userId);
  }

  @Get('qr/status/:userId')
  async qrStatus(@Req() req: any, @Param('userId') paramUserId: string) {
    const userId = this.ensureUserParam(req, paramUserId);
    return this.telegramQr.status(userId);
  }

  @Post('qr/confirm-password')
  async qrConfirmPassword(
    @Req() req: any,
    @Body() body: { password?: string },
  ) {
    const userId = this.authUserId(req);
    const password = body?.password;
    if (!password) return { success: false, message: 'password is required' };
    return this.telegramQr.confirmPassword(userId, password);
  }

  @Post('qr/disconnect')
  async qrDisconnect(@Req() req: any) {
    const userId = this.authUserId(req);
    return this.telegramQr.disconnect(userId);
  }

  @Post('qr/abort')
  async qrAbort(@Req() req: any) {
    const userId = this.authUserId(req);
    return this.telegramQr.abort(userId);
  }

  @Get('status/:userId')
  async status(@Req() req: any, @Param('userId') paramUserId: string) {
    const userId = this.ensureUserParam(req, paramUserId);
    return this.telegram.getStatus(userId);
  }

  @Get('premium-status/:userId')
  async getPremiumStatus(
    @Req() req: any,
    @Param('userId') paramUserId: string,
  ) {
    const userId = this.ensureUserParam(req, paramUserId);
    return this.telegram.getPremiumStatus(userId);
  }

  @Get('account-info/:userId')
  async getAccountInfo(@Req() req: any, @Param('userId') paramUserId: string) {
    const userId = this.ensureUserParam(req, paramUserId);
    return this.telegram.getAccountInfo(userId);
  }

  @Get('account-avatar/:userId')
  async getAccountAvatar(
    @Req() req: any,
    @Param('userId') paramUserId: string,
  ) {
    const userId = this.ensureUserParam(req, paramUserId);
    return this.telegram.getAccountAvatarUrl(userId);
  }

  @Post('start')
  async start(@Req() req: any) {
    const userId = this.authUserId(req);
    return this.telegram.startAuth(userId);
  }

  @Post('confirm-code')
  async confirmCode(@Req() req: any, @Body() body: { code?: string }) {
    const userId = this.authUserId(req);
    const code = body?.code;
    if (!code) return { success: false, message: 'code is required' };
    return this.telegram.confirmCode(userId, code);
  }

  @Post('confirm-password')
  async confirmPassword(@Req() req: any, @Body() body: { password?: string }) {
    const userId = this.authUserId(req);
    const password = body?.password;
    if (!password) return { success: false, message: 'password is required' };
    return this.telegram.confirmPassword(userId, password);
  }

  @Post('disconnect')
  async disconnect(@Req() req: any) {
    const userId = this.authUserId(req);
    return this.telegram.disconnect(userId);
  }

  @Post('sync-groups')
  async syncGroups(@Req() req: any) {
    const userId = this.authUserId(req);
    return this.telegram.syncGroups(userId);
  }

  @Get('groups/:userId/phones')
  async getGroupsPhones(@Req() req: any, @Param('userId') paramUserId: string) {
    const userId = this.ensureUserParam(req, paramUserId);
    const phones = await this.telegram.getGroupsPhones(userId);
    return { success: true, phones };
  }

  @Get('groups/:userId')
  async getGroups(
    @Req() req: any,
    @Param('userId') paramUserId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('selectedOnly') selectedOnly?: string,
    @Query('tgPhone') tgPhone?: string,
    @Query('cursorUpdatedAt') cursorUpdatedAt?: string,
    @Query('cursorTgChatId') cursorTgChatId?: string,
    @Query('template') template?: string,
  ) {
    const userId = this.ensureUserParam(req, paramUserId);
    const templateList = template === 'true' || template === '1';
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    const offsetNum = offset ? parseInt(offset, 10) : undefined;
    const selectedOnlyBool = selectedOnly === 'true' || selectedOnly === '1';
    const cursor =
      !templateList &&
      cursorUpdatedAt &&
      cursorTgChatId != null &&
      String(cursorTgChatId).trim() !== ''
        ? {
            updatedAt: String(cursorUpdatedAt).trim(),
            chatId: String(cursorTgChatId).trim(),
          }
        : undefined;
    return this.telegram.getGroupsFromDb(
      userId,
      templateList ? undefined : limitNum,
      templateList ? undefined : offsetNum,
      selectedOnlyBool,
      tgPhone ?? undefined,
      cursor,
      templateList,
    );
  }

  @Get('groups/:userId/count')
  async getGroupsCount(@Req() req: any, @Param('userId') paramUserId: string) {
    const userId = this.ensureUserParam(req, paramUserId);
    return this.telegram.getSelectedGroupsCount(userId);
  }

  @Post('groups/select')
  async setSelected(
    @Req() req: any,
    @Body()
    body: { tg_chat_id?: string; is_selected?: boolean | string | number },
  ) {
    const userId = this.authUserId(req);
    const tgChatId = String(body?.tg_chat_id || '').trim();
    const isSelected =
      body?.is_selected === true ||
      body?.is_selected === 'true' ||
      body?.is_selected === 1 ||
      body?.is_selected === '1';

    if (!tgChatId) return { success: false, message: 'tg_chat_id is required' };

    return this.telegram.setGroupSelected({ userId, tgChatId, isSelected });
  }

  @Post('groups/select-all')
  async setSelectedAll(
    @Req() req: any,
    @Body() body: { is_selected?: boolean | string | number },
  ) {
    const userId = this.authUserId(req);
    const isSelected =
      body?.is_selected === true ||
      body?.is_selected === 'true' ||
      body?.is_selected === 1 ||
      body?.is_selected === '1';

    return this.telegram.setAllGroupsSelected({ userId, isSelected });
  }

  @Post('groups/time')
  async setSendTime(
    @Req() req: any,
    @Body() body: { tg_chat_id?: string; send_time?: string | null },
  ) {
    const userId = this.authUserId(req);
    const tgChatId = String(body?.tg_chat_id || '').trim();
    const sendTime =
      body?.send_time === '' || body?.send_time == null
        ? null
        : String(body?.send_time);

    if (!tgChatId) return { success: false, message: 'tg_chat_id is required' };

    return this.telegram.setGroupSendTime({ userId, tgChatId, sendTime });
  }

  /** Ручная тестовая отправка в выбранный TG-чат (тот же путь, что рассылка). */
  @Post('send-test')
  async sendTest(
    @Req() req: any,
    @Body() body: { tg_chat_id?: string; text?: string },
  ) {
    const userId = this.authUserId(req);
    const tgChatId = String(body?.tg_chat_id || '').trim();
    const text =
      String(body?.text || '').trim() ||
      `Тест ${new Date().toISOString()} — проверка доставки из ЛК`;
    if (!tgChatId) return { success: false, message: 'tg_chat_id is required' };
    try {
      await this.telegram.sendToGroup(userId, tgChatId, { text });
      return { success: true };
    } catch (e: any) {
      return {
        success: false,
        message: e?.message || String(e),
      };
    }
  }
}
