-- Выполнить в Supabase: Dashboard → SQL Editor → New query → вставить этот файл → Run
-- Объединяет: add_campaigns_paused + add_campaigns_and_jobs_indexes

-- 1) Пауза рассылок по каналу (WA/TG)
ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN campaigns.paused IS 'При true все рассылки этой кампании приостановлены (ЛК: кнопка Пауза/Play по каналу)';

-- 2) Индексы для campaigns и campaign_jobs
CREATE INDEX IF NOT EXISTS idx_campaigns_user_status_channel
ON campaigns(user_id, status, channel);

CREATE INDEX IF NOT EXISTS idx_campaigns_repeat_due
ON campaigns(repeat_enabled, status, paused, next_repeat_at)
WHERE repeat_enabled = true AND status = 'running' AND paused = false;

CREATE INDEX IF NOT EXISTS idx_campaign_jobs_campaign_status
ON campaign_jobs(campaign_id, status);

CREATE INDEX IF NOT EXISTS idx_campaign_jobs_campaign_scheduled
ON campaign_jobs(campaign_id, scheduled_at);

COMMENT ON INDEX idx_campaigns_user_status_channel IS 'Активная кампания по user_id и channel';
COMMENT ON INDEX idx_campaigns_repeat_due IS 'Повтор волн: кампании с next_repeat_at';
COMMENT ON INDEX idx_campaign_jobs_campaign_status IS 'Джобы по кампании и статусу';
COMMENT ON INDEX idx_campaign_jobs_campaign_scheduled IS 'Джобы по кампании с сортировкой по времени';

-- 3) Режим пауз между группами (шаблон × % или только min/max со страницы рассылок)
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS between_groups_scale_template boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN campaigns.between_groups_scale_template IS
  'true: пауза rand(min,max) затем × speed_factor шаблона; false: только min/max без множителя шаблона.';
