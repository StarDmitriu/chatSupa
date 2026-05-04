-- Режим планирования следующей волны: интервал в минутах | следующий календарный день | фиксированное время суток
-- Полный набор колонок для старта рассылки см. fix_campaigns_start_multi_supabase.sql
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS repeat_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS between_groups_sec_min integer NULL,
  ADD COLUMN IF NOT EXISTS between_groups_sec_max integer NULL,
  ADD COLUMN IF NOT EXISTS repeat_schedule_kind text NULL,
  ADD COLUMN IF NOT EXISTS repeat_clock_time text NULL,
  ADD COLUMN IF NOT EXISTS repeat_min_min integer NULL,
  ADD COLUMN IF NOT EXISTS repeat_min_max integer NULL,
  ADD COLUMN IF NOT EXISTS next_repeat_at timestamptz NULL;

COMMENT ON COLUMN campaigns.repeat_enabled IS 'Автоповтор волн по расписанию';
COMMENT ON COLUMN campaigns.between_groups_sec_min IS 'Нижняя граница паузы между группами (сек)';
COMMENT ON COLUMN campaigns.between_groups_sec_max IS 'Верхняя граница паузы между группами (сек)';
COMMENT ON COLUMN campaigns.repeat_schedule_kind IS 'minutes | next_day | clock_time; NULL если repeat_enabled=false';
COMMENT ON COLUMN campaigns.repeat_clock_time IS 'HH:mm для clock_time (часовой пояс campaigns.timezone); NULL иначе';
COMMENT ON COLUMN campaigns.repeat_min_min IS 'Для kind=minutes: нижняя граница интервала (минуты)';
COMMENT ON COLUMN campaigns.repeat_min_max IS 'Для kind=minutes: верхняя граница интервала (минуты)';
COMMENT ON COLUMN campaigns.next_repeat_at IS 'Когда планировать следующую волну (UTC)';
