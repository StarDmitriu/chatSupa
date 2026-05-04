-- Расставить created_at по порядку шаблонов: 1-й в списке — самая ранняя дата, 2-й на 1 мин позже, 3-й ещё на 1 мин…
-- Порядок: колонка "order" по возрастанию, затем sheet_row, затем id (как в списке шаблонов).
-- Перезаписывает created_at. Запускать в Supabase SQL Editor только когда это осознанно нужно.
--
-- Один пользователь (подставьте uuid Натальи) — выполните ТОЛЬКО этот блок:

/*
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      ORDER BY
        COALESCE("order", 2147483647) ASC,
        sheet_row ASC NULLS LAST,
        id ASC
    ) AS rn,
    COUNT(*) OVER () AS cnt
  FROM message_templates
  WHERE user_id = 'ВСТАВЬТЕ-UUID-ПОЛЬЗОВАТЕЛЯ'::uuid
)
UPDATE message_templates AS t
SET created_at = timezone('utc', now()) - ((r.cnt - r.rn) * interval '1 minute')
FROM ranked AS r
WHERE t.id = r.id;
*/

-- Все пользователи: у каждого свой порядок 1, 2, 3… по его шаблонам:

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY
        COALESCE("order", 2147483647) ASC,
        sheet_row ASC NULLS LAST,
        id ASC
    ) AS rn,
    COUNT(*) OVER (PARTITION BY user_id) AS cnt
  FROM message_templates
)
UPDATE message_templates AS t
SET created_at = timezone('utc', now()) - ((r.cnt - r.rn) * interval '1 minute')
FROM ranked AS r
WHERE t.id = r.id;
