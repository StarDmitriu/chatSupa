# Полное исследование кодовой базы: экраны, таблицы, логика, типы, БД, производительность

**Дата:** 2026-03-08  
**Объём:** фронт (Next.js), бэкенд (NestJS), БД (Supabase/Postgres), очереди (BullMQ).

---

## 1. СТРУКТУРА ПРОЕКТА

### 1.1 Frontend (Next.js 16, React 19, App Router)

| Путь | Назначение |
|------|------------|
| `/` | Лендинг: hero, форма лида (имя, телефон, дата рождения, город, Telegram). |
| `/auth/phone`, `/auth/code`, `/auth/register` | Вход по SMS, верификация, регистрация. |
| `/dashboard` | Редирект на `/dashboard/campaigns`. |
| `/dashboard/campaigns` | Запуск/остановка рассылок (WA/TG), прогресс. |
| `/dashboard/groups` | Группы WhatsApp, фильтр по номеру, выбор групп. |
| `/dashboard/telegram-groups` | Группы Telegram, фильтр по номеру TG. |
| `/dashboard/templates`, `/new`, `/[templateId]` | Список, создание, редактирование шаблонов. |
| `/dashboard/analytics` | Аналитика. |
| `/cabinet` | Личный кабинет: WA/TG, Google Sheets, профиль, подписка. |
| `/cabinet/subscription` | Подписка, триал, оплата. |
| `/cabinet/support` | Поддержка. |
| `/admin` | Админка: пользователи, блокировка, триал, доступ. |

**Провайдеры:** `NotifyProvider`, `LoaderProvider` (глобальные).  
**API:** `lib/api.ts` — `apiGet`, `apiPost`, таймаут 20s, Bearer из cookie.  
**Состояние:** без Redux/Zustand; локальный state и cookie.

### 1.2 Backend (NestJS 11)

**Модули:** Auth, Supabase, Whatsapp, Templates, Campaigns, Queue, Sheets, Telegram, Admin, Payments, Leads. Subscriptions импортируется в Campaigns и Queue.

**Ключевые эндпоинты:** см. отчёт агента (auth, subscriptions, admin, campaigns, templates, whatsapp, telegram, sheets, payments, leads).  
**Глобальный префикс API** в `main.ts` не задан — роуты вида `/auth/...`, `/campaigns/...`.

### 1.3 База данных (Supabase/Postgres)

| Таблица | Назначение |
|---------|------------|
| **users** | Пользователи: phone, full_name, timezone, gsheet_url, is_admin, is_blocked. |
| **otp_codes** | Коды подтверждения по телефону (TTL). |
| **referrals** | Реферальные связи и награды. |
| **subscriptions** | Подписки: plan_code, trial, current_period_end, cancel_at_period_end. |
| **campaigns** | Кампании рассылки (channel, status, repeat_*, time_*). |
| **campaign_jobs** | Задачи кампаний (RLS включён, доступ через service_role). |
| **message_templates** | Шаблоны (text, media_url, send_media_as_file, wa/tg_speed_factor, wa/tg_default_send_time). |
| **template_group_targets** | Связь шаблон–группа (send_time_override). |
| **whatsapp_groups** | Группы WA (user_id, wa_phone, last_send_error). |
| **telegram_groups** | Группы TG (user_id, tg_phone, last_send_error, views/forwards/replies). |
| **payments** | Платежи Prodamus. |
| **lead_requests** | Лиды с лендинга. |

**Миграции:** в `backend/migrations/` и `supabase/migrations/` (индексы групп, RLS campaign_jobs, колонки tg_phone, wa_phone, last_send_error, timezone, send_media, stats TG, fix_duplicate_groups). Prisma не используется.

---

## 2. ЧТО ХОРОШО

