-- Постраничная выборка без OFFSET (избегаем statement timeout на больших смещениях).
-- Первый запрос: p_after_updated и p_after_chat = NULL.
-- Следующие: передать updated_at и tg_chat_id последней строки из предыдущего ответа (next_cursor).

CREATE OR REPLACE FUNCTION public.telegram_groups_keyset_page(
  p_user_id uuid,
  p_limit int,
  p_selected_only boolean DEFAULT false,
  p_tg_phone text DEFAULT NULL,
  p_after_updated timestamptz DEFAULT NULL,
  p_after_chat text DEFAULT NULL
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
      OR t.tg_phone = p_tg_phone
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

COMMENT ON FUNCTION public.telegram_groups_keyset_page(uuid, int, boolean, text, timestamptz, text) IS
  'Список telegram_groups по ключу (updated_at, tg_chat_id) без OFFSET; см. next_cursor в ответе API.';

GRANT EXECUTE ON FUNCTION public.telegram_groups_keyset_page(uuid, int, boolean, text, timestamptz, text)
  TO service_role, authenticated;

CREATE INDEX IF NOT EXISTS idx_telegram_groups_user_updated_chat
  ON public.telegram_groups (user_id, updated_at DESC NULLS LAST, tg_chat_id DESC);
