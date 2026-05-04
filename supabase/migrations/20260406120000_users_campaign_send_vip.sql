-- Приоритет рассылок в BullMQ: объединяется с CAMPAIGN_VIP_USER_IDS в backend (CampaignVipService).
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS campaign_send_vip boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.campaign_send_vip IS 'Выше приоритет job в очередях campaign-send (вместе с env CAMPAIGN_VIP_USER_IDS).';
