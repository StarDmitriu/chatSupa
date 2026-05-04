/**
 * Safe cleanup of problematic Telegram groups for Natalia.
 *
 * Default: dry-run (prints candidates only).
 * Apply changes: APPLY=true node scripts/natalia-tg-cleanup.cjs
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const NATALIA_USER_ID = 'f972f369-a9ca-44ad-97c9-52775caeec6c';
const TG_CAMPAIGN_ID = '7909f0e5-6cb1-4bbc-80a2-54e1e16c5213';
const THRESHOLD = Number(process.env.NATALIA_TG_FAIL_THRESHOLD || 3);
const APPLY = String(process.env.APPLY || '').toLowerCase() === 'true';

const PERMANENT_CODES = [
  'CHAT_WRITE_FORBIDDEN',
  'USER_BANNED_IN_CHANNEL',
  'CHAT_ADMIN_REQUIRED',
  'PEER_ID_INVALID',
  'CHANNEL_INVALID',
  'CHANNEL_PRIVATE',
];

function extractCode(err) {
  const s = String(err || '').toUpperCase();
  for (const code of PERMANENT_CODES) {
    if (s.includes(code)) return code;
  }
  return null;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is missing');
  const s = createClient(url, key);

  const { data, error } = await s
    .from('campaign_jobs')
    .select('group_jid,error,sent_at,status')
    .eq('campaign_id', TG_CAMPAIGN_ID)
    .eq('user_id', NATALIA_USER_ID)
    .eq('channel', 'tg')
    .eq('status', 'failed')
    .limit(10000);
  if (error) throw error;

  const byGroup = {};
  for (const row of data || []) {
    const g = String(row.group_jid || '').trim();
    if (!g) continue;
    const code = extractCode(row.error);
    if (!code) continue;
    if (!byGroup[g]) byGroup[g] = { total: 0, byCode: {} };
    byGroup[g].total += 1;
    byGroup[g].byCode[code] = (byGroup[g].byCode[code] || 0) + 1;
  }

  const candidates = Object.entries(byGroup)
    .filter(([, stats]) => stats.total >= THRESHOLD)
    .map(([tg_chat_id, stats]) => ({ tg_chat_id, ...stats }))
    .sort((a, b) => b.total - a.total);

  console.log(`Candidates threshold>=${THRESHOLD}: ${candidates.length}`);
  for (const c of candidates) {
    console.log(JSON.stringify(c));
  }

  if (!APPLY || candidates.length === 0) {
    console.log('DRY RUN (set APPLY=true to update telegram_groups.is_selected=false)');
    return;
  }

  const nowIso = new Date().toISOString();
  for (const c of candidates) {
    const topCode = Object.entries(c.byCode).sort((a, b) => b[1] - a[1])[0]?.[0] || 'PERMANENT_ERROR';
    const { error: updErr } = await s
      .from('telegram_groups')
      .update({
        is_selected: false,
        updated_at: nowIso,
        last_send_error: `auto_cleanup:${topCode}`,
        last_send_error_at: nowIso,
      })
      .eq('user_id', NATALIA_USER_ID)
      .eq('tg_chat_id', c.tg_chat_id);
    if (updErr) {
      console.warn(`FAILED ${c.tg_chat_id}: ${updErr.message || String(updErr)}`);
    } else {
      console.log(`UPDATED ${c.tg_chat_id}`);
    }
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});

