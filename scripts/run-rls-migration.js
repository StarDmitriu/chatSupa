#!/usr/bin/env node
/**
 * Выполняет миграцию RLS для campaign_jobs в Supabase.
 * Требуется: SUPABASE_DB_URL в .env или в окружении (Connection string из Dashboard → Database).
 * Запуск из корня: node scripts/run-rls-migration.js
 */
const path = require('path');
const fs = require('fs');

// Подгрузка .env из корня или backend
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });
} catch (_) {}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Не задана строка подключения к БД.');
    console.error('Добавьте в .env или передайте: SUPABASE_DB_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres');
    console.error('Взять: Supabase Dashboard → Project → Settings → Database → Connection string (URI).');
    process.exit(1);
  }

  let pg;
  try {
    pg = require('pg');
  } catch (e) {
    console.error('Установите pg: cd backend && npm install --save-dev pg');
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, '../backend/migrations/enable_rls_campaign_jobs.sql');
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
    console.log('Миграция enable_rls_campaign_jobs выполнена.');
  } catch (err) {
    console.error('Ошибка:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
