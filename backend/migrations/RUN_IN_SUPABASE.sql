-- Выполнить в Supabase: SQL Editor → New query → вставить этот файл → Run
-- Обе миграции в одном файле для удобства.

-- 1) Колонка send_media_as_file для шаблонов
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS send_media_as_file boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN message_templates.send_media_as_file IS 'Если true — медиа отправляется как файл/документ; иначе как фото/видео/аудио';

-- 2) Статистика по группам Telegram (views, forwards, replies)
ALTER TABLE telegram_groups
  ADD COLUMN IF NOT EXISTS views_count integer,
  ADD COLUMN IF NOT EXISTS forwards_count integer,
  ADD COLUMN IF NOT EXISTS replies_count integer;

COMMENT ON COLUMN telegram_groups.views_count IS 'Просмотры последнего сообщения (из topMessage), в основном у каналов';
COMMENT ON COLUMN telegram_groups.forwards_count IS 'Пересылки последнего сообщения';
COMMENT ON COLUMN telegram_groups.replies_count IS 'Количество ответов (из topMessage.replies)';

-- 3) Гибкая настройка скорости/частоты по шаблону (WA/TG) + override интервала на уровне цели шаблона
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS wa_speed_factor integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS tg_speed_factor integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS wa_default_send_time text,
  ADD COLUMN IF NOT EXISTS tg_default_send_time text;

COMMENT ON COLUMN message_templates.wa_speed_factor IS 'Мультипликатор скорости планирования для WA (проценты, 100=по умолчанию). Влияет на паузу between_groups.';
COMMENT ON COLUMN message_templates.tg_speed_factor IS 'Мультипликатор скорости планирования для TG (проценты, 100=по умолчанию). Влияет на паузу between_groups.';
COMMENT ON COLUMN message_templates.wa_default_send_time IS 'Дефолтный send_time для WA именно для этого шаблона: ключ интервала (2-5m, 4h, ...) или фиксированное время HH:mm.';
COMMENT ON COLUMN message_templates.tg_default_send_time IS 'Дефолтный send_time для TG именно для этого шаблона: ключ интервала (2-5m, 4h, ...) или фиксированное время HH:mm.';

ALTER TABLE template_group_targets
  ADD COLUMN IF NOT EXISTS send_time_override text;

COMMENT ON COLUMN template_group_targets.send_time_override IS 'Переопределение send_time для пары шаблон-группа. Приоритет выше шаблонного дефолта и глобального send_time группы.';

-- 4) Persistent "limit learning" events (WA/TG) for weekly analysis
create table if not exists public.limit_learning_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  user_id uuid not null,
  channel text not null check (channel in ('wa', 'tg')),

  -- e.g. 'wa_rate_limit', 'tg_flood_wait'
  event_type text not null,

  -- optional numeric signal (e.g. flood-wait seconds, retry-after seconds)
  seconds integer,

  -- optional context fields for analysis
  campaign_id uuid,
  job_id uuid,
  group_jid text,
  template_id uuid,

  -- label from code-path (e.g. 'text_only', 'image', etc.)
  label text,

  -- short error message (truncated in app before insert)
  error text
);

create index if not exists idx_limit_learning_events_user_time
  on public.limit_learning_events (user_id, created_at desc);

create index if not exists idx_limit_learning_events_channel_time
  on public.limit_learning_events (channel, created_at desc);

create index if not exists idx_limit_learning_events_type_time
  on public.limit_learning_events (event_type, created_at desc);

comment on table public.limit_learning_events is
  'Accumulated observations of external rate limits (WA rate-overlimit/retry-after, TG FLOOD_WAIT, etc.) for weekly analysis.';

-- 4) Диапазон пауз между группами на шаблоне (сек), двухползунковый UI в кабинете
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS wa_between_groups_sec_min integer NULL,
  ADD COLUMN IF NOT EXISTS wa_between_groups_sec_max integer NULL,
  ADD COLUMN IF NOT EXISTS tg_between_groups_sec_min integer NULL,
  ADD COLUMN IF NOT EXISTS tg_between_groups_sec_max integer NULL;

COMMENT ON COLUMN message_templates.wa_between_groups_sec_min IS 'WA: нижняя граница паузы между группами (сек), в паре с max; если оба NULL — используется wa_speed_factor';
COMMENT ON COLUMN message_templates.wa_between_groups_sec_max IS 'WA: верхняя граница паузы между группами (сек)';
COMMENT ON COLUMN message_templates.tg_between_groups_sec_min IS 'TG: нижняя граница паузы между группами (сек), в паре с max';
COMMENT ON COLUMN message_templates.tg_between_groups_sec_max IS 'TG: верхняя граница паузы между группами (сек)';

-- 5) Режим повтора волн + поля для startMulti / CampaignRepeatService
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

-- 6) Остальное для вставки кампании (если ещё нет колонок)
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS between_groups_scale_template boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS between_templates_min_min integer NULL,
  ADD COLUMN IF NOT EXISTS between_templates_min_max integer NULL,
  ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS channel text NULL;

COMMENT ON COLUMN campaigns.between_groups_scale_template IS 'true: пауза × speed_factor шаблона';
COMMENT ON COLUMN campaigns.between_templates_min_min IS 'Мин. пауза между шаблонами в волне (мин)';
COMMENT ON COLUMN campaigns.between_templates_min_max IS 'Макс. пауза между шаблонами в волне (мин)';
COMMENT ON COLUMN campaigns.paused IS 'Пауза рассылки по каналу из ЛК';
COMMENT ON COLUMN campaigns.channel IS 'wa | tg';

CREATE INDEX IF NOT EXISTS idx_campaigns_user_status_channel
  ON campaigns(user_id, status, channel);

CREATE INDEX IF NOT EXISTS idx_campaigns_repeat_due
  ON campaigns(repeat_enabled, status, paused, next_repeat_at)
  WHERE repeat_enabled = true AND status = 'running' AND paused = false;

-- 7) Дата создания шаблона (колонка «Создан» в кабинете; ручное создание из ЛК)
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

COMMENT ON COLUMN message_templates.created_at IS 'Момент создания записи шаблона';
