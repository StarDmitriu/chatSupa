-- Скрипт для исправления дубликатов групп и создания уникальных индексов
-- Выполните этот скрипт в Supabase SQL Editor

-- ============================================
-- 1. Проверка дубликатов WhatsApp групп
-- ============================================
-- Проверяем, есть ли дубликаты
SELECT 
    user_id, 
    wa_group_id, 
    COUNT(*) as count,
    array_agg(id ORDER BY updated_at DESC) as ids,
    array_agg(updated_at ORDER BY updated_at DESC) as updated_dates
FROM whatsapp_groups
GROUP BY user_id, wa_group_id
HAVING COUNT(*) > 1
ORDER BY count DESC;

-- ============================================
-- 2. Удаление дубликатов WhatsApp групп
-- ============================================
-- Оставляем только самую свежую запись для каждой пары (user_id, wa_group_id)
-- Удаляем старые дубликаты
DELETE FROM whatsapp_groups
WHERE id IN (
    SELECT id
    FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY user_id, wa_group_id 
                   ORDER BY updated_at DESC, id DESC
               ) as rn
        FROM whatsapp_groups
    ) t
    WHERE rn > 1
);

-- ============================================
-- 3. Проверка дубликатов Telegram групп
-- ============================================
SELECT 
    user_id, 
    tg_chat_id, 
    COUNT(*) as count,
    array_agg(id ORDER BY updated_at DESC) as ids,
    array_agg(updated_at ORDER BY updated_at DESC) as updated_dates
FROM telegram_groups
GROUP BY user_id, tg_chat_id
HAVING COUNT(*) > 1
ORDER BY count DESC;

-- ============================================
-- 4. Удаление дубликатов Telegram групп
-- ============================================
-- Оставляем только самую свежую запись для каждой пары (user_id, tg_chat_id)
DELETE FROM telegram_groups
WHERE id IN (
    SELECT id
    FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY user_id, tg_chat_id 
                   ORDER BY updated_at DESC, id DESC
               ) as rn
        FROM telegram_groups
    ) t
    WHERE rn > 1
);

-- ============================================
-- 5. Создание уникальных индексов (если их еще нет)
-- ============================================

-- Уникальный индекс для WhatsApp групп
-- Если индекс уже существует, команда не выполнится (безопасно)
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_groups_unique_user_group 
ON whatsapp_groups(user_id, wa_group_id);

-- Уникальный индекс для Telegram групп
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_groups_unique_user_group 
ON telegram_groups(user_id, tg_chat_id);

-- ============================================
-- 6. Проверка после очистки
-- ============================================
-- Проверяем, что дубликатов больше нет
SELECT 'WhatsApp groups duplicates:' as check_type, COUNT(*) as duplicates
FROM (
    SELECT user_id, wa_group_id, COUNT(*) as cnt
    FROM whatsapp_groups
    GROUP BY user_id, wa_group_id
    HAVING COUNT(*) > 1
) t
UNION ALL
SELECT 'Telegram groups duplicates:' as check_type, COUNT(*) as duplicates
FROM (
    SELECT user_id, tg_chat_id, COUNT(*) as cnt
    FROM telegram_groups
    GROUP BY user_id, tg_chat_id
    HAVING COUNT(*) > 1
) t;
