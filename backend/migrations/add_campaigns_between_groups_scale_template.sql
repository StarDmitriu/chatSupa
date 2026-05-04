-- Режим пауз между группами: множитель на speed_factor шаблона (true) или только пауза из min/max (false, «страница рассылок»).
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS between_groups_scale_template boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN campaigns.between_groups_scale_template IS
  'Если true — случайная пауза между between_groups_sec_min/max затем × wa/tg_speed_factor шаблона. Если false — только between_groups_sec_min/max (без множителя шаблона).';
