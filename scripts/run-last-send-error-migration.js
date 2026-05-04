#!/usr/bin/env node
/**
 * Миграция: last_send_error, last_send_error_at в telegram_groups и whatsapp_groups.
 * Требуется: SUPABASE_DB_URL в .env (Connection string из Dashboard → Database).
 * Запуск из корня: node scripts/run-last-send-error-migration.js
 */
const path = require('path');
const fs = require('fs');

try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });
} catch (_) {}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Не задана строка подключения к БД.');
    console.error('Добавьте в .env: SUPABASE_DB_URL=postgresql://postgres.[ref]:[PASSWORD]@...pooler.supabase.com:6543/postgres');
    console.error('Взять: Supabase Dashboard → Project → Settings → Database → Connection string (URI).');
    process.exit(1);
  }

  let pg;
  try {
    pg = require('pg');
  } catch (e) {
    try {
      pg = require(path.join(__dirname, '..', 'backend', 'node_modules', 'pg'));
    } catch (e2) {
      console.error('Установите pg: cd backend && npm install pg');
      process.exit(1);
    }
  }

  const sqlPath = path.join(__dirname, '../backend/migrations/add_last_send_error_groups.sql');
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
    console.log('Миграция add_last_send_error_groups выполнена.');
  } catch (err) {
    console.error('Ошибка:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
