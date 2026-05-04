-- Статистика по последнему сообщению в диалоге: просмотры, пересылки, ответы
-- Полезно для супергрупп/каналов (-100...), где есть topMessage с этими полями
ALTER TABLE telegram_groups
  ADD COLUMN IF NOT EXISTS views_count integer,
  ADD COLUMN IF NOT EXISTS forwards_count integer,
  ADD COLUMN IF NOT EXISTS replies_count integer;

COMMENT ON COLUMN telegram_groups.views_count IS 'Просмотры последнего сообщения (из topMessage), в основном у каналов';
COMMENT ON COLUMN telegram_groups.forwards_count IS 'Пересылки последнего сообщения';
COMMENT ON COLUMN telegram_groups.replies_count IS 'Количество ответов (из topMessage.replies)';
