-- Применить один раз в Supabase SQL Editor, если после «Сохранить» сбрасываются ползунки пауз в шаблоне
-- (бэкенд при отсутствии колонок делает повторный update без этих полей — success, но значения не в БД).
--
-- Диапазон пауз «между группами» в секундах для режима из шаблона (двухползунковый UI).
-- Если оба поля канала заданы — воркер берёт случайную паузу из [min,max] без умножения на wa_speed_factor/tg_speed_factor.
-- Если NULL — прежняя схема: пауза из кампании × коэфф. % из шаблона.

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS wa_between_groups_sec_min integer NULL,
  ADD COLUMN IF NOT EXISTS wa_between_groups_sec_max integer NULL,
  ADD COLUMN IF NOT EXISTS tg_between_groups_sec_min integer NULL,
  ADD COLUMN IF NOT EXISTS tg_between_groups_sec_max integer NULL;

COMMENT ON COLUMN message_templates.wa_between_groups_sec_min IS 'WA: нижняя граница паузы между группами (сек), в паре с max';
COMMENT ON COLUMN message_templates.wa_between_groups_sec_max IS 'WA: верхняя граница паузы между группами (сек)';
COMMENT ON COLUMN message_templates.tg_between_groups_sec_min IS 'TG: нижняя граница паузы между группами (сек), в паре с max';
COMMENT ON COLUMN message_templates.tg_between_groups_sec_max IS 'TG: верхняя граница паузы между группами (сек)';
