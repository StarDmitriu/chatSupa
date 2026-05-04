-- Колонка created_at для списка шаблонов («Создан»). Без неё или без default новые шаблоны из ЛК остаются с NULL, пока не было рассылки.
-- Идемпотентно: безопасно выполнять повторно.

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

UPDATE message_templates
SET created_at = updated_at
WHERE created_at IS NULL AND updated_at IS NOT NULL;

UPDATE message_templates
SET created_at = now()
WHERE created_at IS NULL;

ALTER TABLE message_templates
  ALTER COLUMN created_at SET DEFAULT now();

COMMENT ON COLUMN message_templates.created_at IS 'Момент создания записи шаблона; для синка из таблицы не передаётся в upsert — обновляется только при INSERT';
