# Миграции базы данных

## Добавление индексов для оптимизации запросов групп

### Файл: `add_groups_indexes.sql`

Этот SQL файл создает индексы для ускорения запросов к таблицам `whatsapp_groups` и `telegram_groups`.

### Как применить:

1. **Через Supabase Dashboard:**
   - Откройте Supabase Dashboard → SQL Editor
   - Скопируйте содержимое файла `add_groups_indexes.sql`
   - Вставьте в SQL Editor и выполните

2. **Через psql (если есть прямой доступ к БД):**
   ```bash
   psql -h <your-supabase-host> -U postgres -d postgres -f add_groups_indexes.sql
   ```

3. **Через Supabase CLI:**
   ```bash
   supabase db push
   ```

### Что делают индексы:

1. **`idx_whatsapp_groups_user_updated`** и **`idx_telegram_groups_user_updated`**
   - Ускоряют пагинацию групп по `user_id` с сортировкой по `updated_at DESC`
   - Критично для быстрой загрузки групп при больших offset

2. **`idx_whatsapp_groups_user_selected`** и **`idx_telegram_groups_user_selected`**
   - Ускоряют выборку выбранных групп (`is_selected = true`) для кампаний
   - Частичные индексы (только для `is_selected = true`)

3. **`idx_whatsapp_groups_user_announcement`**
   - Ускоряет фильтрацию не-announcement групп
   - Частичный индекс (только для `is_announcement = false`)

### Ожидаемый эффект:

- **До индексов:** запросы с offset 300-500 занимают 1000-1700ms
- **После индексов:** запросы должны ускориться в 2-5 раз (200-500ms)

### Проверка индексов:

После применения можно проверить наличие индексов:

```sql
-- Проверка индексов для WhatsApp групп
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'whatsapp_groups' 
AND schemaname = 'public';

-- Проверка индексов для Telegram групп
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'telegram_groups' 
AND schemaname = 'public';
```
