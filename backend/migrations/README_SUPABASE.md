# Миграции в Supabase

## Как выполнить

1. Откройте [Supabase Dashboard](https://supabase.com/dashboard) → ваш проект.
2. В левом меню: **SQL Editor** → **New query**.
3. Откройте файл `RUN_IN_SUPABASE.sql` (или скопируйте содержимое ниже) и вставьте в редактор.
4. Нажмите **Run** (или Ctrl+Enter).

### Ошибка старта рассылки (`supabase_campaign_insert_error`)

Выполните один раз **`fix_campaigns_start_multi_supabase.sql`** — добавляет все колонки таблицы `campaigns`, которые ожидает бэкенд при `POST /campaigns/start-multi` (повтор волн, паузы, канал, индексы). Повторный запуск безопасен.

## Один раз выполнить оба скрипта

Содержимое `RUN_IN_SUPABASE.sql` уже объединяет:
- `add_message_templates_send_media.sql` — колонка `send_media_as_file` в `message_templates`;
- `add_telegram_groups_stats.sql` — колонки `views_count`, `forwards_count`, `replies_count` в `telegram_groups`.

Используется `ADD COLUMN IF NOT EXISTS`, поэтому повторный запуск безопасен.

## RLS (Row Level Security)

Чтобы убрать предупреждение Supabase Lint «RLS Disabled in Public Entity» для `campaign_jobs`:

### Вариант А: из проекта (если есть строка подключения к БД)

1. В Supabase: **Dashboard** → ваш проект → **Settings** → **Database** → скопируйте **Connection string (URI)** (используйте пароль от БД).
2. В корне проекта или в `backend/` создайте/дополните `.env`:  
   `SUPABASE_DB_URL=postgresql://postgres.[project-ref]:[YOUR-PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres`
3. Из каталога backend выполните:  
   `npm run migrate:rls`

### Вариант Б: вручную в Supabase

1. Откройте **SQL Editor**:  
   https://supabase.com/dashboard/project/aomfbzhqxrijkvelyxkc/sql/new  
   (войдите в аккаунт Supabase, если нужно).
2. Откройте файл **`backend/migrations/enable_rls_campaign_jobs.sql`**, скопируйте его содержимое в редактор и нажмите **Run**.

Скрипт включает RLS и отзывает права у ролей `anon` и `authenticated`. Доступ к таблице остаётся у бэкенда: он использует **SUPABASE_SERVICE_ROLE_KEY**, который в Supabase обходит RLS. Повторный запуск безопасен.

## Если запросы к /count всё ещё падают

- Убедитесь, что фронт с `https://chatrassylka.ru` ходит на тот же домен (прокси на бэкенд) или на разрешённый API. В бэкенде CORS настроен как `origin: '*'`, запросы с любого домена допускаются.
- Проверьте в браузере (F12 → Network): на какой URL уходят запросы к `.../telegram/groups/.../count` и `.../whatsapp/groups/.../count`, и какой статус/ответ возвращается.
