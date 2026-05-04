-- Запускать ПОСЛЕ template_group_targets_tg_account_key.sql (колонка tg_account_key уже есть).
-- Проставляет tg_account_key = telegram_groups.tg_phone (формат tgid:…) для строк
-- channel='tg' с legacy пустым ключом, если чат однозначно найден в telegram_groups.
-- Строки без матча остаются '' — их по-прежнему обрабатывает пересечение с пулом в коде.
-- Идемпотентно: повторный запуск обновляет только TRIM(tg_account_key) = ''.

UPDATE public.template_group_targets AS t
SET tg_account_key = TRIM(s.tg_phone)
FROM (
  SELECT DISTINCT ON (t_inner.ctid)
    t_inner.ctid,
    g.tg_phone
  FROM public.template_group_targets t_inner
  INNER JOIN public.telegram_groups g
    ON g.user_id = t_inner.user_id
    AND g.tg_phone IS NOT NULL
    AND TRIM(g.tg_phone) LIKE 'tgid:%'
    AND (
      TRIM(BOTH FROM g.tg_chat_id::text) = TRIM(BOTH FROM t_inner.group_jid)
      OR (
        TRIM(BOTH FROM t_inner.group_jid) ~ '^[0-9]+$'
        AND TRIM(BOTH FROM g.tg_chat_id::text)
          = ('-100' || TRIM(BOTH FROM t_inner.group_jid))
      )
    )
  WHERE t_inner.channel = 'tg'
    AND TRIM(COALESCE(t_inner.tg_account_key, '')) = ''
  ORDER BY t_inner.ctid, g.updated_at DESC NULLS LAST
) AS s
WHERE t.ctid = s.ctid
  AND NOT EXISTS (
    SELECT 1
    FROM public.template_group_targets x
    WHERE x.user_id = t.user_id
      AND x.template_id = t.template_id
      AND x.group_jid = t.group_jid
      AND x.channel = 'tg'
      AND TRIM(COALESCE(x.tg_account_key, '')) = TRIM(s.tg_phone)
      AND x.ctid <> t.ctid
  );

-- Сводка (опционально; закомментируйте если не нужно в логе)
-- SELECT
--   COUNT(*) FILTER (WHERE channel = 'tg' AND TRIM(COALESCE(tg_account_key, '')) = '') AS tg_legacy_remaining,
--   COUNT(*) FILTER (WHERE channel = 'tg' AND TRIM(COALESCE(tg_account_key, '')) <> '') AS tg_scoped
-- FROM public.template_group_targets;
