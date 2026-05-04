# Ошибка синка TG групп: supabase_upsert_error

## Что изменилось

При ошибке сохранения групп Telegram в Supabase теперь:

1. **В логах бэкенда** пишется полная причина:
   - `[TG syncGroups] Supabase upsert error code=... message=... details=... hint=...`
   - Следующей строкой: `[TG syncGroups] Для пользователя: ...` — то же сообщение, которое видит пользователь.

2. **В ответе API** при `message: 'supabase_upsert_error'` добавлены поля:
   - `userMessage` — короткое пояснение для пользователя (по коду/тексту ошибки);
   - `errorCode` — код ошибки Postgres/PostgREST (например `42703`, `23505`).

3. **На фронте** (страница «Группы Telegram») при этой ошибке показывается `userMessage` или запасной текст: «Не удалось сохранить список групп в базу. Попробуйте ещё раз; если ошибка повторяется — обратитесь в поддержку.»

## Как искать причину

1. **Логи бэкенда**  
   `pm2 logs backend --err --lines 100` или  
   `grep "TG syncGroups" ~/.pm2/logs/backend-out-0.log`

   Ищите строку `[TG syncGroups] Supabase upsert error code=...`.

2. **Типичные коды и действия**

   | Код   | Значение              | Действие |
   |-------|------------------------|----------|
   | 42703 | column does not exist  | В БД нет колонки. Применить миграции: `add_telegram_groups_stats.sql`, `add_last_send_error_groups.sql`. После миграции есть автоматический повтор без колонок views_count/forwards_count/replies_count. |
   | 23505 | unique_violation       | Дубликат (user_id, tg_chat_id). Попросить пользователя нажать «Синхронизировать» ещё раз или проверить уникальный индекс `idx_telegram_groups_unique_user_group`. |
   | 23503 | foreign_key_violation  | Нет user_id в users. Проверить целостность данных. |
   | 42501 | permission denied     | RLS или права на таблицу. Проверить политики Supabase для сервисной роли. |

3. **Миграции**  
   Убедитесь, что в Supabase выполнены:
   - `add_telegram_groups_stats.sql` (views_count, forwards_count, replies_count);
   - `add_last_send_error_groups.sql` (last_send_error, last_send_error_at);
   - при дубликатах — `fix_duplicate_groups.sql` и уникальный индекс по (user_id, tg_chat_id).
