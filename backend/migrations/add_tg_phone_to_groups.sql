-- Добавляем tg_phone для фильтрации Telegram-групп по номеру аккаунта
ALTER TABLE telegram_groups
  ADD COLUMN IF NOT EXISTS tg_phone text;

COMMENT ON COLUMN telegram_groups.tg_phone IS 'Номер Telegram (phone), с которого синхронизирована группа. Для фильтрации при нескольких подключённых аккаунтах.';

CREATE INDEX IF NOT EXISTS idx_telegram_groups_user_tg_phone
  ON telegram_groups(user_id, tg_phone)
  WHERE tg_phone IS NOT NULL;

COMMENT ON INDEX idx_telegram_groups_user_tg_phone IS 'Ускоряет фильтрацию Telegram-групп по номеру аккаунта.';

