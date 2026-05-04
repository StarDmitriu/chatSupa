-- Миграция для оптимизации запросов групп
-- Создает составные индексы для ускорения пагинации и фильтрации

-- Индекс для WhatsApp групп: user_id + updated_at DESC
-- Ускоряет запросы с фильтрацией по user_id и сортировкой по updated_at
CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_user_updated 
ON whatsapp_groups(user_id, updated_at DESC);

-- Индекс для Telegram групп: user_id + updated_at DESC
-- Ускоряет запросы с фильтрацией по user_id и сортировкой по updated_at
CREATE INDEX IF NOT EXISTS idx_telegram_groups_user_updated 
ON telegram_groups(user_id, updated_at DESC);

-- Дополнительные индексы для часто используемых фильтров

-- Индекс для фильтрации по is_selected (используется в кампаниях)
CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_user_selected 
ON whatsapp_groups(user_id, is_selected) 
WHERE is_selected = true;

CREATE INDEX IF NOT EXISTS idx_telegram_groups_user_selected 
ON telegram_groups(user_id, is_selected) 
WHERE is_selected = true;

-- Индекс для фильтрации по is_announcement (только для WA)
CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_user_announcement 
ON whatsapp_groups(user_id, is_announcement) 
WHERE is_announcement = false;

-- Комментарии для документации
COMMENT ON INDEX idx_whatsapp_groups_user_updated IS 'Ускоряет пагинацию WhatsApp групп по user_id с сортировкой по updated_at';
COMMENT ON INDEX idx_telegram_groups_user_updated IS 'Ускоряет пагинацию Telegram групп по user_id с сортировкой по updated_at';
COMMENT ON INDEX idx_whatsapp_groups_user_selected IS 'Ускоряет выборку выбранных WhatsApp групп для кампаний';
COMMENT ON INDEX idx_telegram_groups_user_selected IS 'Ускоряет выборку выбранных Telegram групп для кампаний';
COMMENT ON INDEX idx_whatsapp_groups_user_announcement IS 'Ускоряет фильтрацию не-announcement WhatsApp групп';
