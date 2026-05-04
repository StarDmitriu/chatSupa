#!/usr/bin/env node
/**
 * Применяет миграцию add_wa_phone_to_groups.sql в Supabase (таблица whatsapp_groups).
 *
 * Требуется: SUPABASE_DB_URL или DATABASE_URL в .env или окружении.
 * Запуск из корня backend: npm run migrate:wa-phone
 */
const path = require('path');
const fs = require('fs');

// Подгружаем .env из корня и backend (как в run-rls-migration)
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });
} catch (_) {}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Не задана строка подключения к БД (SUPABASE_DB_URL / DATABASE_URL).');
    console.error('Добавьте его в .env или передайте в окружении, как в run-rls-migration.');
    process.exit(1);
  }

  let pg;
  try {
    pg = require('pg');
  } catch (e) {
    console.error('Модуль pg не найден. Установите его: cd backend && npm install --save-dev pg');
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, '../backend/migrations/add_wa_phone_to_groups.sql');
  const raw = fs.readFileSync(sqlPath, 'utf8');
  const sql = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();

  if (!sql) {
    console.error('Файл add_wa_phone_to_groups.sql пуст — нечего применять.');
    process.exit(1);
  }

  async function runWithUrl(url) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const statement of statements) {
        if (statement) await client.query(statement + ';');
      }
      return true;
    } finally {
      await client.end().catch(() => {});
    }
  }

  try {
    console.log('Подключаемся к БД...');
    await runWithUrl(dbUrl);
    console.log('Миграция add_wa_phone_to_groups выполнена успешно.');
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('Tenant or user not found') && dbUrl.includes(':6543/')) {
      const url5432 = dbUrl.replace(':6543/', ':5432/');
      console.log('Пробуем Session mode (порт 5432)...');
      try {
        await runWithUrl(url5432);
        console.log('Миграция add_wa_phone_to_groups выполнена успешно (Session mode).');
      } catch (err2) {
        console.error('Ошибка при выполнении миграции:', err2.message || err2);
        process.exit(1);
      }
    } else {
      console.error('Ошибка при выполнении миграции add_wa_phone_to_groups:', msg);
      if (msg.includes('Tenant or user not found')) {
        console.error('Проверьте: Supabase Dashboard → Settings → Database → Connection string (URI). Скопируйте строку и пароль (Reset password при необходимости).');
      }
      process.exit(1);
    }
  }
}

main();

