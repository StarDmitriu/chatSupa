-- Включать в выборку строки с tg_phone IS NULL вместе с активным аккаунтом (legacy / до бэкфилла).
-- Убирает «пустой список» при getMe=tgid:X, а в БД ещё NULL.

DROP FUNCTION IF EXISTS public.telegram_groups_keyset_page(uuid, int, boolean, text, timestamptz, text);

CREATE OR REPLACE FUNCTION public.telegram_groups_keyset_page(
  p_user_id uuid,
  p_limit int,
  p_selected_only boolean DEFAULT false,
  p_tg_phone text DEFAULT NULL,
  p_after_updated timestamptz DEFAULT NULL,
  p_after_chat text DEFAULT NULL,
  p_include_unassigned boolean DEFAULT false
)
RETURNS SETOF telegram_groups
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT t.*
  FROM telegram_groups t
  WHERE t.user_id = p_user_id
    AND (NOT p_selected_only OR COALESCE(t.is_selected, false) = true)
    AND (
      p_tg_phone IS NULL
      OR trim(p_tg_phone) = ''
      OR (
        COALESCE(p_include_unassigned, false)
        AND (t.tg_phone = p_tg_phone OR t.tg_phone IS NULL)
      )
      OR (
        NOT COALESCE(p_include_unassigned, false)
        AND t.tg_phone = p_tg_phone
      )
    )
    AND (
      (p_after_updated IS NULL AND p_after_chat IS NULL)
      OR (
        p_after_updated IS NOT NULL
        AND p_after_chat IS NOT NULL
        AND ROW(
          COALESCE(t.updated_at, '-infinity'::timestamptz),
          t.tg_chat_id::text
        ) < ROW(p_after_updated, p_after_chat)
      )
    )
  ORDER BY t.updated_at DESC NULLS LAST, t.tg_chat_id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
$$;

COMMENT ON FUNCTION public.telegram_groups_keyset_page(uuid, int, boolean, text, timestamptz, text, boolean) IS
  'Список telegram_groups по ключу (updated_at, tg_chat_id) без OFFSET; p_include_unassigned — также строки с tg_phone NULL.';

GRANT EXECUTE ON FUNCTION public.telegram_groups_keyset_page(uuid, int, boolean, text, timestamptz, text, boolean)
  TO service_role, authenticated;

DROP FUNCTION IF EXISTS public.telegram_groups_list_stats(uuid, boolean, text);

CREATE OR REPLACE FUNCTION public.telegram_groups_list_stats(
  p_user_id uuid,
  p_selected_only boolean DEFAULT false,
  p_tg_phone text DEFAULT NULL,
  p_include_unassigned boolean DEFAULT false
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
      OR (
        COALESCE(p_include_unassigned, false)
        AND (t.tg_phone = p_tg_phone OR t.tg_phone IS NULL)
      )
      OR (
        NOT COALESCE(p_include_unassigned, false)
        AND t.tg_phone = p_tg_phone
      )
    );
$$;

COMMENT ON FUNCTION public.telegram_groups_list_stats(uuid, boolean, text, boolean) IS
  'Статистика списка telegram_groups; p_include_unassigned учитывает tg_phone IS NULL.';

GRANT EXECUTE ON FUNCTION public.telegram_groups_list_stats(uuid, boolean, text, boolean)
  TO service_role, authenticated;