- **Единый формат ответов API:** `{ success, message?, ... }`; фронт обрабатывает через `ApiError` и сообщения.
- **Подписка и доступ:** проверка trial/paid, блокировка, план по каналу (wa/tg/wa_tg); Guard на start-multi и requeue; проверка в воркере и в repeat волнах; админы обходят проверку.
- **Индексы БД:** есть для групп (user_id + updated_at, user_id + is_selected, wa_phone/tg_phone), ускоряют пагинацию и фильтры.
- **Пагинация и лимиты:** группы WA/TG и кампании с limit/range; константы JOBS_SELECT_LIMIT, GROUPS_SELECT_LIMIT, TARGETS_SELECT_LIMIT.
- **Кэширование:** in-memory с TTL в telegram/whatsapp (groupsCountCache 30s, avatar 1h, metadata 10min); снижает нагрузку на БД и API мессенджеров.
- **Очередь рассылки:** BullMQ, concurrency 1, lock 120s; повторные попытки при сбоях; при истечении подписки job помечается skipped.
- **Оплаты:** Prodamus webhook с проверкой подписи; обновление subscriptions и реферальные награды; без хардкода секретов.
- **Клиентские ошибки:** отправка в `/log-client-error` с message, stack, path; используется в error boundary.
- **Таймауты:** фронт api.ts 20s по умолчанию; воркер TG 90s, WA 60s.
- **Нормализация телефонов:** общая утилита phone.util (E164, storage); используется в auth, telegram, whatsapp, leads, prodamus, admin.

---

## 3. ЧТО ПЛОХО / НЕ ИДЕАЛЬНО

### 3.1 Типы и any (backend)

- **Сильное использование `any`:** telegram.service (~70+), whatsapp.service (~55+), campaigns.service (~45+), templates.service (~40+), prodamus (body/req), контроллеры (@Body() body: any, @Req() req: any). Ослаблена типобезопасность и рефакторинг.
- **Общие типы frontend/backend:** нет общего пакета; дублируются по смыслу (GroupRow, TemplateRow, ответы API). Риск рассинхрона при изменении API.

**Рекомендации:** ввести DTO с class-validator для всех публичных тел запросов; вынести общие типы в shared пакет или генерировать из OpenAPI.

### 3.2 Валидация ввода

- **ValidationPipe** включён глобально. Добавлен **StartCampaignDto** для `POST /campaigns/start-multi` с валидацией channel (IsIn ['wa','tg']), времени и числовых полей. Остальные эндпоинты по-прежнему с ручной проверкой; при необходимости можно добавить DTO по тому же образцу.

### 3.3 Производительность

- **templates.service:** для `listTemplates` добавлен `.limit(500)` на выборку шаблонов; для выборки по `campaign_jobs` для статистики добавлен `.limit(10_000)` и `.order('sent_at', { ascending: false })`.
- **N+1:** в whatsapp при фоновой подгрузке метаданных групп — батчи по GROUP_METADATA_BACKGROUND_BATCH_SIZE, но по сути N запросов; в campaign-repeat цикл по кампаниям с последовательным вызовом repeatWaveIfReady (N вызовов).
- **Frontend:** нет динамической подгрузки (dynamic(), React.lazy); крупные страницы (groups ~880 строк, templates/[templateId] ~1140 строк) увеличивают начальный бандл.
- **useEffect:** много эффектов с пустым deps или отключённым eslint-disable exhaustive-deps; возможны устаревшие замыкания или лишние запросы при изменении зависимостей.

**Рекомендации:** limit на listTemplates и выборки campaign_jobs; по возможности батчить повторные волны или ограничить число кампаний за тик; разбить тяжёлые страницы на подкомпоненты и lazy-загрузку; вынести общие типы/константы.

### 3.4 Обработка ошибок — **ЧАСТИЧНО ИСПРАВЛЕНО**

- **Prodamus webhook:** логика вынесена в `handleWebhookBody`; вызов обёрнут в try/catch. При ошибке логируется и возвращается `{ success: false, error: 'webhook_processing_error' }` (HTTP 200), без 500.
- **401 на фронте:** в `apiPost`, `apiPostForm`, `apiGet` при `res.status === 401` выполняется удаление cookie токена и редирект на `/auth/phone`.

### 3.5 Документация и конфиг — **ЧАСТИЧНО ИСПРАВЛЕНО**

