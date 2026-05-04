/**
 * Применяет миграцию tg_account_key + бэкфилл (нужен SUPABASE_DB_URL в .env).
 * Идемпотентность: миграция снимает старые UNIQUE и DROP CONSTRAINT IF EXISTS перед ADD.
 *
 *   node scripts/run-tg-account-key-migration.cjs
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runFile(client, rel) {
  const sql = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  console.log('---', rel, '---');
  await client.query(sql);
  console.log('--- ok ---');
}

(async () => {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error('Нужен SUPABASE_DB_URL (Settings → Database → URI).');
    process.exit(1);
  }
  const client = new Client({
    connectionString: url,
    statement_timeout: 120000,
  });
  await client.connect();
  try {
    await runFile(client, 'migrations/template_group_targets_tg_account_key.sql');
    await runFile(client, 'migrations/template_group_targets_tg_account_key_backfill.sql');
    const r = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE channel = 'tg' AND TRIM(COALESCE(tg_account_key, '')) = '')::int AS tg_legacy_remaining,
        COUNT(*) FILTER (WHERE channel = 'tg' AND TRIM(COALESCE(tg_account_key, '')) <> '')::int AS tg_scoped,
        COUNT(*)::int AS total_targets
      FROM public.template_group_targets
    `);
    console.log('counts:', r.rows[0]);
  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
