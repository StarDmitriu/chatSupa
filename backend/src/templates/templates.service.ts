//backend/src/templates/templates.service.ts
import { Injectable, Logger } from '@nestjs/common';
import Papa from 'papaparse';
import { SupabaseService } from '../supabase/supabase.service';
import { TelegramService } from '../telegram/telegram.service';
import { applyTelegramGroupsTgPhoneScope } from '../telegram/telegram-groups-phone-scope';
import * as crypto from 'crypto';

/** TG targets до tg_account_key; WA всегда "" */
const LEGACY_TG_TEMPLATE_ACCOUNT_KEY = '';

function isMissingTgAccountKeyColumn(err: unknown): boolean {
  return String((err as any)?.message ?? err).includes('tg_account_key');
}

/** Колонки при импорте из таблицы (базовый набор — обратная совместимость) */
type SheetRow = {
  enabled?: string | boolean;
  order?: string | number;
  title?: string;
  text?: string;
  media_url?: string;
};

/** Полный снимок шаблона для бэкапа/импорта (все поля) */
export const BACKUP_CSV_HEADERS = [
  'enabled',
  'order',
  'title',
  'text',
  'media_url',
  'send_media_as_file',
  'wa_speed_factor',
  'tg_speed_factor',
  'wa_default_send_time',
  'tg_default_send_time',
] as const;

type SheetRowFull = Record<
  (typeof BACKUP_CSV_HEADERS)[number],
  string | number | boolean | undefined
>;

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

function toInt(v: unknown, def = 1): number {
  const n = Number(String(v ?? '').trim());
  if (!Number.isFinite(n)) return def;
  const x = Math.floor(n);
  return x > 0 ? x : def;
}

function normalizeUrl(input: string): string {
  const url = input.trim();

  if (url.includes('/export') && url.includes('format=csv')) return url;

  const m = url.match(/spreadsheets\/d\/([^/]+)/);
  if (!m) return url;

  const sheetId = m[1];
  const gidMatch = url.match(/gid=([0-9]+)/);
  const gid = gidMatch ? gidMatch[1] : '0';

  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

/** Ошибка Supabase: опциональные колонки message_templates отсутствуют в схеме (миграции не применены). */
function isSendMediaAsFileSchemaError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err).toLowerCase();
  return (
    msg.includes('send_media_as_file') ||
    msg.includes('wa_speed_factor') ||
    msg.includes('tg_speed_factor') ||
    msg.includes('wa_default_send_time') ||
    msg.includes('tg_default_send_time') ||
    msg.includes('wa_between_groups_sec') ||
    msg.includes('tg_between_groups_sec') ||
    (msg.includes('schema cache') && msg.includes('message_templates'))
  );
}

function normalizeTemplateBetweenSecPair(
  minRaw: unknown,
  maxRaw: unknown,
): { min: number; max: number } | null {
  if (minRaw === undefined || maxRaw === undefined) return null;
  const lo = Math.floor(Number(minRaw));
  const hi = Math.floor(Number(maxRaw));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  let mn = Math.max(5, Math.min(600, lo));
  let mx = Math.max(5, Math.min(600, hi));
  if (mn > mx) [mn, mx] = [mx, mn];
  return { min: mn, max: mx };
}

/**
 * Нормализация текста шаблона, введённого вручную в кабинете.
 * - сохраняем все переводы строк (включая подряд и в конце);
 * - приводим CRLF → LF;
 * - не обрезаем пробелы/переносы по краям, чтобы пустые строки не «схлопывались».
 * Для проверки «есть ли содержимый текст» используем trim, но само значение возвращаем без trim.
 */
