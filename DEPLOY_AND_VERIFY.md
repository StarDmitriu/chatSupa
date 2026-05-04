# Деплой и проверка после изменений

## Сборка (уже выполнена локально)

- **Backend:** `cd /var/www/backend && npm run build` — успешно.
- **Frontend:** `cd /var/www/frontend && npm run build` — успешно.

## Применение изменений на сайте

### Вариант A: Docker Compose (на сервере с Docker)

```bash
cd /var/www

# Пересобрать образы и перезапустить контейнеры
docker compose build backend frontend
docker compose up -d backend frontend

# Проверить статус
docker compose ps
docker compose logs -f backend --tail 50
```

### Вариант B: PM2 (на сервере с PM2)

```bash
cd /var/www

# Сборка (если ещё не собирали)
cd backend && npm run build && cd ..
cd frontend && npm run build && cd ..

# Перезапуск
pm2 restart all

# Или по отдельности
pm2 restart backend
pm2 restart frontend

# Проверка
pm2 status
pm2 logs backend --lines 30
```

---

## Проверка сценария: рассылка в TG с шаблоном с медиа

После деплоя один раз прогнать:

1. **Подготовка**
   - Убедиться, что в «Управлении группами» → Telegram выбраны 1–2 тестовые группы.
   - Создать или выбрать шаблон с прикреплённым медиа (картинка/видео/аудио).

2. **Запуск рассылки**
   - Перейти в **Рассылки**.
   - Режим: **Только TG** (или TG + WA, если нужно).
   - Нажать **Запустить**.

3. **Проверка логов бэкенда**
   - В логах **не должно** быть ошибки `CHANNEL_INVALID (caused by messages.SendMedia)`.
   - Должны быть строки вида:
     - `[TG sendToGroup] SUCCESS: media image` или `SUCCESS: media video` / `SUCCESS: audio` / `SUCCESS: text only`.

4. **Проверка в Telegram**
   - В выбранных группах должны прийти сообщения (текст и медиа по шаблону).

Если снова появится `CHANNEL_INVALID` — значит, на этом сервере уже применён фикс конвертации Bot API id → MTProto channelId в `backend/src/telegram/telegram.service.ts`; пересоберите и перезапустите backend и повторите сценарий.