- **Добавлен `frontend/.env.example`** с NEXT_PUBLIC_BACKEND_URL и комментарием по NEXT_RUNTIME.
- **SubscriptionsModule** не в AppModule — подключается только в CampaignsModule и QueueModule; при добавлении новых потребителей SubscriptionsService нужно не забыть импорт.

---

## 4. КРИТИЧНО

### 4.1 Отсутствие проверки JWT на эндпоинтах Telegram, WhatsApp, Templates — **ИСПРАВЛЕНО**

**Сделано:** На все маршруты `TelegramController`, `WhatsappController`, `TemplatesController` и `SheetsController` добавлен `@UseGuards(JwtAuthGuard)`. `userId` берётся только из `req.user.userId` (JWT). Для маршрутов с `:userId` в path вызывается проверка `ensureUserParam(req, paramUserId)` — при несовпадении возвращается 403 (user_id_mismatch). Для POST без path-параметра используется `authUserId(req)`. Фронт уже передаёт Bearer-токен в заголовках — дополнительных изменений не потребовалось.

### 4.2 Sheets и другие эндпоинты без JWT — **ИСПРАВЛЕНО**

- **SheetsController** (`POST /sheets/create`) — добавлен `JwtAuthGuard`, `userId` берётся из `req.user.userId`.

### 4.3 Публичный лог клиентских ошибок

- **POST /log-client-error** — без авторизации; любой может слать произвольные message/stack/url. Риск: спам, утечка путей и фрагментов кода в message. Допустимо оставить открытым, но ограничить размер тела и rate limit по IP.

---

## 5. СВОДНЫЕ ТАБЛИЦЫ

### 5.1 Защита маршрутов

| Модуль / Маршруты | JWT | Доп. проверка |
|-------------------|-----|----------------|
| Auth (login, code, register) | Нет (ожидаемо) | — |
| Subscriptions | Да | — |
| Campaigns | Да | SubscriptionGuard на start-multi, requeue |
| Admin | Да | AdminGuard, AdminPasswordGuard |
| Payments create | Да | — |
| Payments webhook | Нет (внешний вызов) | Подпись |
| **Telegram** | **Нет** | **Нет** |
| **WhatsApp** | **Нет** | **Нет** |
| **Templates** | **Нет** | **Нет** |
| Sheets | Нет | — |
| Leads | Нет (публичная форма) | — |
| App (log-client-error) | Нет | — |

### 5.2 Индексы БД (наличие)

- whatsapp_groups: user_id+updated_at, user_id+is_selected, user_id+wa_phone, user_id+is_announcement.
- telegram_groups: user_id+updated_at, user_id+is_selected, user_id+tg_phone.
- Остальные таблицы: полагаются на первичные ключи и типичные фильтры (user_id, campaign_id); при росте данных может понадобиться индексы по campaign_id, user_id для campaign_jobs и message_templates.

### 5.3 Зависимости (кратко)

- **Frontend:** Next 16, React 19, antd, js-cookie, qrcode.react. Без отдельного state-manager, без явного lazy для роутов.
- **Backend:** NestJS 11, Supabase, BullMQ, ioredis, Baileys (WA), telegram (GramJS), axios, papaparse, multer, class-validator/transformer, luxon, pino. Тяжёлые, но по назначению.

---

## 6. ПРИОРИТЕТЫ ИСПРАВЛЕНИЙ

1. **Критично:** Включить JWT и проверку владельца на всех эндпоинтах Telegram, WhatsApp, Templates (и при необходимости Sheets).
2. **Высокий:** Обернуть webhook Prodamus в try/catch; ввести DTO и валидацию для основных POST/PUT.
3. **Средний:** Ограничить listTemplates и выборки по campaign_jobs (limit); централизовать обработку 401 на фронте; добавить .env.example для фронта.
4. **Низкий:** Сократить использование any (типы/DTO); разбить крупные страницы и рассмотреть lazy; вынести общие типы API.

После устранения п.1 доступ к данным и действиям будет строго привязан к аутентифицированному пользователю.
