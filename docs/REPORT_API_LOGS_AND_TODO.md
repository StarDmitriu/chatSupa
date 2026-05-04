# Отчёт: API, логи, проблемы и что доделать

## 1. Куда и как направляются API

### Фронтенд → бэкенд
- **Базовый URL:** `process.env.NEXT_PUBLIC_BACKEND_URL || '/api'` (в проде часто прокси на бэкенд).
- **Вызовы:** через `apiGet` / `apiPost` в `frontend/src/lib/api.ts` с таймаутом и заголовком `Authorization: Bearer <token>`.

### Основные маршруты бэкенда (NestJS, без глобального префикса)

| Контроллер   | Маршруты (примеры) | Назначение |
|-------------|---------------------|------------|
| **auth**    | POST send-code, verify-code, GET me, POST update-profile | Коды, профиль |
| **templates** | GET list/:userId, get/:id, POST create, update, delete, upload-media, targets/set | Шаблоны и цели |
| **telegram** | POST qr/start, sync-groups, GET groups/:userId, groups/:userId/count, POST groups/select, groups/time | TG подключение и группы |
| **whatsapp** | POST start, sync-groups, GET groups/:userId, groups/:userId/count, POST groups/select, groups/time | WA подключение и группы |
| **campaigns** | GET active, list, :id/progress, POST start-multi, :id/stop, :id/requeue | Запуск рассылок и прогресс |
| **subscriptions** | GET me, POST start-trial, cancel | Подписки |
| **payments/prodamus** | POST create, webhook | Платежи |
| **admin**    | GET users, POST users/:id/block, grant-trial, … | Админка |

### Рассылка (как фиксируется и куда идёт)
1. Пользователь нажимает «Запустить» → фронт вызывает **POST /campaigns/start-multi** (channel, timeFrom, timeTo).
2. **CampaignsService** создаёт волну заданий в **campaign_jobs** и ставит джобы в очередь **BullMQ** (очередь `campaign-send`).
3. **CampaignBullWorker** (campaign.worker.ts) забирает джобы, для каждого:
   - читает job и шаблон из Supabase;
   - для **channel === 'tg'** вызывает **TelegramService.sendToGroup(userId, group_jid, { text, mediaUrl, sendMediaAsFile })**;
   - для **channel === 'wa'** — **WhatsappService.sendToGroup(...)**;
   - при успехе обновляет job: **status = 'sent'**, **sent_at**;
   - при ошибке — **status = 'failed'** (или оставляет **pending** при повторной попытке), пишет **error** в запись.

Итог: все API идут в NestJS-бэкенд; рассылка фиксируется в **campaign_jobs** (status, sent_at, error); фактическая отправка — только из воркера через TelegramService/WhatsappService.

---

## 2. Как пишутся логи

- **NestJS Logger** по сервисам: `[TelegramService]`, `[WhatsappService]`, `[CampaignsService]`, `[CampaignBullWorker]` и т.д.
- **Успех отправки:** `[TG sendToGroup] SUCCESS: text only / document / media … (userId=…, tgChatId=…, time=…ms)`.
- **Ошибки:** `this.logger.error('…', …)` — в лог попадает полное сообщение и контекст (userId, tgChatId, mediaUrl начало, время).
- **Медленные запросы:** `[TG getGroupsFromDb] SLOW QUERY: total=…ms (query=…, count=…, dedup=…ms) …`.
- **Воркер:** при завершении job — `completed bull job …`, при падении — `failed bull job …: <message>`.

В логах видно: кто (сервис), что (операция), по кому (userId, tgChatId/groupJid), результат (SUCCESS/FAILED) и при ошибке — текст и контекст.

---

## 3. Проблемы по логам (815–1028) и что сделано

### 3.1. CHANNEL_INVALID при отправке медиа в Telegram (критично)
- **Что в логах:** `[TG sendToGroup] FAILED: 400: CHANNEL_INVALID (caused by messages.SendMedia) (userId=…, tgChatId=-1003684956862, mediaUrl=…)`.
- **Причина:** для каналов/супергрупп (-100xxx) использовался ручной **InputPeerChannel** из БД (tg_access_hash). При **SendMedia** Telegram мог считать такой peer невалидным (устаревший/неверный access_hash или иная особенность SendMedia).
- **Что сделано:** для типа `channel` сначала вызывается **client.getInputEntity(rawId)**. Клиент сам резолвит peer (кэш или GetChannels), что даёт корректный InputPeer для SendMedia. При падении getInputEntity остаётся fallback на ручной InputPeerChannel из БД.
- **Рекомендация:** после деплоя прогнать рассылку с медиа в те же группы; при повторении CHANNEL_INVALID смотреть, есть ли в логах `getInputEntity(…) failed` и при необходимости доработать резолв (например, принудительный GetChannels по id).

