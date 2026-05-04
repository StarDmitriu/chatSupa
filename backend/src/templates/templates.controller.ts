//backend/src/templates/templates.controller.ts
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { TemplatesService } from './templates.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { DeleteTemplateDto } from './dto/delete-template.dto';

@Controller('templates')
@UseGuards(JwtAuthGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

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
    // Источник истины — userId из JWT.
    // Параметр :userId оставляем для обратной совместимости URL, но не используем
    // как авторизационный фактор (избегаем ложных 403 при рассинхроне клиентского состояния).
    return id;
  }

  @Post('sync')
  async sync(@Req() req: any) {
    const userId = this.authUserId(req);
    return this.templates.syncFromSheet(userId);
  }

  @Post('check-sheet')
  async checkSheet(@Req() req: any) {
    const userId = this.authUserId(req);
    return this.templates.checkSheetConnection(userId);
  }

  /** Скачать бэкап шаблонов (CSV со всеми колонками снимка) */
  @Get('export')
  async exportBackup(@Req() req: any, @Res() res: Response) {
    const userId = this.authUserId(req);
    const result = await this.templates.exportBackup(userId);
    if (!result.success) {
      return res.status(400).json(result);
    }
    const filename = `templates-backup-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const csv = (result as { csv: string }).csv;
    const bom = '\uFEFF';
    return res.send(bom + csv);
  }

  /** Восстановить шаблоны из CSV (файл или тело запроса) */
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async importBackup(
    @Req() req: any,
    @Body() body: { csv?: string },
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const userId = this.authUserId(req);
    let csvText = body?.csv?.trim();
    if (!csvText && file?.buffer) {
      csvText = file.buffer.toString('utf-8');
    }
    if (!csvText) {
      return {
        success: false,
        message: 'Нужен файл CSV или поле csv в теле запроса',
      };
    }
    return this.templates.importFromCsv(userId, csvText);
  }

  @Get('list/:userId')
  async list(@Req() req: any, @Param('userId') paramUserId: string) {
    const userId = this.ensureUserParam(req, paramUserId);
    return this.templates.listTemplates(userId);
  }

  @Post('create')
  async create(@Req() req: any, @Body() body: CreateTemplateDto) {
    const userId = this.authUserId(req);
    return this.templates.createManual(userId, {
      title: body?.title,
      text: body?.text,
      media_url: body?.media_url,
      send_media_as_file: body?.send_media_as_file,
      enabled: body?.enabled,
      order: body?.order,
      wa_speed_factor: body?.wa_speed_factor,
      tg_speed_factor: body?.tg_speed_factor,
      wa_between_groups_sec_min: body?.wa_between_groups_sec_min,
      wa_between_groups_sec_max: body?.wa_between_groups_sec_max,
      tg_between_groups_sec_min: body?.tg_between_groups_sec_min,
      tg_between_groups_sec_max: body?.tg_between_groups_sec_max,
      wa_default_send_time: body?.wa_default_send_time,
      tg_default_send_time: body?.tg_default_send_time,
    });
  }

  @Post('upload-media')
  @UseInterceptors(FileInterceptor('file'))
  async uploadMedia(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const userId = this.authUserId(req);
    if (!file) return { success: false, message: 'file is required' };
    return this.templates.uploadMedia(userId, file);
  }

  @Post('update')
  async update(@Req() req: any, @Body() body: UpdateTemplateDto) {
    const userId = this.authUserId(req);
    return this.templates.update(userId, body.templateId, {
      title: body?.title,
      text: body?.text,
      media_url: body?.media_url,
      send_media_as_file: body?.send_media_as_file,
      enabled: body?.enabled,
      order: body?.order,
      wa_speed_factor: body?.wa_speed_factor,
      tg_speed_factor: body?.tg_speed_factor,
      wa_between_groups_sec_min: body?.wa_between_groups_sec_min,
      wa_between_groups_sec_max: body?.wa_between_groups_sec_max,
      tg_between_groups_sec_min: body?.tg_between_groups_sec_min,
      tg_between_groups_sec_max: body?.tg_between_groups_sec_max,
      wa_default_send_time: body?.wa_default_send_time,
      tg_default_send_time: body?.tg_default_send_time,
    });
  }

  @Get('get/:templateId')
  async get(@Req() req: any, @Param('templateId') templateId: string) {
    if (!templateId)
      return { success: false, message: 'templateId is required' };
    const result = await this.templates.getById(templateId);
    if (!result?.success || !(result as any).template) return result;
    const userId = this.authUserId(req);
    if ((result as any).template.user_id !== userId) {
      throw new ForbiddenException('template_owner_mismatch');
    }
    return result;
  }

  @Post('delete')
  async del(@Req() req: any, @Body() body: DeleteTemplateDto) {
    const userId = this.authUserId(req);
    return this.templates.remove(userId, body.templateId);
  }

  @Get('targets/:userId/:templateId/:channel')
  async getTargetsByChannel(
    @Req() req: any,
    @Param('userId') paramUserId: string,
    @Param('templateId') templateId: string,
    @Param('channel') channel: string,
  ) {
    const userId = this.ensureUserParam(req, paramUserId);
    if (!templateId)
      return { success: false, message: 'templateId is required' };
    return this.templates.getTargets(userId, templateId, channel);
  }

  @Post('targets/set')
  async setTargets(@Req() req: any, @Body() body: Record<string, unknown>) {
    const userId = this.authUserId(req);
    const templateId = body?.templateId as string | undefined;
    const groupJids = body?.groupJids as string[] | undefined;
    const channel = body?.channel as string | undefined;

    if (!templateId)
      return { success: false, message: 'templateId is required' };
    if (!Array.isArray(groupJids))
      return { success: false, message: 'groupJids must be array' };

    return this.templates.setTargets(
      userId,
      templateId,
      groupJids,
      channel,
      body?.overrides as Record<string, string> | undefined,
    );
  }

  /**
   * Метрики для правой панели “Планирование — сводка”:
   * как targets/overrides покрывают выбранные группы (и сколько шаблонов реально влияет).
   */
  @Get('targets/summary/:userId/:channel')
  async getTargetsSummary(
    @Req() req: any,
    @Param('userId') paramUserId: string,
    @Param('channel') channel: string,
  ) {
    const userId = this.ensureUserParam(req, paramUserId);
    if (!userId) return { success: false, message: 'userId is required' };
    return this.templates.getTargetsSummary(userId, channel);
  }
}
