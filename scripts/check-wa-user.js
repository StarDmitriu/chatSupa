#!/usr/bin/env node
/**
 * Проверка статуса WhatsApp и загрузки групп для пользователя (например, Наталья).
 * Ищет пользователя по full_name (содержит "наталь" или "natalia"), затем дергает API.
 * Требуется: .env или backend/.env с SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Опционально: BACKEND_URL или NEXT_PUBLIC_BACKEND_URL. На сервере: BACKEND_URL=http://127.0.0.1:3000.
 *
 * Использование:
 *   node scripts/check-wa-user.js              # найти по имени и проверить
 *   node scripts/check-wa-user.js <userId>     # проверить конкретный userId
 */
const path = require('path');
const fs = require('fs');

try {
  const dotenv = require('dotenv');
  const root = path.join(__dirname, '..');
  dotenv.config({ path: path.join(root, '.env.prod') });
  dotenv.config({ path: path.join(root, '.env') });
  dotenv.config({ path: path.join(root, 'backend', '.env') });
} catch (_) {}

const BACKEND_URL =
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (process.env.NODE_ENV !== 'production' ? 'http://127.0.0.1:3000' : 'https://api.chatrassylka.ru');

async function findUserByFullName() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Нужны SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в .env');
    return null;
  }
  let supabase;
  try {
    supabase = require('@supabase/supabase-js');
  } catch (e) {
    try {
      supabase = require(path.join(__dirname, '..', 'backend', 'node_modules', '@supabase/supabase-js'));
    } catch (e2) {
      console.error('Установите @supabase/supabase-js в backend');
      return null;
    }
  }
  const client = supabase.createClient(supabaseUrl, supabaseKey);
  const { data, error } = await client
    .from('users')
    .select('id, full_name, phone')
    .or('full_name.ilike.%наталь%,full_name.ilike.%натал%,full_name.ilike.%natalia%,full_name.ilike.%Наталья%,full_name.ilike.%Natalia%,full_name.ilike.%талья%,full_name.ilike.%талия%')
    .limit(5);
  if (error) {
    console.error('Supabase error:', error.message);
    return null;
  }
  if (!data || data.length === 0) {
    console.error('Пользователь с именем, содержащим "наталь"/"natalia"/"талья", не найден.');
    const { data: list } = await client.from('users').select('id, full_name, phone').limit(15).order('id', { ascending: false });
    if (list && list.length > 0) {
      console.error('\nПоследние пользователи (id, full_name, phone):');
      list.forEach((u) => console.error(`  ${u.id}  ${u.full_name || '-'}  ${u.phone || '-'}`));
      console.error('\nЗапустите: node scripts/check-wa-user.js <userId>');
    }
    return null;
  }
  return data[0];
}

async function checkWaStatus(userId) {
  const url = `${BACKEND_URL.replace(/\/$/, '')}/whatsapp/status/${userId}`;
  try {
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkWaGroups(userId, limit = 5, offset = 0) {
  const url = `${BACKEND_URL.replace(/\/$/, '')}/whatsapp/groups/${userId}?limit=${limit}&offset=${offset}`;
  try {
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  let userId = process.argv[2];
  let userLabel = userId || 'по имени';

  if (!userId) {
    console.log('Поиск пользователя по имени (наталь/natalia)...');
    const user = await findUserByFullName();
    if (!user) process.exit(1);
    userId = user.id;
    userLabel = `${user.full_name || user.phone || userId} (id=${userId})`;
    console.log('Найден:', userLabel);
  }

  console.log('\n--- WhatsApp status ---');
  const statusResult = await checkWaStatus(userId);
  if (statusResult.error) {
    console.error('Ошибка запроса status:', statusResult.error);
  } else {
    console.log('HTTP', statusResult.status, statusResult.data);
    const st = statusResult.data?.status;
    if (st === 'connected') {
      console.log('✓ WhatsApp подключен');
    } else {
      console.log('Статус сессии:', st || '(нет)');
    }
  }

  console.log('\n--- Группы (первые 5) ---');
  const groupsResult = await checkWaGroups(userId, 5, 0);
  if (groupsResult.error) {
    console.error('Ошибка запроса groups:', groupsResult.error);
  } else {
    console.log('HTTP', groupsResult.status);
    if (groupsResult.data?.success && Array.isArray(groupsResult.data.groups)) {
      const list = groupsResult.data.groups;
      const total = groupsResult.data.total ?? list.length;
      console.log(`Всего групп: ${total}, в ответе: ${list.length}`);
      list.slice(0, 5).forEach((g, i) => {
        console.log(`  ${i + 1}. ${g.subject || g.wa_group_id} (${g.wa_group_id})`);
      });
    } else {
      console.log('Ответ:', groupsResult.data);
    }
  }

  console.log('\nГотово.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
