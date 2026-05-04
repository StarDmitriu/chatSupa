-- Ошибка последней отправки по группе (TG/WA): показываем в списках выбора групп
--
-- Способ 1: Supabase Dashboard → SQL Editor → New query → вставить этот файл → Run
--
-- Способ 2: из корня проекта (нужен SUPABASE_DB_URL в .env):
--   node scripts/run-last-send-error-migration.js

-- Telegram
ALTER TABLE telegram_groups
  ADD COLUMN IF NOT EXISTS last_send_error text,
  ADD COLUMN IF NOT EXISTS last_send_error_at timestamptz;

COMMENT ON COLUMN telegram_groups.last_send_error IS 'Текст последней ошибки отправки в эту группу (CHAT_ADMIN_REQUIRED, FloodWait и т.п.)';
COMMENT ON COLUMN telegram_groups.last_send_error_at IS 'Когда произошла последняя ошибка отправки';

-- WhatsApp
ALTER TABLE whatsapp_groups
  ADD COLUMN IF NOT EXISTS last_send_error text,
  ADD COLUMN IF NOT EXISTS last_send_error_at timestamptz;

COMMENT ON COLUMN whatsapp_groups.last_send_error IS 'Текст последней ошибки отправки в эту группу';
COMMENT ON COLUMN whatsapp_groups.last_send_error_at IS 'Когда произошла последняя ошибка отправки';