function normalizeManualTemplateText(input: unknown): {
  text: string | null;
  hasContent: boolean;
} {
  const raw = (input ?? '') as string;
  const s = String(raw).replace(/\r\n/g, '\n');
  const hasContent = s.trim().length > 0;
  return { text: hasContent ? s : null, hasContent };
}

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly telegramService: TelegramService,
  ) {}

  private normalizeTgChatIdKey(jid: string): string {
    const s = String(jid ?? '').trim();
    if (!s) return '';
    if (s.startsWith('-100')) return s;
    if (s.startsWith('-')) return s; // уже отрицательный id
    if (/^\d+$/.test(s)) return `-100${s}`;
    return s;
  }

  async checkSheetConnection(userId: string) {
    const supabase = this.supabaseService.getClient();
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, gsheet_url')
      .eq('id', userId)
      .maybeSingle();

    if (userErr) {
      this.logger.error(userErr);
      return { success: false, message: 'Ошибка чтения users из Supabase' };
    }

    if (!user?.gsheet_url) {
      return {
        success: false,
        message: 'Ссылка на таблицу не сохранена в Интеграциях.',
      };
    }

    const csvUrl = normalizeUrl(user.gsheet_url);
    try {
      const res = await fetch(csvUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          success: false,
          message: `Таблица недоступна (${res.status}). Проверьте доступ по ссылке. Ответ: ${body.slice(0, 160)}`,
        };
      }
      const csvText = await res.text();
      const rows = csvText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const firstLine = (rows[0] ?? '').toLowerCase();
      const presentHeaders = BACKUP_CSV_HEADERS.filter((h) =>
        firstLine.includes(h.toLowerCase()),
      );
      const missingHeaders = BACKUP_CSV_HEADERS.filter(
        (h) => !firstLine.includes(h.toLowerCase()),
      );
      if (presentHeaders.length === 0) {
        return {
          success: false,
          message:
            'Таблица открывается, но заголовки не распознаны. Проверьте первую строку.',
          details: {
            csvRows: rows.length,
            missingHeaders,
          },
        };
      }
      return {
        success: true,
        message: 'Таблица доступна и готова к загрузке.',
        details: {
          csvRows: rows.length,
          dataRows: Math.max(rows.length - 1, 0),
          presentHeaders,
          missingHeaders,
        },
      };
    } catch (e: any) {
      return {
        success: false,
        message: `Ошибка сети при проверке таблицы: ${e?.message ?? e}`,
      };
    }
  }

  // ✅ НОВОЕ: загрузка медиа в bucket template-media
  async uploadMedia(userId: string, file: Express.Multer.File) {
    const supabase = this.supabaseService.getClient();

    const bucket = 'template-media';

    const orig = (file.originalname || 'file').replace(/[^\w.\-]+/g, '_');
    const ext = orig.includes('.') ? orig.split('.').pop() : '';
    const id = crypto.randomUUID();
    const filename = ext ? `${id}.${ext}` : id;

    // Можно хранить по пользователю
    const path = `${userId}/${filename}`;

    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(path, file.buffer, {
        contentType: file.mimetype || 'application/octet-stream',
        upsert: true,
      });

    if (upErr) {
      this.logger.error('storage upload error', upErr as any);
      return { success: false, message: 'storage_upload_error', error: upErr };
    }

    // PUBLIC bucket -> можно получить public url
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);

    return {
      success: true,
      path,
      publicUrl: data.publicUrl,
      mime: file.mimetype,
      size: file.size,
    };
  }

  // =========================
  // ✅ LIST (+ простая статистика по отправкам)
  // =========================
  async listTemplates(userId: string) {
    const supabase = this.supabaseService.getClient();
    const TG_PROBLEM_REASONS = [
      'CHANNEL_INVALID',
      'CHAT_WRITE_FORBIDDEN',
      'USER_BANNED_IN_CHANNEL',
      'CHANNEL_PRIVATE',
    ] as const;
    const TG_PROBLEM_LOOKBACK_DAYS = 30;

    // Сначала пробуем с колонкой "order" (в PostgreSQL order — зарезервированное слово)
    let templates: any[] | null = null;

    const LIST_TEMPLATES_LIMIT = 500;
    const { data: dataWithOrder, error: errWithOrder } = await supabase
      .from('message_templates')
      .select(
        'id, user_id, sheet_row, enabled, "order", title, text, media_url, send_media_as_file, created_at, updated_at, wa_speed_factor, tg_speed_factor, wa_default_send_time, tg_default_send_time, wa_between_groups_sec_min, wa_between_groups_sec_max, tg_between_groups_sec_min, tg_between_groups_sec_max',
      )
      .eq('user_id', userId)
      .order('order', { ascending: true })
      .order('updated_at', { ascending: false })
      .limit(LIST_TEMPLATES_LIMIT);

    if (!errWithOrder) {
      templates = dataWithOrder ?? [];
    } else {
      const errMsg = String(errWithOrder?.message ?? '');
      const missingColumn =
        errMsg.includes('send_media_as_file') ||
        errMsg.includes('"order"') ||
        errMsg.includes('order') ||
        errMsg.includes('created_at') ||
        errMsg.includes('wa_speed_factor') ||
        errMsg.includes('tg_speed_factor') ||
        errMsg.includes('wa_default_send_time') ||
        errMsg.includes('tg_default_send_time') ||
        errMsg.includes('wa_between_groups_sec') ||
        errMsg.includes('tg_between_groups_sec') ||
        errMsg.includes('does not exist');
      if (!missingColumn) {
        this.logger.error('listTemplates: select failed', errWithOrder as any);
        return {
          success: false,
          message: 'supabase_select_error',
          error: errWithOrder,
          details: errMsg,
        };
      }
      this.logger.warn(
        `listTemplates: select failed (${errWithOrder?.code ?? 'unknown'}): ${errMsg}. Trying fallback without optional columns.`,
      );
      // Fallback: без колонок order и send_media_as_file (если в БД их ещё нет)
      const { data: dataFallback, error: errFallback } = await supabase
        .from('message_templates')
        .select(
          'id, user_id, sheet_row, enabled, title, text, media_url, created_at, updated_at',
        )
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(LIST_TEMPLATES_LIMIT);

      if (errFallback) {
        const errFallbackMsg = String(errFallback?.message ?? '');

        // created_at может отсутствовать в старой схеме.
        // Тогда вернёмся к прежней эвристике (created_at=firstSentAt/updated_at) ниже,
        // но сам запрос списка не должен падать.
        if (errFallbackMsg.includes('created_at')) {
          const { data: dataFallbackNoCreatedAt, error: errFallbackNoCreatedAt } =
            await supabase
              .from('message_templates')
              .select('id, user_id, sheet_row, enabled, title, text, media_url, updated_at')
              .eq('user_id', userId)
              .order('updated_at', { ascending: false })
              .limit(LIST_TEMPLATES_LIMIT);

          if (errFallbackNoCreatedAt) {
            this.logger.error(
              'listTemplates: fallback (without created_at) select failed',
              errFallbackNoCreatedAt as any,
            );
            return {
              success: false,
              message: 'supabase_select_error',
              error: errFallbackNoCreatedAt,
              details: String(errFallbackNoCreatedAt?.message ?? errFallbackNoCreatedAt?.code ?? ''),
            };
          }

          templates = (dataFallbackNoCreatedAt ?? []).map((row: any) => ({
            ...row,
            order: row.order ?? 1,
            send_media_as_file: row.send_media_as_file ?? false,
          }));
        } else {
          this.logger.error(
            'listTemplates: fallback select failed',
            errFallback as any,
          );
          return {
            success: false,
            message: 'supabase_select_error',
            error: errFallback,
            details: String(errFallback?.message ?? errFallback?.code ?? ''),
          };
        }
      } else {
        templates = (dataFallback ?? []).map((row: any) => ({
          ...row,
          order: row.order ?? 1,
          send_media_as_file: row.send_media_as_file ?? false,
        }));
      }
    }

    // Количество выбранных групп по каждому шаблону и каналу (template_group_targets.enabled=true).
    const targetsCountByTemplate: Record<string, { wa: number; tg: number }> = {};
    const tgTargetGroupsByTemplate = new Map<string, Set<string>>();
    const uniqueGroupsGlobal = {
      wa: new Set<string>(),
      tg: new Set<string>(),
      all: new Set<string>(),
    };

    const activeTgKey = await this.telegramService.getActiveTgAccountKey(userId);
    const scopedTgNormKeys = new Set<string>();
    if (activeTgKey) {
      const { data: scopedTg } = await applyTelegramGroupsTgPhoneScope(
        supabase
          .from('telegram_groups')
          .select('tg_chat_id')
          .eq('user_id', userId),
        activeTgKey,
      );
      for (const r of scopedTg ?? []) {
        const raw = String((r as any)?.tg_chat_id ?? '').trim();
        if (raw) scopedTgNormKeys.add(this.normalizeTgChatIdKey(raw));
      }
    }

    let targetRows: any[] | null = null;
    let targetErr: any = null;
    let targetHasTgAccountKeyCol = true;
    {
      let tq = supabase
        .from('template_group_targets')
        .select('template_id, channel, group_jid, tg_account_key')
        .eq('user_id', userId)
        .eq('enabled', true);
      const tr = await tq;
      targetRows = tr.data ?? null;
      targetErr = tr.error;
      if (targetErr && isMissingTgAccountKeyColumn(targetErr)) {
        targetHasTgAccountKeyCol = false;
        const tr2 = await supabase
          .from('template_group_targets')
          .select('template_id, channel, group_jid')
          .eq('user_id', userId)
          .eq('enabled', true);
        targetRows = tr2.data ?? null;
        targetErr = tr2.error;
      }
    }

    if (!targetErr && targetRows) {
      const uniqByTemplate: Record<string, { wa: Set<string>; tg: Set<string> }> = {};
      for (const row of targetRows as any[]) {
        const templateId = String(row?.template_id ?? '').trim();
        const groupJid = String(row?.group_jid ?? '').trim();
        const channel: 'wa' | 'tg' =
          String(row?.channel ?? '').toLowerCase() === 'tg' ? 'tg' : 'wa';
        if (!templateId || !groupJid) continue;
        if (channel === 'tg') {
          if (!activeTgKey) continue;
          const acc = String(
            targetHasTgAccountKeyCol
              ? (row as any)?.tg_account_key ?? ''
              : '',
          ).trim();
          if (targetHasTgAccountKeyCol) {
            if (acc === activeTgKey) {
              /* ok */
            } else if (
              acc === LEGACY_TG_TEMPLATE_ACCOUNT_KEY
            ) {
              if (!scopedTgNormKeys.has(this.normalizeTgChatIdKey(groupJid)))
                continue;
            } else continue;
          } else {
            if (!scopedTgNormKeys.has(this.normalizeTgChatIdKey(groupJid)))
              continue;
          }
        }
        if (!uniqByTemplate[templateId]) {
          uniqByTemplate[templateId] = { wa: new Set<string>(), tg: new Set<string>() };
        }
        uniqByTemplate[templateId][channel].add(groupJid);
        if (channel === 'tg') {
          if (!tgTargetGroupsByTemplate.has(templateId)) {
            tgTargetGroupsByTemplate.set(templateId, new Set<string>());
          }
          tgTargetGroupsByTemplate.get(templateId)!.add(groupJid);
        }
        uniqueGroupsGlobal[channel].add(groupJid);
        uniqueGroupsGlobal.all.add(`${channel}:${groupJid}`);
      }
      for (const [templateId, groups] of Object.entries(uniqByTemplate)) {
        targetsCountByTemplate[templateId] = {
          wa: groups.wa.size,
          tg: groups.tg.size,
        };
      }
    }

    // Учитываем только активные (is_selected=true) TG-группы пользователя:
    // если пользователь отключил группу, она не должна отображаться как "проблемная".
    const activeTgGroupsSelected = new Set<string>();
    let selectedTgQ = supabase
      .from('telegram_groups')
      .select('tg_chat_id, quarantine_reason')
      .eq('user_id', userId)
      .eq('is_selected', true);
    if (activeTgKey) {
      selectedTgQ = applyTelegramGroupsTgPhoneScope(selectedTgQ, activeTgKey);
    }
    const { data: selectedTgRows, error: selectedTgErr } = await selectedTgQ;
    if (!selectedTgErr && selectedTgRows) {
      for (const row of selectedTgRows as any[]) {
        const reason = String(row?.quarantine_reason ?? '');
        if (reason.startsWith('stale_not_in_dialogs')) continue;
        const raw = String(row?.tg_chat_id ?? '').trim();
        if (!raw) continue;
        activeTgGroupsSelected.add(this.normalizeTgChatIdKey(raw));
      }
    }

    // WA: считаем "проблемными" только активные (is_selected=true) и не-announcement группы
    // с last_send_error, которые реально присутствуют в enabled template_group_targets.
    const problematicWaSelectedGroups = new Set<string>();
    const problematicWaByReason: Record<string, number> = {};
    const problematicWaTopGroups: Array<{
      group_jid: string;
      reason: string;
      count: number;
    }> = [];
    const { data: selectedWaRows, error: selectedWaErr } = await supabase
      .from('whatsapp_groups')
      .select('wa_group_id,last_send_error,is_selected,is_announcement')
      .eq('user_id', userId)
      .eq('is_selected', true)
      .or('is_announcement.is.null,is_announcement.eq.false');
    if (!selectedWaErr && selectedWaRows) {
      for (const row of selectedWaRows as any[]) {
        const waGroupId = String(row?.wa_group_id ?? '').trim();
        const lastSendError = String(row?.last_send_error ?? '').trim();
        if (!waGroupId || !lastSendError) continue;
        if (lastSendError === 'wa_not_connected') continue;
        if (!uniqueGroupsGlobal.wa.has(waGroupId)) continue;
        problematicWaSelectedGroups.add(waGroupId);
        problematicWaByReason[lastSendError] =
          Number(problematicWaByReason[lastSendError] ?? 0) + 1;
        problematicWaTopGroups.push({
          group_jid: waGroupId,
          reason: lastSendError,
          count: 1,
        });
      }
    }
    const waTopReasons = Object.entries(problematicWaByReason)
      .map(([reason, count]) => ({ reason, count: Number(count || 0) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    const waTopGroups = problematicWaTopGroups
      .sort((a, b) => a.group_jid.localeCompare(b.group_jid))
      .slice(0, 5);

    const tgProblemFromIso = new Date(
      Date.now() - TG_PROBLEM_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const tgProblemsByGroup = new Map<string, Record<string, number>>();
    const tgSentByGroup = new Map<string, number>();
    const { data: tgJobsRows, error: tgJobsErr } = await supabase
      .from('campaign_jobs')
      .select('group_jid, status, error, sent_at')
      .eq('user_id', userId)
      .eq('channel', 'tg')
      .not('group_jid', 'is', null)
      .gte('sent_at', tgProblemFromIso)
      .limit(50000);
    if (!tgJobsErr && tgJobsRows) {
      for (const row of tgJobsRows as any[]) {
        const groupJid = String(row?.group_jid ?? '').trim();
        if (!groupJid) continue;
        const status = String(row?.status ?? '').toLowerCase();
        if (status === 'sent') {
          tgSentByGroup.set(groupJid, (tgSentByGroup.get(groupJid) ?? 0) + 1);
          continue;
        }
        if (status !== 'failed') continue;
        const err = String(row?.error ?? '');
        const reason = TG_PROBLEM_REASONS.find((r) => err.includes(r));
        if (!reason) continue;
        if (!tgProblemsByGroup.has(groupJid)) {
          tgProblemsByGroup.set(groupJid, {
            CHANNEL_INVALID: 0,
            CHAT_WRITE_FORBIDDEN: 0,
            USER_BANNED_IN_CHANNEL: 0,
            CHANNEL_PRIVATE: 0,
          });
        }
        const reasons = tgProblemsByGroup.get(groupJid)!;
        reasons[reason] = Number(reasons[reason] ?? 0) + 1;
      }
    }

    const problematicByTemplate: Record<
      string,
      {
        total: number;
        by_reason: {
          CHANNEL_INVALID: number;
          CHAT_WRITE_FORBIDDEN: number;
          USER_BANNED_IN_CHANNEL: number;
          CHANNEL_PRIVATE: number;
        };
        top_groups: Array<{
          group_jid: string;
          failed: number;
          sent: number;
          topReason:
            | 'CHANNEL_INVALID'
            | 'CHAT_WRITE_FORBIDDEN'
            | 'USER_BANNED_IN_CHANNEL'
            | 'CHANNEL_PRIVATE'
            | 'UNKNOWN';
        }>;
      }
    > = {};
    const uniqueUndeliverableSelectedGroups = new Set<string>();
    for (const [templateId, tgGroups] of tgTargetGroupsByTemplate.entries()) {
      const agg = {
        CHANNEL_INVALID: 0,
        CHAT_WRITE_FORBIDDEN: 0,
        USER_BANNED_IN_CHANNEL: 0,
        CHANNEL_PRIVATE: 0,
      };
      let total = 0;
      const topGroups: Array<{
        group_jid: string;
        failed: number;
        sent: number;
        topReason:
          | 'CHANNEL_INVALID'
          | 'CHAT_WRITE_FORBIDDEN'
          | 'USER_BANNED_IN_CHANNEL'
          | 'CHANNEL_PRIVATE'
          | 'UNKNOWN';
      }> = [];
      for (const jid of tgGroups) {
        const jidKey = this.normalizeTgChatIdKey(jid);
        if (!activeTgGroupsSelected.has(jidKey)) continue;
        const reasonBag = tgProblemsByGroup.get(jid);
        if (!reasonBag) continue;
        const sentCount = tgSentByGroup.get(jid) ?? 0;
        const failedCount = Object.values(reasonBag).reduce(
          (acc, n) => acc + Number(n || 0),
          0,
        );
        if (sentCount > 0 || failedCount <= 0) continue;
        const reasonEntries = Object.entries(reasonBag).map(([reason, count]) => ({
          reason,
          count: Number(count || 0),
        }));
        const topReasonEntry = reasonEntries.sort((a, b) => b.count - a.count)[0];
        total += 1;
        uniqueUndeliverableSelectedGroups.add(jid);
        agg.CHANNEL_INVALID += Number(reasonBag.CHANNEL_INVALID || 0);
        agg.CHAT_WRITE_FORBIDDEN += Number(reasonBag.CHAT_WRITE_FORBIDDEN || 0);
        agg.USER_BANNED_IN_CHANNEL += Number(reasonBag.USER_BANNED_IN_CHANNEL || 0);
        agg.CHANNEL_PRIVATE += Number(reasonBag.CHANNEL_PRIVATE || 0);
        topGroups.push({
          group_jid: jid,
          failed: failedCount,
          sent: sentCount,
          topReason: (topReasonEntry?.reason as any) || 'UNKNOWN',
        });
      }
      topGroups.sort((a, b) => {
        if (b.failed !== a.failed) return b.failed - a.failed;
        return a.group_jid.localeCompare(b.group_jid);
      });
      problematicByTemplate[templateId] = {
        total,
        by_reason: agg,
        top_groups: topGroups.slice(0, 5),
      };
    }

    // Простейшая аналитика по шаблонам на основе campaign_jobs:
    // сколько всего заданий, сколько успешно отправлено, первая и последняя отправка.
    const statsMap: Record<
      string,
      {
        total: number;
        sent: number;
        failed: number;
        firstSentAt: string | null;
        lastSentAt: string | null;
      }
    > = {};

    const CAMPAIGN_JOBS_STATS_LIMIT = 10_000;
    const { data: jobs, error: jobsErr } = await supabase
      .from('campaign_jobs')
      .select('template_id, status, sent_at, user_id')
      .eq('user_id', userId)
      .order('sent_at', { ascending: false })
      .limit(CAMPAIGN_JOBS_STATS_LIMIT);

    if (!jobsErr && jobs) {
      for (const row of jobs) {
        const tid = String((row as any).template_id || '');
        if (!tid) continue;
        const status = String((row as any).status || '');
        const sentAtRaw = (row as any).sent_at as string | null;

        if (!statsMap[tid]) {
          statsMap[tid] = {
            total: 0,
            sent: 0,
            failed: 0,
            firstSentAt: null,
            lastSentAt: null,
          };
        }

        const stat = statsMap[tid];
        stat.total += 1;
        if (status === 'sent') stat.sent += 1;
        if (status === 'failed') stat.failed += 1;

        if (sentAtRaw) {
          const iso = new Date(sentAtRaw).toISOString();
          if (!stat.firstSentAt || iso < stat.firstSentAt) {
            stat.firstSentAt = iso;
          }
          if (!stat.lastSentAt || iso > stat.lastSentAt) {
            stat.lastSentAt = iso;
          }
        }
      }
    }

    const enriched =
      templates?.map((t: any) => {
        const tid = String(t.id);
        const stats = statsMap[tid] ?? null;

        // created_at в БД; если NULL (старая схема / старый insert) — первая отправка; иначе updated_at как последний компромисс.
        const created_at =
          t.created_at ??
          (stats && stats.firstSentAt) ??
          t.updated_at ??
          null;

        return {
          ...t,
          created_at,
          stats,
          targets_count: targetsCountByTemplate[tid] ?? { wa: 0, tg: 0 },
          problematic_groups:
            problematicByTemplate[tid] ?? {
              total: 0,
              by_reason: {
                CHANNEL_INVALID: 0,
                CHAT_WRITE_FORBIDDEN: 0,
                USER_BANNED_IN_CHANNEL: 0,
                CHANNEL_PRIVATE: 0,
              },
              top_groups: [],
            },
        };
      }) ?? [];

    const templatesWithGroupsSelected = enriched.filter((t: any) => {
      const wa = Number(t?.targets_count?.wa ?? 0);
      const tg = Number(t?.targets_count?.tg ?? 0);
      return wa + tg > 0;
    }).length;
    const totalTargetsAssigned = enriched.reduce((acc: number, t: any) => {
      const wa = Number(t?.targets_count?.wa ?? 0);
      const tg = Number(t?.targets_count?.tg ?? 0);
      return acc + wa + tg;
    }, 0);
    const totals = {
      templatesTotal: enriched.length,
      templatesWithGroupsSelected,
      totalTargetsAssigned,
      uniqueGroupsAll: uniqueGroupsGlobal.all.size,
      uniqueGroupsWa: uniqueGroupsGlobal.wa.size,
      uniqueGroupsTg: uniqueGroupsGlobal.tg.size,
      uniqueUndeliverableSelectedGroups: uniqueUndeliverableSelectedGroups.size,
      uniqueUndeliverableSelectedGroupsWa: problematicWaSelectedGroups.size,
      problematicWaSummary: {
        total: problematicWaSelectedGroups.size,
        topReasons: waTopReasons,
        topGroups: waTopGroups,
      },
    };

    return { success: true, templates: enriched, totals };
  }

  // =========================
  // ✅ CREATE (manual)
  // =========================
  async createTemplate(
    userId: string,
    dto: {
      title?: string;
      text?: string;
      media_url?: string;
      send_media_as_file?: boolean;
      enabled?: boolean;
      order?: number;
    },
  ) {
    const supabase = this.supabaseService.getClient();

    const title = String(dto.title ?? '').trim();
    const { text, hasContent } = normalizeManualTemplateText(dto.text);
    const media_url = String(dto.media_url ?? '').trim();
    const send_media_as_file = dto.send_media_as_file === true;

    if (!title && !hasContent) {
      return { success: false, message: 'title_or_text_required' };
    }

    // ⚠️ ВАЖНО:
    // sheet_row используется как уникальный ключ для синка из Google Sheets (user_id, sheet_row).
    // Чтобы ручные шаблоны НЕ перезатирались синком, даём им sheet_row >= 1_000_000.
    const { data: maxRow, error: maxErr } = await supabase
      .from('message_templates')
      .select('sheet_row')
      .eq('user_id', userId)
      .order('sheet_row', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (maxErr) {
      return {
        success: false,
        message: 'supabase_maxrow_error',
        error: maxErr,
      };
    }

    const currentMax = Number((maxRow as any)?.sheet_row ?? 0);
    const base = currentMax >= 1_000_000 ? currentMax : 1_000_000;
    const sheet_row = base + 1;

    const enabled = dto.enabled === undefined ? true : !!dto.enabled;
    const order = Number.isFinite(Number(dto.order)) ? Number(dto.order) : 1;

    const nowIso = new Date().toISOString();
    const payload = {
      user_id: userId,
      sheet_row,
      enabled,
      order,
      title: title || null,
      text: text || null,
      media_url: media_url || null,
      send_media_as_file,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const selectCols =
      'id, user_id, sheet_row, enabled, "order", title, text, media_url, send_media_as_file, created_at, updated_at';
    let { data: inserted, error } = await supabase
      .from('message_templates')
      .insert(payload)
      .select(selectCols)
      .single();

    if (error && isSendMediaAsFileSchemaError(error)) {
      this.logger.warn(
        'createTemplate: send_media_as_file column missing, retrying without it',
      );
      const payloadWithout = { ...payload };
      delete (payloadWithout as any).send_media_as_file;
      const res = await supabase
        .from('message_templates')
        .insert(payloadWithout)
        .select(
          'id, user_id, sheet_row, enabled, "order", title, text, media_url, created_at, updated_at',
        )
        .single();
      if (res.error)
        return {
          success: false,
          message: 'supabase_insert_error',
          error: res.error,
        };
      inserted = (res as any).data
        ? {
            ...(res as any).data,
            send_media_as_file: false,
          }
        : (res as any).data;
      error = null;
    }

    if (error) {
      return { success: false, message: 'supabase_insert_error', error };
    }

    return { success: true, template: inserted };
  }

  // =========================
  // SYNC FROM SHEET (как было)
  // =========================
  async syncFromSheet(userId: string) {
    const supabase = this.supabaseService.getClient();

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, gsheet_url')
      .eq('id', userId)
      .maybeSingle();

    if (userErr) {
      this.logger.error(userErr);
      return { success: false, message: 'Ошибка чтения users из Supabase' };
    }

    if (!user?.gsheet_url) {
      return {
        success: false,
        message:
          'У пользователя не заполнен gsheet_url. Вставь ссылку на Google Sheet (или export csv).',
      };
    }

    const csvUrl = normalizeUrl(user.gsheet_url);

    let csvText: string;
    try {
      const res = await fetch(csvUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          success: false,
          message: `Не удалось скачать CSV (${res.status}). Проверь что таблица "Доступ по ссылке" = Просмотр. Ответ: ${body.slice(
            0,
            200,
          )}`,
        };
      }

      csvText = await res.text();
    } catch (e: any) {
      return {
        success: false,
        message: `Ошибка сети при скачивании Google Sheet: ${e?.message ?? e}`,
      };
    }

    const parsed = Papa.parse<SheetRow & Partial<SheetRowFull>>(csvText, {
      header: true,
      skipEmptyLines: true,
    });

    if (parsed.errors?.length) {
      return {
        success: false,
        message: `CSV parse error: ${parsed.errors[0]?.message ?? 'unknown'}`,
      };
    }

    const raw = parsed.data ?? [];
    const now = new Date().toISOString();

    const payload = raw
      .map((r, i) => ({ r, sheetRow: i + 2 }))
      .filter(
        ({ r }) =>
          r &&
          ((r.title && String(r.title).trim()) ||
            (r.text && String(r.text).trim())),
      )
      .map(({ r, sheetRow }) => ({
        user_id: userId,
        sheet_row: sheetRow,
        enabled: toBool(r.enabled ?? true),
        order: toInt(r.order ?? 1, 1),
        title: (r.title ?? '').toString().trim() || null,
        text: (r.text ?? '').toString().trim() || null,
        media_url: (r.media_url ?? '').toString().trim() || null,
        send_media_as_file: toBool((r as any).send_media_as_file ?? false),
        wa_speed_factor: Math.max(
          10,
          Math.min(400, toInt((r as any).wa_speed_factor ?? 100, 100)),
        ),
        tg_speed_factor: Math.max(
          10,
          Math.min(400, toInt((r as any).tg_speed_factor ?? 100, 100)),
        ),
        wa_default_send_time:
          String((r as any).wa_default_send_time ?? '').trim() || null,
        tg_default_send_time:
          String((r as any).tg_default_send_time ?? '').trim() || null,
        updated_at: now,
      }));

    let upsertErr = (
      await supabase
        .from('message_templates')
        .upsert(payload, { onConflict: 'user_id,sheet_row' })
    ).error;
    if (upsertErr && isSendMediaAsFileSchemaError(upsertErr)) {
      this.logger.warn(
        'syncFromSheet: optional columns missing, retrying without them',
      );
      const payloadBase = payload.map((p) => ({
        user_id: p.user_id,
        sheet_row: p.sheet_row,
        enabled: p.enabled,
        order: p.order,
        title: p.title,
        text: p.text,
        media_url: p.media_url,
        updated_at: p.updated_at,
      }));
      const res = await supabase
        .from('message_templates')
        .upsert(payloadBase, { onConflict: 'user_id,sheet_row' });
      upsertErr = res.error;
    }

    if (upsertErr) {
      this.logger.error(upsertErr);
      return { success: false, message: 'Не удалось записать шаблоны в БД' };
    }

    return {
      success: true,
      message: `Синхронизировано шаблонов: ${payload.length}`,
      count: payload.length,
    };
  }

  /**
   * Экспорт всех шаблонов пользователя в CSV (полный снимок для бэкапа).
   * Колонки: BACKUP_CSV_HEADERS.
   */
  async exportBackup(
    userId: string,
  ): Promise<
    { success: true; csv: string } | { success: false; message: string }
  > {
    const supabase = this.supabaseService.getClient();

    let { data: rows, error } = await supabase
      .from('message_templates')
      .select(
        'enabled, "order", title, text, media_url, send_media_as_file, wa_speed_factor, tg_speed_factor, wa_default_send_time, tg_default_send_time',
      )
      .eq('user_id', userId)
      .order('order', { ascending: true })
      .order('updated_at', { ascending: false });

    if (error && isSendMediaAsFileSchemaError(error)) {
      const fallback = await supabase
        .from('message_templates')
        .select('enabled, "order", title, text, media_url')
        .eq('user_id', userId)
        .order('order', { ascending: true })
        .order('updated_at', { ascending: false });
      if (!fallback.error && fallback.data) {
        rows = (fallback.data as any[]).map((r) => ({
          ...r,
          send_media_as_file: false,
          wa_speed_factor: 100,
          tg_speed_factor: 100,
          wa_default_send_time: '',
          tg_default_send_time: '',
        }));
        error = null;
      }
    }

    if (error) {
      this.logger.error(error);
      return { success: false, message: 'Ошибка чтения шаблонов' };
    }

    const list = (rows ?? []).map((r: any) => ({
      enabled:
        r.enabled === true
          ? 'true'
          : r.enabled === false
            ? 'false'
            : String(r.enabled ?? 'true'),
      order: Number(r.order) || 1,
      title: r.title ?? '',
      text: r.text ?? '',
      media_url: r.media_url ?? '',
      send_media_as_file: r.send_media_as_file === true ? 'true' : 'false',
      wa_speed_factor: Number(r.wa_speed_factor) || 100,
      tg_speed_factor: Number(r.tg_speed_factor) || 100,
      wa_default_send_time: r.wa_default_send_time ?? '',
      tg_default_send_time: r.tg_default_send_time ?? '',
    }));

    const csv = Papa.unparse(list, {
      columns: [...BACKUP_CSV_HEADERS],
      header: true,
      quoteChar: '"',
      escapeChar: '"',
      newline: '\r\n',
    });
    return { success: true, csv };
  }

  /**
   * Импорт шаблонов из CSV (полная замена: удаляем все шаблоны пользователя, вставляем из файла).
   * В каждой строке обязательны title или text.
   */
  async importFromCsv(
    userId: string,
    csvText: string,
  ): Promise<
    | {
        success: true;
        count: number;
        totalRows: number;
        importedRows: number;
        skippedRows: number;
      }
    | { success: false; message: string }
  > {
    const supabase = this.supabaseService.getClient();

    const parsed = Papa.parse<SheetRowFull>(csvText, {
      header: true,
      skipEmptyLines: true,
    });
    if (parsed.errors?.length) {
      return {
        success: false,
        message: `Ошибка разбора CSV: ${parsed.errors[0]?.message ?? 'unknown'}`,
      };
    }

    const raw = parsed.data ?? [];
    const totalRows = raw.length;
    const importTs = new Date().toISOString();
    const rows = raw
      .map((r, i) => ({ r, sheetRow: i + 2 }))
      .filter(
        ({ r }) =>
          r && (String(r?.title ?? '').trim() || String(r?.text ?? '').trim()),
      )
      .map(({ r, sheetRow }) => {
        const title = String(r?.title ?? '').trim() || null;
        const text = String(r?.text ?? '').trim() || null;
        return {
          user_id: userId,
          sheet_row: sheetRow,
          enabled: toBool(r?.enabled ?? true),
          order: toInt(r?.order ?? 1, 1),
          title,
          text,
          media_url: String(r?.media_url ?? '').trim() || null,
          send_media_as_file: toBool(r?.send_media_as_file ?? false),
          wa_speed_factor: Math.max(
            10,
            Math.min(400, toInt(r?.wa_speed_factor ?? 100, 100)),
          ),
          tg_speed_factor: Math.max(
            10,
            Math.min(400, toInt(r?.tg_speed_factor ?? 100, 100)),
          ),
          wa_default_send_time:
            String(r?.wa_default_send_time ?? '').trim() || null,
          tg_default_send_time:
            String(r?.tg_default_send_time ?? '').trim() || null,
          created_at: importTs,
          updated_at: importTs,
        };
      });

    if (rows.length === 0) {
      return {
        success: false,
        message: 'В файле нет строк с заполненными названием или текстом',
      };
    }

    const { error: delErr } = await supabase
      .from('message_templates')
      .delete()
      .eq('user_id', userId);

    if (delErr) {
      this.logger.error(delErr);
      return { success: false, message: 'Не удалось очистить старые шаблоны' };
    }

    const insertPayload = rows.map(
      ({
        user_id,
        sheet_row,
        enabled,
        order,
        title,
        text,
        media_url,
        send_media_as_file,
        wa_speed_factor,
        tg_speed_factor,
        wa_default_send_time,
        tg_default_send_time,
        created_at,
        updated_at,
      }) => ({
        user_id,
        sheet_row,
        enabled,
        order,
        title,
        text,
        media_url,
        send_media_as_file,
        wa_speed_factor,
        tg_speed_factor,
        wa_default_send_time,
        tg_default_send_time,
        created_at,
        updated_at,
      }),
    );

    let result = await supabase
      .from('message_templates')
      .insert(insertPayload)
      .select('id');

    if (result.error && isSendMediaAsFileSchemaError(result.error)) {
      this.logger.warn(
        'importFromCsv: optional columns missing, retrying without them',
      );
      const insertWithout = insertPayload.map((p) => {
        const {
          send_media_as_file: _,
          wa_speed_factor: __,
          tg_speed_factor: ___,
          wa_default_send_time: ____,
          tg_default_send_time: _____,
        } = p;
        return {
          user_id: p.user_id,
          sheet_row: p.sheet_row,
          enabled: p.enabled,
          order: p.order,
          title: p.title,
          text: p.text,
          media_url: p.media_url,
          created_at: p.created_at,
          updated_at: p.updated_at,
        };
      });
      result = await supabase
        .from('message_templates')
        .insert(insertWithout)
        .select('id');
    }

    if (result.error) {
      this.logger.error(result.error);
      return {
        success: false,
        message: 'Не удалось записать шаблоны из файла',
      };
    }

    return {
      success: true,
      count: rows.length,
      totalRows,
      importedRows: rows.length,
      skippedRows: Math.max(0, totalRows - rows.length),
    };
  }

  async list(userId: string) {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase
      .from('message_templates')
      .select(
        'id, sheet_row, enabled, "order", title, text, media_url, send_media_as_file, updated_at',
      )
      .eq('user_id', userId)
      .order('order', { ascending: true })
      .order('updated_at', { ascending: false });

    if (error)
      return { success: false, message: 'supabase_select_error', error };
    return { success: true, templates: data ?? [] };
  }

  private async nextManualSheetRow(userId: string) {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase
      .from('message_templates')
      .select('sheet_row')
      .eq('user_id', userId)
      .gte('sheet_row', 1_000_000)
      .order('sheet_row', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    const maxRow = Number((data as any)?.sheet_row ?? 999_999);
    return Math.max(1_000_000, maxRow + 1);
  }

  async createManual(
    userId: string,
    input: {
      title?: string;
      text?: string;
      media_url?: string;
      send_media_as_file?: boolean;
      enabled?: boolean;
      order?: number;
      wa_speed_factor?: number;
      tg_speed_factor?: number;
      wa_between_groups_sec_min?: number;
      wa_between_groups_sec_max?: number;
      tg_between_groups_sec_min?: number;
      tg_between_groups_sec_max?: number;
      wa_default_send_time?: string | null;
      tg_default_send_time?: string | null;
    },
  ) {
    const supabase = this.supabaseService.getClient();

    const title = (input.title ?? '').toString().trim() || null;
    const { text, hasContent: textHasContent } = normalizeManualTemplateText(
      input.text,
    );
    const media_url = (input.media_url ?? '').toString().trim() || null;
    const send_media_as_file = input.send_media_as_file === true;

    if (!title && !textHasContent)
      return { success: false, message: 'title_or_text_required' };

    const sheet_row = await this.nextManualSheetRow(userId);

    const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
    const orderRaw = Number(input.order);
    const order = Number.isFinite(orderRaw)
      ? Math.max(1, Math.floor(orderRaw))
      : 1;

    const waPair = normalizeTemplateBetweenSecPair(
      input.wa_between_groups_sec_min,
      input.wa_between_groups_sec_max,
    );
    const tgPair = normalizeTemplateBetweenSecPair(
      input.tg_between_groups_sec_min,
      input.tg_between_groups_sec_max,
    );

    const nowIso = new Date().toISOString();
    const payload = {
      user_id: userId,
      sheet_row,
      enabled,
      order,
      title,
      text: text ?? null,
      media_url,
      send_media_as_file,
      wa_speed_factor: waPair
        ? 100
        : Number.isFinite(Number(input.wa_speed_factor))
          ? Math.max(10, Math.min(400, Math.floor(Number(input.wa_speed_factor))))
          : 100,
      tg_speed_factor: tgPair
        ? 100
        : Number.isFinite(Number(input.tg_speed_factor))
          ? Math.max(10, Math.min(400, Math.floor(Number(input.tg_speed_factor))))
          : 100,
      wa_between_groups_sec_min: waPair ? waPair.min : null,
      wa_between_groups_sec_max: waPair ? waPair.max : null,
      tg_between_groups_sec_min: tgPair ? tgPair.min : null,
      tg_between_groups_sec_max: tgPair ? tgPair.max : null,
      wa_default_send_time:
        input.wa_default_send_time != null
          ? String(input.wa_default_send_time).trim() || null
          : null,
      tg_default_send_time:
        input.tg_default_send_time != null
          ? String(input.tg_default_send_time).trim() || null
          : null,
      created_at: nowIso,
      updated_at: nowIso,
    };

    let result = await supabase
      .from('message_templates')
      .insert(payload)
      .select('id')
      .single();

    let persistenceDegraded = false;
    if (result.error && isSendMediaAsFileSchemaError(result.error)) {
      persistenceDegraded = true;
      this.logger.warn(
        'createManual: optional columns missing, retrying without them (ползунки пауз / speed / дефолт времени не сохранятся — миграция message_templates)',
      );
      const payloadWithout = { ...payload };
      delete (payloadWithout as any).send_media_as_file;
      delete (payloadWithout as any).wa_speed_factor;
      delete (payloadWithout as any).tg_speed_factor;
      delete (payloadWithout as any).wa_default_send_time;
      delete (payloadWithout as any).tg_default_send_time;
      delete (payloadWithout as any).wa_between_groups_sec_min;
      delete (payloadWithout as any).wa_between_groups_sec_max;
      delete (payloadWithout as any).tg_between_groups_sec_min;
      delete (payloadWithout as any).tg_between_groups_sec_max;
      result = await supabase
        .from('message_templates')
        .insert(payloadWithout)
        .select('id')
        .single();
    }

    const { data, error } = result;
    if (error)
      return { success: false, message: 'supabase_insert_error', error };

    return {
      success: true,
      templateId: (data as any).id,
      ...(persistenceDegraded ? { persistenceDegraded: true as const } : {}),
    };
  }

  async update(
    userId: string,
    templateId: string,
    input: {
      title?: string;
      text?: string;
      media_url?: string;
      send_media_as_file?: boolean;
      enabled?: boolean;
      order?: number;
      wa_speed_factor?: number;
      tg_speed_factor?: number;
      wa_between_groups_sec_min?: number | null;
      wa_between_groups_sec_max?: number | null;
      tg_between_groups_sec_min?: number | null;
      tg_between_groups_sec_max?: number | null;
      wa_default_send_time?: string | null;
      tg_default_send_time?: string | null;
    },
  ) {
    const supabase = this.supabaseService.getClient();

    const patch: any = { updated_at: new Date().toISOString() };
    if (input.title !== undefined)
      patch.title = (input.title ?? '').toString().trim() || null;
    if (input.text !== undefined) {
      const { text } = normalizeManualTemplateText(input.text);
      patch.text = text;
    }
    if (input.media_url !== undefined)
      patch.media_url = (input.media_url ?? '').toString().trim() || null;
    if (input.send_media_as_file !== undefined)
      patch.send_media_as_file = !!input.send_media_as_file;
    if (input.enabled !== undefined) patch.enabled = !!input.enabled;

    if (input.wa_speed_factor !== undefined) {
      const n = Number(input.wa_speed_factor);
      if (Number.isFinite(n))
        patch.wa_speed_factor = Math.max(10, Math.min(400, Math.floor(n)));
    }
    if (input.tg_speed_factor !== undefined) {
      const n = Number(input.tg_speed_factor);
      if (Number.isFinite(n))
        patch.tg_speed_factor = Math.max(10, Math.min(400, Math.floor(n)));
    }

    if (
      input.wa_between_groups_sec_min !== undefined &&
      input.wa_between_groups_sec_max !== undefined
    ) {
      const waP = normalizeTemplateBetweenSecPair(
        input.wa_between_groups_sec_min,
        input.wa_between_groups_sec_max,
      );
      if (waP) {
        patch.wa_between_groups_sec_min = waP.min;
        patch.wa_between_groups_sec_max = waP.max;
        patch.wa_speed_factor = 100;
      }
    }
    if (
      input.tg_between_groups_sec_min !== undefined &&
      input.tg_between_groups_sec_max !== undefined
    ) {
      const tgP = normalizeTemplateBetweenSecPair(
        input.tg_between_groups_sec_min,
        input.tg_between_groups_sec_max,
      );
      if (tgP) {
        patch.tg_between_groups_sec_min = tgP.min;
        patch.tg_between_groups_sec_max = tgP.max;
        patch.tg_speed_factor = 100;
      }
    }

    if (input.wa_default_send_time !== undefined) {
      patch.wa_default_send_time =
        input.wa_default_send_time == null
          ? null
          : String(input.wa_default_send_time).trim() || null;
    }
    if (input.tg_default_send_time !== undefined) {
      patch.tg_default_send_time =
        input.tg_default_send_time == null
          ? null
          : String(input.tg_default_send_time).trim() || null;
    }

    if (input.order !== undefined) {
      const n = Number(input.order);
      if (Number.isFinite(n)) patch.order = Math.max(1, Math.floor(n));
    }

    if (patch.title === null && patch.text === null) {
      return { success: false, message: 'title_or_text_required' };
    }

    let result = await supabase
      .from('message_templates')
      .update(patch)
      .eq('user_id', userId)
      .eq('id', templateId)
      .select('id')
      .maybeSingle();

    let persistenceDegraded = false;
    if (result.error && isSendMediaAsFileSchemaError(result.error)) {
      persistenceDegraded = true;
      this.logger.warn(
        'update: optional columns missing, retrying without them (ползунки пауз / speed — выполните миграцию message_templates)',
      );
      const patchWithout = { ...patch };
      delete patchWithout.send_media_as_file;
      delete patchWithout.wa_speed_factor;
      delete patchWithout.tg_speed_factor;
      delete patchWithout.wa_default_send_time;
      delete patchWithout.tg_default_send_time;
      delete patchWithout.wa_between_groups_sec_min;
      delete patchWithout.wa_between_groups_sec_max;
      delete patchWithout.tg_between_groups_sec_min;
      delete patchWithout.tg_between_groups_sec_max;
      result = await supabase
        .from('message_templates')
        .update(patchWithout)
        .eq('user_id', userId)
        .eq('id', templateId)
        .select('id')
        .maybeSingle();
    }

    const { data, error } = result;
    if (error) {
      const errMsg = (error as any)?.message ?? String(error);
      const errCode = (error as any)?.code;
      this.logger.warn('message_templates update failed', {
        userId,
        templateId,
        code: errCode,
        message: errMsg,
      });
      return {
        success: false,
        message: errMsg || 'supabase_update_error',
        error: errMsg,
        code: errCode,
      };
    }
    if (!data) return { success: false, message: 'template_not_found' };

    return {
      success: true,
      ...(persistenceDegraded ? { persistenceDegraded: true as const } : {}),
    };
  }

  async getOne(userId: string, templateId: string) {
    const supabase = this.supabaseService.getClient();

    let result = await supabase
      .from('message_templates')
      .select(
        'id, sheet_row, enabled, "order", title, text, media_url, send_media_as_file, wa_speed_factor, tg_speed_factor, wa_default_send_time, tg_default_send_time, wa_between_groups_sec_min, wa_between_groups_sec_max, tg_between_groups_sec_min, tg_between_groups_sec_max, updated_at',
      )
      .eq('user_id', userId)
      .eq('id', templateId)
      .maybeSingle();

    let data = result.data;
    if (result.error && isSendMediaAsFileSchemaError(result.error)) {
      const fallback = await supabase
        .from('message_templates')
        .select(
          'id, sheet_row, enabled, "order", title, text, media_url, updated_at',
        )
        .eq('user_id', userId)
        .eq('id', templateId)
        .maybeSingle();
      if (!fallback.error && fallback.data) {
        data = {
          ...fallback.data,
          send_media_as_file: false,
          wa_speed_factor: 100,
          tg_speed_factor: 100,
          wa_default_send_time: null,
          tg_default_send_time: null,
        } as any;
        (result as any).error = null;
      } else result = fallback as any;
    }

    if (!data) return { success: false, message: 'template_not_found' };
    if (result.error)
      return {
        success: false,
        message: 'supabase_select_error',
        error: result.error,
      };

    return { success: true, template: data };
  }

  async getById(templateId: string) {
    const supabase = this.supabaseService.getClient();

    let result = await supabase
      .from('message_templates')
      .select(
        'id, user_id, enabled, "order", title, text, media_url, send_media_as_file, wa_speed_factor, tg_speed_factor, wa_default_send_time, tg_default_send_time, wa_between_groups_sec_min, wa_between_groups_sec_max, tg_between_groups_sec_min, tg_between_groups_sec_max, updated_at',
      )
      .eq('id', templateId)
      .maybeSingle();

    let data = result.data;
    if (result.error && isSendMediaAsFileSchemaError(result.error)) {
      const fallback = await supabase
        .from('message_templates')
        .select(
          'id, user_id, enabled, "order", title, text, media_url, updated_at',
        )
        .eq('id', templateId)
        .maybeSingle();
      if (!fallback.error && fallback.data) {
        data = {
          ...fallback.data,
          send_media_as_file: false,
          wa_speed_factor: 100,
          tg_speed_factor: 100,
          wa_default_send_time: null,
          tg_default_send_time: null,
        } as any;
        (result as any).error = null;
      } else result = fallback as any;
    }

    if (!data) return { success: false, message: 'template_not_found' };
    if (result.error)
      return {
        success: false,
        message: 'supabase_select_error',
        error: result.error,
      };

    return { success: true, template: data };
  }

  async remove(userId: string, templateId: string) {
    const supabase = this.supabaseService.getClient();

    const { error } = await supabase
      .from('message_templates')
      .delete()
      .eq('user_id', userId)
      .eq('id', templateId);

    if (error)
      return { success: false, message: 'supabase_delete_error', error };
    return { success: true };
  }

  // backend/src/templates/templates.service.ts

  private normChannel(v: any): 'wa' | 'tg' {
    return String(v || 'wa').toLowerCase() === 'tg' ? 'tg' : 'wa';
  }

  async getTargets(userId: string, templateId: string, channel?: string) {
    const supabase = this.supabaseService.getClient();
    const ch = this.normChannel(channel);

    let activeTg: string | null = null;
    let scopedNorm = new Set<string>();
    if (ch === 'tg') {
      activeTg = await this.telegramService.getActiveTgAccountKey(userId);
      if (!activeTg) {
        return { success: true, groupJids: [] as string[], overrides: {} };
      }
      const { data: scopedRows } = await applyTelegramGroupsTgPhoneScope(
        supabase
          .from('telegram_groups')
          .select('tg_chat_id')
          .eq('user_id', userId),
        activeTg,
      );
      for (const r of scopedRows ?? []) {
        const raw = String((r as any)?.tg_chat_id ?? '').trim();
        if (raw) scopedNorm.add(this.normalizeTgChatIdKey(raw));
      }
    }

    const selectCols = ch === 'tg' ? 'group_jid, send_time_override, tg_account_key' : 'group_jid, send_time_override';
    let q = supabase
      .from('template_group_targets')
      .select(selectCols)
      .eq('user_id', userId)
      .eq('template_id', templateId)
      .eq('channel', ch)
      .eq('enabled', true);
    if (ch === 'tg' && activeTg) {
      q = q.in('tg_account_key', [activeTg, LEGACY_TG_TEMPLATE_ACCOUNT_KEY]);
    }
    let result: any = await q;

    if (result.error) {
      const msg = String(result.error?.message ?? result.error).toLowerCase();
      if (ch === 'tg' && isMissingTgAccountKeyColumn(result.error)) {
        result = await supabase
          .from('template_group_targets')
          .select('group_jid, send_time_override')
          .eq('user_id', userId)
          .eq('template_id', templateId)
          .eq('channel', ch)
          .eq('enabled', true);
      } else {
        const missingOverride =
          msg.includes('send_time_override') ||
          (msg.includes('schema cache') &&
            msg.includes('template_group_targets'));

        if (missingOverride) {
          result = await supabase
            .from('template_group_targets')
            .select('group_jid')
            .eq('user_id', userId)
            .eq('template_id', templateId)
            .eq('channel', ch)
            .eq('enabled', true);
          if (!result.error && result.data) {
            const rows = (result.data ?? []) as any[];
            const filtered = ch === 'tg'
              ? rows.filter((x: any) =>
                  scopedNorm.has(this.normalizeTgChatIdKey(String(x.group_jid))),
                )
              : rows;
            const groupJids = filtered.map((x: any) => String(x.group_jid));
            return { success: true, groupJids, overrides: {} };
          }
        }
        return {
          success: false,
          message: 'supabase_targets_select_error',
          error: result.error,
        };
      }
    }

    const data = result.data as any[] | null;
    const rowsOut: any[] = [];
    for (const row of data ?? []) {
      if (ch === 'tg' && activeTg) {
        const acc = String((row as any).tg_account_key ?? '').trim();
        const hasCol = 'tg_account_key' in (row as any);
        const norm = this.normalizeTgChatIdKey(String(row.group_jid || ''));
        if (hasCol) {
          if (acc === activeTg) rowsOut.push(row);
          else if (
            acc === LEGACY_TG_TEMPLATE_ACCOUNT_KEY &&
            scopedNorm.has(norm)
          )
            rowsOut.push(row);
        } else if (scopedNorm.has(norm)) {
          rowsOut.push(row);
        }
      } else {
        rowsOut.push(row);
      }
    }

    const groupJids = rowsOut.map((x: any) => String(x.group_jid));
    const overrides: Record<string, string | null> = {};
    for (const row of rowsOut) {
      const jid = String(row.group_jid || '').trim();
      if (!jid) continue;
      const v = row.send_time_override;
      overrides[jid] = v == null ? null : String(v);
    }
    return { success: true, groupJids, overrides };
  }

  /**
   * Метрики coverage для правой панели:
   * - какие templates реально имеют enabled targets пересекающиеся с выбранными группами
   * - какая доля selected groups покрыта template_group_targets
   * - и доля coverage с send_time_override (фикс / интервальный / нет)
   *
   * Важно: этот endpoint считает именно по template_group_targets,
   * а не по send_time группы.
   */
  async getTargetsSummary(userId: string, channel?: string) {
    const supabase = this.supabaseService.getClient();
    const ch = this.normChannel(channel);

    const fixedRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    const intervalKeys = new Set([
      '2-5m',
      '5-15m',
      '15-30m',
      '30-60m',
      '1-2h',
      '2-4h',
      '4h',
      '6h',
      '6-12h',
      '12h',
      '24h',
    ]);

    const classifyOverride = (v: unknown): 'fixed' | 'interval' | 'none' => {
      const s = String(v ?? '').trim();
      if (!s) return 'none';
      if (fixedRegex.test(s)) return 'fixed';
      if (intervalKeys.has(s)) return 'interval';
      return 'none';
    };

    // 1) включённые templates пользователя
    const { data: tplRows, error: tplErr } = await supabase
      .from('message_templates')
      .select('id')
      .eq('user_id', userId)
      .eq('enabled', true);

    if (tplErr) {
      return {
        success: false,
        message: 'supabase_templates_error',
        error: tplErr,
      };
    }

    const templateIds = (tplRows ?? []).map((r: any) => String(r.id));
    const templatesTotalEnabled = templateIds.length;

    let activeTgAccountKey: string | null = null;
    /** Все TG-чаты в пуле текущего аккаунта (не только is_selected) — для legacy ∩ pool */
    const tgScopedNorm = new Set<string>();
    if (ch === 'tg') {
      activeTgAccountKey =
        await this.telegramService.getActiveTgAccountKey(userId);
      if (activeTgAccountKey) {
        const { data: poolRows } = await applyTelegramGroupsTgPhoneScope(
          supabase
            .from('telegram_groups')
            .select('tg_chat_id')
            .eq('user_id', userId),
          activeTgAccountKey,
        );
        for (const r of poolRows ?? []) {
          const raw = String((r as any)?.tg_chat_id ?? '').trim();
          if (raw) tgScopedNorm.add(this.normalizeTgChatIdKey(raw));
        }
      }
    }

    // 2) выбранные группы по каналу
    type SelectedGroup = { groupKey: string; groupJidRaw: string };
    const selectedGroups: SelectedGroup[] = [];

    if (ch === 'wa') {
      const { data: gRows, error: gErr } = await supabase
        .from('whatsapp_groups')
        .select('wa_group_id, send_time, is_announcement')
        .eq('user_id', userId)
        .eq('is_selected', true)
        .eq('is_announcement', false);

      if (gErr) {
        return {
          success: false,
          message: 'supabase_wa_groups_error',
          error: gErr,
        };
      }

      for (const r of gRows ?? []) {
        const gid = String(r?.wa_group_id ?? '').trim();
        if (!gid) continue;
        selectedGroups.push({ groupKey: gid, groupJidRaw: gid });
      }
    } else {
      if (!activeTgAccountKey) {
        /* нет активного tgid — не считаем выбранные TG-группы */
      } else {
        const { data: gRows, error: gErr } =
          await applyTelegramGroupsTgPhoneScope(
            supabase
              .from('telegram_groups')
              .select('tg_chat_id, send_time')
              .eq('user_id', userId)
              .eq('is_selected', true),
            activeTgAccountKey,
          );

        if (gErr) {
          return {
            success: false,
            message: 'supabase_tg_groups_error',
            error: gErr,
          };
        }

        for (const r of gRows ?? []) {
          const raw = String(r?.tg_chat_id ?? '').trim();
          if (!raw) continue;
          selectedGroups.push({
            groupKey: this.normalizeTgChatIdKey(raw),
            groupJidRaw: raw,
          });
        }
      }
    }

    const totalSelectedGroups = selectedGroups.length;
    const selectedSet = new Set(selectedGroups.map((g) => g.groupKey));

    if (!totalSelectedGroups || !templatesTotalEnabled) {
      return {
        success: true,
        channel: ch,
        templatesTotalEnabled,
        totalSelectedGroups,
        templatesWithAnyTargetsIntersect: 0,
        templatesWithAnySendTimeOverrideIntersect: 0,
        groupsCoveredByAnyTargets: 0,
        groupsWithSendTimeOverride: 0,
        groupsFixedOverride: 0,
        groupsIntervalOverride: 0,
        jobsFromTargets: 0,
        avgTargetsPerTemplate: 0,
      };
    }

    // 2.5) Есть ли вообще targets в системе для этого канала?
    // В backend это влияет на то, будут ли templates без targets отправлять в группы (hasAnyTargets).
    const anyTargetsSelect =
      ch === 'tg' && activeTgAccountKey
        ? 'template_id, group_jid, tg_account_key'
        : 'template_id';
    let anyQ = supabase
      .from('template_group_targets')
      .select(anyTargetsSelect)
      .eq('user_id', userId)
      .eq('channel', ch)
      .eq('enabled', true);
    if (ch === 'tg' && activeTgAccountKey) {
      anyQ = anyQ.in('tg_account_key', [
        activeTgAccountKey,
        LEGACY_TG_TEMPLATE_ACCOUNT_KEY,
      ]);
    }
    let { data: anyTargetsRows, error: anyTargetsErr } = await anyQ.limit(2000);
    if (
      anyTargetsErr &&
      ch === 'tg' &&
      isMissingTgAccountKeyColumn(anyTargetsErr)
    ) {
      const fb = await supabase
        .from('template_group_targets')
        .select('template_id, group_jid')
        .eq('user_id', userId)
        .eq('channel', ch)
        .eq('enabled', true)
        .limit(2000);
      anyTargetsRows = fb.data as typeof anyTargetsRows;
      anyTargetsErr = fb.error;
    }

    if (anyTargetsErr) {
      return {
        success: false,
        message: 'supabase_any_targets_error',
        error: anyTargetsErr,
      };
    }

    let hasAnyTargets = (anyTargetsRows ?? []).length > 0;
    if (ch === 'tg' && activeTgAccountKey && (anyTargetsRows ?? []).length) {
      hasAnyTargets = (anyTargetsRows ?? []).some((row: any) => {
        const acc = String(row?.tg_account_key ?? '').trim();
        const hasKey = 'tg_account_key' in row;
        const k = this.normalizeTgChatIdKey(String(row?.group_jid ?? ''));
        if (hasKey) {
          if (acc === activeTgAccountKey) return true;
          if (acc === LEGACY_TG_TEMPLATE_ACCOUNT_KEY && tgScopedNorm.has(k))
            return true;
          return false;
        }
        return tgScopedNorm.has(k);
      });
    }

    // Если targets вообще не включены — backend отправляет ВСЕ шаблоны во ВСЕ группы.
    if (!hasAnyTargets) {
      return {
        success: true,
        channel: ch,
        templatesTotalEnabled,
        totalSelectedGroups,
        templatesWithAnyTargetsIntersect: templatesTotalEnabled,
        templatesWithAnySendTimeOverrideIntersect: 0,
        groupsCoveredByAnyTargets: totalSelectedGroups,
        groupsWithSendTimeOverride: 0,
        groupsFixedOverride: 0,
        groupsIntervalOverride: 0,
        jobsFromTargets: totalSelectedGroups * templatesTotalEnabled,
        avgTargetsPerTemplate: totalSelectedGroups,
      };
    }

    // 3) targets пересекающиеся с включёнными templates (выбранные группы отфильтруем в памяти)
    let tq = supabase
      .from('template_group_targets')
      .select('template_id, group_jid, send_time_override, tg_account_key')
      .eq('user_id', userId)
      .eq('channel', ch)
      .eq('enabled', true)
      .in('template_id', templateIds);
    if (ch === 'tg' && activeTgAccountKey) {
      tq = tq.in('tg_account_key', [
        activeTgAccountKey,
        LEGACY_TG_TEMPLATE_ACCOUNT_KEY,
      ]);
    }
    let { data: tRows, error: tErr } = await tq;
    if (tErr && ch === 'tg' && isMissingTgAccountKeyColumn(tErr)) {
      const fb = await supabase
        .from('template_group_targets')
        .select('template_id, group_jid, send_time_override')
        .eq('user_id', userId)
        .eq('channel', ch)
        .eq('enabled', true)
        .in('template_id', templateIds);
      tRows = fb.data as typeof tRows;
      tErr = fb.error;
    }

    if (tErr) {
      return {
        success: false,
        message: 'supabase_targets_error',
        error: tErr,
      };
    }

    const templatesWithAnyTargetsIntersect = new Set<string>();
    const templatesWithAnySendTimeOverrideIntersect = new Set<string>();

    const templateGroupPairsCoveredByTargets = new Set<string>();

    const groupsCoveredByAnyTargets = new Set<string>();
    const groupsWithSendTimeOverride = new Set<string>();
    const groupsFixedOverride = new Set<string>();
    const groupsIntervalOverride = new Set<string>();

    for (const row of tRows ?? []) {
      const templateId = String(row?.template_id ?? '').trim();
      if (!templateId) continue;

      const rawJid = String(row?.group_jid ?? '').trim();
      const groupKey = ch === 'tg' ? this.normalizeTgChatIdKey(rawJid) : rawJid;
      if (!groupKey) continue;

      if (ch === 'tg' && activeTgAccountKey) {
        const acc = String((row as any)?.tg_account_key ?? '').trim();
        const hasKey = 'tg_account_key' in (row as any);
        if (hasKey) {
          if (acc === activeTgAccountKey) {
            /* scoped-строка */
          } else if (acc === LEGACY_TG_TEMPLATE_ACCOUNT_KEY) {
            if (!tgScopedNorm.has(groupKey)) continue;
          } else continue;
        } else if (!tgScopedNorm.has(groupKey)) continue;
      }

      if (!selectedSet.has(groupKey)) continue;

      templatesWithAnyTargetsIntersect.add(templateId);
      templateGroupPairsCoveredByTargets.add(`${templateId}|${groupKey}`);
      groupsCoveredByAnyTargets.add(groupKey);

      // WA: send_time_override не используется в планировании — не учитываем в метриках.
      const overrideType =
        ch === 'wa' ? 'none' : classifyOverride(row?.send_time_override);
      if (overrideType !== 'none') {
        groupsWithSendTimeOverride.add(groupKey);
        if (overrideType === 'fixed') groupsFixedOverride.add(groupKey);
        if (overrideType === 'interval') groupsIntervalOverride.add(groupKey);
        templatesWithAnySendTimeOverrideIntersect.add(templateId);
      }
    }

    return {
      success: true,
      channel: ch,
      templatesTotalEnabled,
      totalSelectedGroups,
      templatesWithAnyTargetsIntersect: templatesWithAnyTargetsIntersect.size,
      templatesWithAnySendTimeOverrideIntersect:
        templatesWithAnySendTimeOverrideIntersect.size,
      groupsCoveredByAnyTargets: groupsCoveredByAnyTargets.size,
      groupsWithSendTimeOverride: groupsWithSendTimeOverride.size,
      groupsFixedOverride: groupsFixedOverride.size,
      groupsIntervalOverride: groupsIntervalOverride.size,
      jobsFromTargets: templateGroupPairsCoveredByTargets.size,
      avgTargetsPerTemplate:
        templatesWithAnyTargetsIntersect.size > 0
          ? templateGroupPairsCoveredByTargets.size /
            templatesWithAnyTargetsIntersect.size
          : 0,
    };
  }

  async setTargets(
    userId: string,
    templateId: string,
    groupJids: string[],
    channel?: string,
    overrides?: any,
  ) {
    const supabase = this.supabaseService.getClient();
    const ch = this.normChannel(channel);
    this.logger.log(
      `[setTargets] userId=${userId} templateId=${templateId} channel=${ch} incoming=${Array.isArray(groupJids) ? groupJids.length : 0}`,
    );

    let tgAccountKeyForRow = LEGACY_TG_TEMPLATE_ACCOUNT_KEY;
    if (ch === 'tg') {
      const ak = await this.telegramService.getActiveTgAccountKey(userId);
      if (!ak) {
        return {
          success: false,
          message: 'no_active_tg_account',
        };
      }
      tgAccountKeyForRow = ak;
    }

    const unique = Array.from(
      new Set(
        (groupJids ?? []).map((x) => String(x || '').trim()).filter(Boolean),
      ),
    );

    let delQ = supabase
      .from('template_group_targets')
      .delete()
      .eq('user_id', userId)
      .eq('template_id', templateId)
      .eq('channel', ch);
    if (ch === 'tg') {
      // Старый UNIQUE (user, template, jid, channel) без tg_account_key: строка legacy ''
      // не удалялась при eq(tg_account_key, tgid:…), затем INSERT давал duplicate template_group_targets_uq.
      delQ = delQ.in('tg_account_key', [
        tgAccountKeyForRow,
        LEGACY_TG_TEMPLATE_ACCOUNT_KEY,
      ]);
    }
    let { error: delErr } = await delQ;

    if (delErr && ch === 'tg' && isMissingTgAccountKeyColumn(delErr)) {
      const r2 = await supabase
        .from('template_group_targets')
        .delete()
        .eq('user_id', userId)
        .eq('template_id', templateId)
        .eq('channel', ch);
      delErr = r2.error ?? null;
    }

    if (delErr) {
      this.logger.warn(
        `[setTargets] delete failed userId=${userId} templateId=${templateId} channel=${ch}: ${String(delErr?.message ?? delErr)}`,
      );
      return {
        success: false,
        message: 'supabase_targets_delete_error',
        error: delErr,
      };
    }

    if (!unique.length) {
      this.logger.warn(
        `[setTargets] empty targets userId=${userId} templateId=${templateId} channel=${ch} (all removed)`,
      );
      return { success: true, count: 0 };
    }

    const overridesObj: Record<string, any> =
      overrides && typeof overrides === 'object' ? overrides : {};

    const baseRows = unique.map((jid) => {
      const raw = overridesObj[jid];
      const ov =
        raw == null ? null : String(raw).trim() ? String(raw).trim() : null;
      return {
        user_id: userId,
        template_id: templateId,
        group_jid: jid,
        channel: ch,
        enabled: true,
        send_time_override: ch === 'wa' ? null : ov,
        tg_account_key: tgAccountKeyForRow,
        updated_at: new Date().toISOString(),
      };
    });

    let rowsToInsert: any[] = baseRows;
    let { error: insErr } = await supabase
      .from('template_group_targets')
      .insert(rowsToInsert);

    if (insErr && ch === 'tg' && isMissingTgAccountKeyColumn(insErr)) {
      rowsToInsert = baseRows.map(
        ({ tg_account_key: _t, ...row }: any) => row,
      );
      const r3 = await supabase
        .from('template_group_targets')
        .insert(rowsToInsert);
      insErr = r3.error ?? null;
    }

    if (insErr) {
      const msg = String(insErr?.message ?? insErr).toLowerCase();
      const missingOverride =
        msg.includes('send_time_override') ||
        (msg.includes('schema cache') &&
          msg.includes('template_group_targets'));

      if (missingOverride) {
        const fallbackRows = rowsToInsert.map(
          ({ send_time_override: _o, ...row }: any) => row,
        );
        const fallbackResult = await supabase
          .from('template_group_targets')
          .insert(fallbackRows);
        insErr = fallbackResult.error ?? null;
      }
    }

    if (insErr) {
      this.logger.warn(
        `[setTargets] insert failed userId=${userId} templateId=${templateId} channel=${ch}: ${String(insErr?.message ?? insErr)}`,
      );
      return {
        success: false,
        message: 'supabase_targets_insert_error',
        error: insErr,
      };
    }

    this.logger.log(
      `[setTargets] saved userId=${userId} templateId=${templateId} channel=${ch} count=${baseRows.length}`,
    );
    return { success: true, count: baseRows.length };
  }
}
