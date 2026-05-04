# Инструкция по выполнению скрипта исправления дубликатов

## Способ 1: Через Supabase Dashboard (РЕКОМЕНДУЕТСЯ)

1. **Откройте Supabase Dashboard:**
   - Перейдите на https://supabase.com/dashboard
   - Выберите ваш проект

2. **Откройте SQL Editor:**
   - В левом меню найдите "SQL Editor"
   - Нажмите "New query"

3. **Скопируйте и выполните скрипт:**
   - Откройте файл `/var/www/backend/migrations/fix_duplicate_groups.sql`
   - Скопируйте ВЕСЬ содержимое файла
   - Вставьте в SQL Editor
   - Нажмите "Run" или `Ctrl+Enter`

4. **Проверьте результат:**
   - В результатах вы увидите количество найденных дубликатов
   - После выполнения DELETE - количество удаленных записей
   - В конце - проверку, что дубликатов больше нет (должно быть 0)

## Способ 2: Через psql (если есть доступ к БД)

```bash
# Установите пароль БД из Supabase Dashboard → Settings → Database
export PGPASSWORD="your-database-password"

# Выполните скрипт
psql -h db.aomfbzhqxrijkvelyxkc.supabase.co \
     -U postgres \
     -d postgres \
     -p 5432 \
     -f /var/www/backend/migrations/fix_duplicate_groups.sql
```

## Способ 3: Через Supabase CLI

```bash
# Установите Supabase CLI (если еще не установлен)
npm install -g supabase

# Войдите в аккаунт
supabase login

# Свяжите проект
supabase link --project-ref your-project-ref

# Выполните SQL файл
supabase db execute -f migrations/fix_duplicate_groups.sql
```

## Что делает скрипт:

1. **Проверяет дубликаты** - показывает какие группы дублируются
2. **Удаляет дубликаты** - оставляет только самую свежую запись (по `updated_at DESC`)
3. **Создает уникальные индексы** - предотвращает будущие дубликаты на уровне БД
4. **Проверяет результат** - убеждается, что дубликатов больше нет

## Важно:

- ⚠️ **Сделайте бэкап базы данных** перед выполнением DELETE операций
- Скрипт безопасен - использует `IF NOT EXISTS` для индексов
- Скрипт оставляет самую свежую запись (по `updated_at DESC`)
- После выполнения дубликаты будут предотвращены на уровне БД

## Проверка после выполнения:

Выполните этот запрос чтобы убедиться, что дубликатов нет:

```sql
SELECT 'WhatsApp duplicates:' as check_type, COUNT(*) as duplicates
FROM (
    SELECT user_id, wa_group_id, COUNT(*) as cnt
    FROM whatsapp_groups
    GROUP BY user_id, wa_group_id
    HAVING COUNT(*) > 1
) t
UNION ALL
SELECT 'Telegram duplicates:' as check_type, COUNT(*) as duplicates
FROM (
    SELECT user_id, tg_chat_id, COUNT(*) as cnt
    FROM telegram_groups
    GROUP BY user_id, tg_chat_id
    HAVING COUNT(*) > 1
) t;
```

Ожидаемый результат: обе строки должны показать `duplicates: 0`
