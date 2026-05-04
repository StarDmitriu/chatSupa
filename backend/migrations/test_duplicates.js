#!/usr/bin/env node
/**
 * Тестовый скрипт для проверки дубликатов групп
 * 
 * Использование:
 *   node migrations/test_duplicates.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Ошибка: SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY должны быть установлены');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

async function checkDuplicates() {
  console.log('🔍 Проверка дубликатов групп...\n');

  try {
    // Проверка WhatsApp групп
    console.log('📱 WhatsApp группы:');
    const { data: waGroups, error: waError } = await supabase
      .from('whatsapp_groups')
      .select('user_id, wa_group_id, id, updated_at, subject')
      .order('updated_at', { ascending: false })
      .limit(10000);

    if (waError) {
      console.error('   ❌ Ошибка:', waError.message);
    } else {
      const waMap = new Map();
      const waDuplicates = [];
      
      waGroups?.forEach(g => {
        const key = `${g.user_id}_${g.wa_group_id}`;
        if (!waMap.has(key)) {
          waMap.set(key, []);
        }
        waMap.get(key).push(g);
      });

      waMap.forEach((groups, key) => {
        if (groups.length > 1) {
          waDuplicates.push({
            key,
            count: groups.length,
            groups: groups.map((g, idx) => ({
              index: idx,
              subject: g.subject,
              updated_at: g.updated_at
            }))
          });
        }
      });

      if (waDuplicates.length > 0) {
        console.log(`   ⚠️  Найдено ${waDuplicates.length} групп с дубликатами:`);
        waDuplicates.slice(0, 5).forEach(dup => {
          console.log(`      - ${dup.key}: ${dup.count} записей`);
          console.log(`        Последняя: "${dup.groups[0].subject}" (${dup.groups[0].updated_at})`);
        });
        if (waDuplicates.length > 5) {
          console.log(`      ... и еще ${waDuplicates.length - 5} групп`);
        }
      } else {
        console.log('   ✅ Дубликатов не найдено');
      }
    }

    // Проверка Telegram групп
    console.log('\n📲 Telegram группы:');
    const { data: tgGroups, error: tgError } = await supabase
      .from('telegram_groups')
      .select('user_id, tg_chat_id, updated_at, title')
      .order('updated_at', { ascending: false })
      .limit(10000);

    if (tgError) {
      console.error('   ❌ Ошибка:', tgError.message);
    } else {
      const tgMap = new Map();
      const tgDuplicates = [];
      
      tgGroups?.forEach(g => {
        const key = `${g.user_id}_${g.tg_chat_id}`;
        if (!tgMap.has(key)) {
          tgMap.set(key, []);
        }
        tgMap.get(key).push(g);
      });

      tgMap.forEach((groups, key) => {
        if (groups.length > 1) {
          tgDuplicates.push({
            key,
            count: groups.length,
            groups: groups.map((g, idx) => ({
              index: idx,
              title: g.title,
              updated_at: g.updated_at
            }))
          });
        }
      });

      if (tgDuplicates.length > 0) {
        console.log(`   ⚠️  Найдено ${tgDuplicates.length} групп с дубликатами:`);
        tgDuplicates.slice(0, 5).forEach(dup => {
          console.log(`      - ${dup.key}: ${dup.count} записей`);
          console.log(`        Последняя: "${dup.groups[0].title}" (${dup.groups[0].updated_at})`);
        });
        if (tgDuplicates.length > 5) {
          console.log(`      ... и еще ${tgDuplicates.length - 5} групп`);
        }
      } else {
        console.log('   ✅ Дубликатов не найдено');
      }
    }

    // Проверка уникальных индексов
    console.log('\n🔐 Проверка уникальных индексов:');
    console.log('   (Требуется выполнение SQL скрипта для создания индексов)');
    console.log('   Выполните: backend/migrations/fix_duplicate_groups.sql в Supabase SQL Editor\n');

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

checkDuplicates();
