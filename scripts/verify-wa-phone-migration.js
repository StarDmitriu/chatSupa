#!/usr/bin/env node
/**
 * Проверяет, применена ли миграция wa_phone (колонка в whatsapp_groups).
 * Использует SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (без доступа к БД).
 * Запуск: node scripts/verify-wa-phone-migration.js или из backend: npm run migrate:wa-phone:verify
 */
const path = require('path');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
} catch (_) {}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Нужны SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в .env');
    process.exit(1);
  }

  let supabase;
  try {
    supabase = require('@supabase/supabase-js').createClient(url, key);
  } catch (e) {
    console.error('Модуль @supabase/supabase-js не найден. Запустите из backend или установите в корне.');
    process.exit(1);
  }

  const { data, error } = await supabase
    .from('whatsapp_groups')
    .select('wa_phone')
    .limit(1);

  if (error) {
    const msg = String(error.message || error);
    if (msg.includes('wa_phone') || msg.includes('column') || msg.includes('does not exist')) {
      console.log('Проверка: колонка wa_phone отсутствует. Примените миграцию (npm run migrate:wa-phone или SQL в Supabase).');
      process.exit(2);
    }
    console.error('Ошибка проверки:', msg);
    process.exit(1);
  }

  console.log('Проверка: колонка wa_phone есть, миграция применена.');
  process.exit(0);
}

main();
