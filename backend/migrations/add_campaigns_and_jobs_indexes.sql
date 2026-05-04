-- Индексы для campaigns и campaign_jobs (запросы по user_id, status, channel, repeat, пагинация джобов)
-- Выполнить в Supabase SQL Editor или: node scripts/run-campaigns-paused-migration.js (отдельный скрипт для этой миграции)

-- campaigns: активная кампания по user + channel
CREATE INDEX IF NOT EXISTS idx_campaigns_user_status_channel
ON campaigns(user_id, status, channel);

-- campaigns: repeat watcher (status, paused, next_repeat_at)
CREATE INDEX IF NOT EXISTS idx_campaigns_repeat_due
ON campaigns(repeat_enabled, status, paused, next_repeat_at)
WHERE repeat_enabled = true AND status = 'running' AND paused = false;

-- campaign_jobs: выборка по кампании и статусу (progress, jobs list, requeue)
CREATE INDEX IF NOT EXISTS idx_campaign_jobs_campaign_status
ON campaign_jobs(campaign_id, status);

-- campaign_jobs: сортировка по scheduled_at в рамках кампании
CREATE INDEX IF NOT EXISTS idx_campaign_jobs_campaign_scheduled
ON campaign_jobs(campaign_id, scheduled_at);

COMMENT ON INDEX idx_campaigns_user_status_channel IS 'Активная кампания по user_id и channel';
COMMENT ON INDEX idx_campaigns_repeat_due IS 'Повтор волн: кампании с next_repeat_at';
COMMENT ON INDEX idx_campaign_jobs_campaign_status IS 'Джобы по кампании и статусу';
COMMENT ON INDEX idx_campaign_jobs_campaign_scheduled IS 'Джобы по кампании с сортировкой по времени';
