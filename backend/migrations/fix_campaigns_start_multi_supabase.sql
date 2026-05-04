-- ============================================================================
-- Исправление ошибки supabase_campaign_insert_error при старте рассылки
-- Выполнить в Supabase: SQL Editor → New query → вставить → Run
-- Идемпотентно (можно запускать повторно).
--
-- Бэкенд вставляет: user_id, status, mode, time_from, time_to, timezone,
-- between_groups_sec_*, between_groups_scale_template, between_templates_*,
-- repeat_enabled, repeat_*, next_repeat_at, channel, paused (через DEFAULT).
-- ============================================================================

-- Базовые поля старых схем (если таблица без них)
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS repeat_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN campaigns.repeat_enabled IS 'Автоповтор волн по расписанию';

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS between_groups_sec_min integer NULL,
  ADD COLUMN IF NOT EXISTS between_groups_sec_max integer NULL;

COMMENT ON COLUMN campaigns.between_groups_sec_min IS 'Нижняя граница паузы между группами (сек)';
COMMENT ON COLUMN campaigns.between_groups_sec_max IS 'Верхняя граница паузы между группами (сек)';

-- Повтор волн + поля, которые отправляет startMulti (Nest / PostgREST)
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS repeat_schedule_kind text NULL,
  ADD COLUMN IF NOT EXISTS repeat_clock_time text NULL,
  ADD COLUMN IF NOT EXISTS repeat_min_min integer NULL,
  ADD COLUMN IF NOT EXISTS repeat_min_max integer NULL,
  ADD COLUMN IF NOT EXISTS next_repeat_at timestamptz NULL;

COMMENT ON COLUMN campaigns.repeat_schedule_kind IS 'minutes | next_day | clock_time; NULL если repeat_enabled=false';
COMMENT ON COLUMN campaigns.repeat_clock_time IS 'HH:mm для clock_time (часовой пояс campaigns.timezone); NULL иначе';
COMMENT ON COLUMN campaigns.repeat_min_min IS 'Для kind=minutes: нижняя граница интервала между волнами (минуты)';
COMMENT ON COLUMN campaigns.repeat_min_max IS 'Для kind=minutes: верхняя граница интервала между волнами (минуты)';
COMMENT ON COLUMN campaigns.next_repeat_at IS 'Когда планировать следующую волну (UTC timestamptz)';

-- Паузы между группами × speed_factor шаблона
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS between_groups_scale_template boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN campaigns.between_groups_scale_template IS
  'true: пауза rand(min,max) затем × speed_factor шаблона; false: только min/max без множителя шаблона.';

-- Пауза между шаблонами в одной волне (минуты, случайный выбор в диапазоне)
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS between_templates_min_min integer NULL,
  ADD COLUMN IF NOT EXISTS between_templates_min_max integer NULL;

COMMENT ON COLUMN campaigns.between_templates_min_min IS 'Минимальная пауза между шаблонами в волне (минуты)';
COMMENT ON COLUMN campaigns.between_templates_min_max IS 'Максимальная пауза между шаблонами в волне (минуты)';

-- Пауза по каналу из ЛК
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN campaigns.paused IS 'При true джобы кампании на паузе (кнопка в кабинете по каналу)';

-- Канал WA/TG (если таблица старая и колонки не было)
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS channel text NULL;

COMMENT ON COLUMN campaigns.channel IS 'wa | tg — канал рассылки';

-- Индексы для активной кампании и тика повтора (если ещё нет)
CREATE INDEX IF NOT EXISTS idx_campaigns_user_status_channel
  ON campaigns(user_id, status, channel);

CREATE INDEX IF NOT EXISTS idx_campaigns_repeat_due
  ON campaigns(repeat_enabled, status, paused, next_repeat_at)
  WHERE repeat_enabled = true AND status = 'running' AND paused = false;
