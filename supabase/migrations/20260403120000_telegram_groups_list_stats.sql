-- Статистика списка telegram_groups: строки БД vs уникальные чаты (счётчики в UI).
-- supabase db push / SQL Editor

ALTER TABLE public.telegram_groups
  ADD COLUMN IF NOT EXISTS tg_phone text;

COMMENT ON COLUMN public.telegram_groups.tg_phone IS
  'Номер Telegram (phone), с которого синхронизирована группа. Для фильтрации при нескольких подключённых аккаунтах.';

CREATE INDEX IF NOT EXISTS idx_telegram_groups_user_tg_phone
  ON public.telegram_groups (user_id, tg_phone)
  WHERE tg_phone IS NOT NULL;

COMMENT ON INDEX idx_telegram_groups_user_tg_phone IS
  'Ускоряет фильтрацию групп по номеру аккаунта.';

CREATE OR REPLACE FUNCTION public.telegram_groups_list_stats(
  p_user_id uuid,
  p_selected_only boolean DEFAULT false,
  p_tg_phone text DEFAULT NULL
)
RETURNS TABLE(row_count bigint, chat_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    COUNT(*)::bigint AS row_count,
    COUNT(DISTINCT tg_chat_id)::bigint AS chat_count
  FROM telegram_groups t
  WHERE t.user_id = p_user_id
    AND (NOT p_selected_only OR COALESCE(t.is_selected, false) = true)
    AND (
      p_tg_phone IS NULL
      OR trim(p_tg_phone) = ''
      OR t.tg_phone = p_tg_phone
    );
$$;

COMMENT ON FUNCTION public.telegram_groups_list_stats(uuid, boolean, text) IS
  'Для пагинации: row_count; для «всего групп» в UI: chat_count (уникальные tg_chat_id).';

GRANT EXECUTE ON FUNCTION public.telegram_groups_list_stats(uuid, boolean, text)
  TO service_role, authenticated;