### 3.2. Медленные запросы getGroupsFromDb (TG)
- **Что в логах:** `[TG getGroupsFromDb] SLOW QUERY: total=3301ms … (query=1172ms, count=2129ms)`, иногда total 5–8 сек при 673 группах.
- **Причина:** тяжёлый **COUNT(*)** и выборка с большим offset по **telegram_groups** (индексы есть, но при 673 записях и пагинации большие offset дороги).
- **Что можно сделать:**
  - курсорная пагинация по **updated_at** вместо offset (уже помечено в коде как возможная оптимизация);
  - отдельный лёгкий count (например, приближённый или кэшированный), чтобы не блокировать основной запрос.

### 3.3. Disconnecting
- **Что в логах:** `[Disconnecting...]` — штатное отключение TG-клиента (таймаут/реконнект или закрытие).
- Проблемой не считается, если после этого рассылки снова работают.

### 3.4. Как искать «третью» или другие проблемы по логам

Если по последним логам отдельной третьей проблемы не видно, имеет смысл просмотреть другие срезы:

- **По строкам логов:**
  - `FAILED` — все падения отправки (TG/WA); смотреть `userId`, `tgChatId`/`groupJid`, текст ошибки.
  - `CHAT_ADMIN_REQUIRED`, `CHAT_WRITE_FORBIDDEN`, `CHANNEL_PRIVATE`, `CHAT_SEND_DOCS_FORBIDDEN` — ограничения Telegram по группе/каналу; теперь фиксируются в БД (`last_send_error`) и отображаются в списках выбора групп.
  - `send_timeout`, `wa_not_connected`, `telegram_not_connected` — таймауты и отключения; смотреть, у какого пользователя и в какое время.
  - `failed bull job` — падения воркера рассылки; в сообщении есть причина.
  - `SLOW QUERY`, `SLOW SEND`, `SLOW MEDIA` — производительность; можно сопоставить с userId и временем.
- **По времени:** отфильтровать логи по временному диапазону другой рассылки или по часам пиковой нагрузки и повторить поиск по указанным строкам.
- **По пользователю:** если известен проблемный пользователь — искать по его `userId` во всех логах бэкенда (NestJS, воркер, TG/WA сервисы).

Итог: «третья» проблема может быть другим типом ошибки (например, массовый CHAT_WRITE_FORBIDDEN у одного пользователя) или тем же типом в другом временном срезе; поиск по ключевым словам и по userId/времени позволяет это выявить.

---

## 4. Что сейчас устроено нормально

- Маршрутизация API: фронт → один бэкенд, разделение по контроллерам и сервисам.
- Рассылка: одна очередь BullMQ, один воркер, статусы и ошибки пишутся в **campaign_jobs**.
- Логи: единый стиль, контекст (userId, channel, group, время), ошибки и медленные запросы видны.
- Резолв peer для TG при отправке медиа: переход на **getInputEntity** для каналов уменьшает риск CHANNEL_INVALID.

---

## 5. Что не доделано / желательно

- **Курсорная пагинация TG-групп** — убрать большие offset, снизить время getGroupsFromDb.
- **Отдельный мониторинг очереди** — метрики/алерты по длине очереди campaign-send и количеству failed jobs.
- **Повтор при CHANNEL_INVALID** — при такой ошибке можно один раз перерезолвить peer (getInputEntity) и повторить отправку перед тем как помечать job как failed.
- **Логирование версии воркера** — уже есть (`WORKER VERSION: 2026-01-03 …`), при смене логики рассылки версию стоит обновлять.

---

## 6. Что обязательно сделать

1. **Задеплоить правку CHANNEL_INVALID** (getInputEntity для каналов в sendToGroup) и проверить рассылку с медиа в супергруппы (-100xxx).
2. **Следить за логами** после деплоя: нет ли снова CHANNEL_INVALID, не появляются ли новые массовые ошибки (например, telegram_not_connected, wa_not_connected).
3. **При росте числа групп (TG)** — запланировать переход на курсорную пагинацию и/или ослабление тяжёлого count, чтобы не упираться в SLOW QUERY.

После выполнения п.1 и проверки рассылки с медиа цепочка «API → очередь → воркер → TG/WA → фиксация в campaign_jobs и логи» считается настроенной; остальное — улучшения производительности и наблюдаемости.
