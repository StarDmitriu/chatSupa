-- Пауза рассылок по каналу (WA/TG): при paused=true воркер не отправляет, repeat не создаёт новые волны
ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN campaigns.paused IS 'При true все рассылки этой кампании приостановлены (ЛК: кнопка Пауза/Play по каналу)';
