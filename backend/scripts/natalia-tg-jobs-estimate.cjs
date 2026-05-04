/**
 * Оценка числа TG jobs при createWaveAndEnqueue для пользователя (логика как в campaigns.service).
 * node scripts/natalia-tg-jobs-estimate.cjs [userId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const LEGACY = '';
const DEFAULT_USER = 'f972f369-a9ca-44ad-97c9-52775caeec6c';
const GROUPS_LIMIT = 50000;

function normalizeTgChatIdKey(jid) {
  const s = String(jid ?? '').trim();
  if (!s) return '';
  if (s.startsWith('-100')) return s;
  if (s.startsWith('-')) return s;
  if (/^\d+$/.test(s)) return `-100${s}`;
  return s;
}

async function getActiveKeyFromDb(s, userId) {
  const { data, error } = await s
    .from('telegram_groups')
    .select('tg_phone')
    .eq('user_id', userId)
    .like('tg_phone', 'tgid:%')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const key = String(data?.[0]?.tg_phone || '').trim().toLowerCase();
  return key.startsWith('tgid:') ? key : null;
}

async function main() {
  const userId = process.argv[2] || DEFAULT_USER;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');

  const s = createClient(url, key);
  const activeKey = await getActiveKeyFromDb(s, userId);
  if (!activeKey) {
    console.log(JSON.stringify({ userId, error: 'no_active_tg_key_in_db' }, null, 2));
    process.exit(1);
  }

  const nowMs = Date.now();
  let q = s
    .from('telegram_groups')
    .select(
      'tg_chat_id, send_time, quarantine_until, quarantine_reason, tg_phone',
    )
    .eq('user_id', userId)
    .eq('is_selected', true)
    .eq('tg_phone', activeKey);

  const { data: groups, error: gErr } = await q.limit(GROUPS_LIMIT);
  if (gErr) throw gErr;

  let usableGroups = (groups || [])
    .filter((g) => {
      const reason = String(g.quarantine_reason || '');
      if (reason.startsWith('stale_not_in_dialogs')) return false;
      const qu = g.quarantine_until;
      if (!qu) return true;
      const t = new Date(String(qu)).getTime();
      return !Number.isFinite(t) || t <= nowMs;
    })
    .map((g) => ({ jid: String(g.tg_chat_id) }));

  const seen = new Set();
  usableGroups = usableGroups.filter((g) => {
    const k = g.jid.trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const poolNorm = new Set(
    usableGroups.map((g) => normalizeTgChatIdKey(g.jid)).filter(Boolean),
  );

  const { data: templates, error: tErr } = await s
    .from('message_templates')
    .select('id')
    .eq('user_id', userId)
    .eq('enabled', true);
  if (tErr) throw tErr;
  const templateList = templates || [];

  let sel =
    'template_id, group_jid, send_time_override, tg_account_key';
  let tq = s
    .from('template_group_targets')
    .select(sel)
    .eq('user_id', userId)
    .eq('channel', 'tg')
    .eq('enabled', true)
    .in('tg_account_key', [activeKey, LEGACY])
    .limit(20000);

  let { data: links, error: lErr } = await tq;
  let missingCol = false;
  if (lErr && String(lErr.message || '').includes('tg_account_key')) {
    missingCol = true;
    const r2 = await s
      .from('template_group_targets')
      .select('template_id, group_jid, send_time_override')
      .eq('user_id', userId)
      .eq('channel', 'tg')
      .eq('enabled', true)
      .limit(20000);
    links = r2.data;
    lErr = r2.error;
  }
  if (lErr) throw lErr;

  if (!missingCol && (links || []).length) {
    const ak = activeKey;
    links = (links || []).filter((row) => {
      const acc = String(row.tg_account_key ?? '').trim();
      const hasCol = 'tg_account_key' in row;
      const k = normalizeTgChatIdKey(String(row.group_jid ?? ''));
      if (!k) return false;
      if (hasCol) {
        if (acc === ak) return true;
        if (acc === LEGACY) return poolNorm.has(k);
        return false;
      }
      return poolNorm.has(k);
    });
  } else if (missingCol) {
    links = (links || []).filter((row) => {
      const k = normalizeTgChatIdKey(String(row.group_jid ?? ''));
      return k && poolNorm.has(k);
    });
  }

  const hasAnyTargets = (links || []).length > 0;
  const targetsMap = new Map();
  for (const row of links || []) {
    const tid = String(row.template_id);
    const jidRaw = String(row.group_jid);
    const mapKey = normalizeTgChatIdKey(jidRaw);
    if (!mapKey) continue;
    if (!targetsMap.has(tid)) targetsMap.set(tid, new Set());
    targetsMap.get(tid).add(mapKey);
  }

  let totalJobs = 0;
  const perTemplate = [];
  for (const tpl of templateList) {
    const templateId = String(tpl.id);
    const selected = targetsMap.get(templateId);
    let n;
    if (selected) {
      n = usableGroups.filter((g) => {
        const keyNorm = normalizeTgChatIdKey(g.jid);
        return keyNorm && selected.has(keyNorm);
      }).length;
    } else if (hasAnyTargets) {
      n = 0;
    } else {
      n = usableGroups.length;
    }
    totalJobs += n;
    perTemplate.push({ templateId, jobs: n });
  }

  perTemplate.sort((a, b) => b.jobs - a.jobs);

  const out = {
    userId,
    at: new Date().toISOString(),
    activeTgAccountKey: activeKey,
    missingTgAccountKeyColumn: missingCol,
    enabledTemplates: templateList.length,
    usableSelectedGroups: usableGroups.length,
    hasAnyTargets,
    rawTargetsRowsAfterFilter: (links || []).length,
    estimatedNewWaveJobs: totalJobs,
    topTemplatesByJobs: perTemplate.slice(0, 15),
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
