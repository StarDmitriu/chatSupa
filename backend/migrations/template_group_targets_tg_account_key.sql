-- Run in Supabase SQL Editor (one transaction).
-- TG-таргеты шаблонов: привязка к аккаунту tgid:<id>; '' = legacy (до колонки), пересекается с текущим аккаунтом при чтении/волне.

ALTER TABLE public.template_group_targets
  ADD COLUMN IF NOT EXISTS tg_account_key text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.template_group_targets.tg_account_key IS
  'TG: tgid:<user_id> — таргет только для этого TG-аккаунта; пустая строка — legacy/общий на ЛК (учитывается только в пересечении с группами текущего tgid). WA: всегда пустая строка.';

-- Снять старые UNIQUE по (user_id, template_id, group_jid, channel), если есть — имена зависят от проекта.
DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'template_group_targets'
      AND c.contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE public.template_group_targets DROP CONSTRAINT IF EXISTS %I', con.conname);
  END LOOP;
END $$;

-- На случай уникального индекса без имени constraint (редко)
DROP INDEX IF EXISTS template_group_targets_user_id_template_id_group_jid_channel_key;

ALTER TABLE public.template_group_targets
  DROP CONSTRAINT IF EXISTS template_group_targets_user_template_jid_channel_account_key;

ALTER TABLE public.template_group_targets
  ADD CONSTRAINT template_group_targets_user_template_jid_channel_account_key
  UNIQUE (user_id, template_id, group_jid, channel, tg_account_key);
