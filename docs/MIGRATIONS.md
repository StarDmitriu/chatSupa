# Миграции БД (Supabase / PostgreSQL)

Миграции выполняются вручную: через **Supabase Dashboard → SQL Editor** или скриптами из папки `scripts/` (требуется `SUPABASE_DB_URL` или `DATABASE_URL` в `.env`).

**Один файл для копирования в SQL Editor:** `backend/migrations/APPLY_IN_SUPABASE_SQL_EDITOR.sql` — содержит паузу (paused) и индексы. Откройте его, скопируйте всё и выполните в Supabase → SQL Editor → Run.

## Обязательные миграции (порядок не критичен, если таблицы уже есть)

### 1. Пауза рассылок (campaigns.paused)

- **Файл:** `backend/migrations/add_campaigns_paused.sql`
- **Скрипт:** `cd backend && NODE_PATH=./node_modules node ../scripts/run-campaigns-paused-migration.js`
- **Вручную:** выполнить SQL из файла в Supabase SQL Editor.

Без этой миграции кнопки «Пауза»/«Возобновить» в ЛК и логика воркера/repeat не будут работать (колонка `paused` отсутствует).

### 2. Индексы для campaigns и campaign_jobs

- **Файл:** `backend/migrations/add_campaigns_and_jobs_indexes.sql`
- **Скрипт:** `cd backend && NODE_PATH=./node_modules node ../scripts/run-campaigns-indexes-migration.js`
- **Вручную:** выполнить SQL из файла в Supabase SQL Editor.

Ускоряет запросы активной кампании, повтор волн и выборку джобов. Рекомендуется применить на всех окружениях.

### Остальные миграции

См. файлы в `backend/migrations/` и `supabase/migrations/`. При первом развёртывании обычно выполняют все SQL из папок по порядку (или используют `RUN_IN_SUPABASE.sql` как справочник полей).

## Проверка

После применения `add_campaigns_paused`:

```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'campaigns' AND column_name = 'paused';
```

Должна вернуться одна строка `paused`.

После применения индексов:

```sql
SELECT indexname FROM pg_indexes WHERE tablename IN ('campaigns', 'campaign_jobs') AND indexname LIKE 'idx_%';
```

Должны быть индексы `idx_campaigns_user_status_channel`, `idx_campaigns_repeat_due`, `idx_campaign_jobs_campaign_status`, `idx_campaign_jobs_campaign_scheduled`.
