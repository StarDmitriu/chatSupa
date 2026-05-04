import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BACKUP_CSV_HEADERS } from '../templates/templates.service';

type ScriptResponse = {
  success: boolean;
  spreadsheetId?: string;
  editUrl?: string;
  csvUrl?: string;
  message?: string;
};

@Injectable()
export class SheetsService {
  private readonly logger = new Logger(SheetsService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async createForUser(userId: string) {
    const supabase = this.supabaseService.getClient();

    // 0) если уже есть ссылка — можно вернуть её (чтобы не плодить таблицы)
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, gsheet_url')
      .eq('id', userId)
      .maybeSingle();

    if (userErr) {
      return {
        success: false,
        message: 'supabase_users_error',
        error: userErr,
      };
    }

    if (user?.gsheet_url) {
      return {
        success: true,
        alreadyExists: true,
        gsheet_url: user.gsheet_url,
      };
    }

    const url = process.env.APPS_SCRIPT_URL;
    const secret = process.env.APPS_SCRIPT_SECRET;

    if (!url || !secret) {
      return {
        success: false,
        message: 'APPS_SCRIPT_URL / APPS_SCRIPT_SECRET not set in .env',
      };
    }

    // 1) вызов Apps Script: передаём полную строку заголовков (все колонки бэкапа)
    const headerRow = (BACKUP_CSV_HEADERS as readonly string[]).slice();
    let resp: ScriptResponse;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret,
          userId,
          name: `WA Templates - ${userId}`,
          headers: headerRow,
        }),
      });

      const txt = await r.text();
      resp = JSON.parse(txt);

      if (!r.ok || !resp?.success || !resp.editUrl) {
        return {
          success: false,
          message: 'apps_script_error',
          details: resp?.message ?? txt?.slice(0, 300),
        };
      }
    } catch (e: any) {
      return {
        success: false,
        message: `apps_script_fetch_error: ${e?.message ?? e}`,
      };
    }

    // 2) пишем ссылку в users.gsheet_url
    const { error: upErr } = await supabase
      .from('users')
      .update({ gsheet_url: resp.editUrl })
      .eq('id', userId);

    if (upErr) {
      this.logger.error(upErr as any);
      return {
        success: false,
        message: 'supabase_update_user_error',
        error: upErr,
      };
    }

    return {
      success: true,
      gsheet_url: resp.editUrl,
      csv_url: resp.csvUrl,
      spreadsheetId: resp.spreadsheetId,
    };
  }
}
