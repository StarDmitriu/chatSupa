#!/usr/bin/env node
/**
 * Применяет индексы для campaigns и campaign_jobs (см. backend/migrations/add_campaigns_and_jobs_indexes.sql).
 * Требуется: SUPABASE_DB_URL или DATABASE_URL в .env (корень или backend).
 * Запуск: cd backend && NODE_PATH=./node_modules node ../scripts/run-campaigns-indexes-migration.js
 */
const path = require('path');
const fs = require('fs');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
} catch (_) {}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Не задана строка подключения: SUPABASE_DB_URL или DATABASE_URL в .env');
    process.exit(1);
  }

  const pg = require('pg');
  const sqlPath = path.join(__dirname, '../backend/migrations/add_campaigns_and_jobs_indexes.sql');
  const raw = fs.readFileSync(sqlPath, 'utf8');
  const sql = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();

  const client = new pg.Client({ connectionString: dbUrl });
  try {
    await client.connect();
    await client.query(sql);
    console.log('Миграция add_campaigns_and_jobs_indexes выполнена.');
  } catch (err) {
    console.error('Ошибка:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
