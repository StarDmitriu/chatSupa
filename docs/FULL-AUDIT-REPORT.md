# Полный отчёт исследования проекта

**Дата:** 2026-03-08  
**Объём:** все экраны, элементы, таблицы, логика, код, импорты, зависимости, типы, БД, скорость, оптимизации.

---

## 1. Структура проекта и стек

| Компонент | Технологии |
|-----------|-------------|
| **Корень** | Монорепо без корневого package.json |
| **Frontend** | Next.js 16, React 19, порт 3001, Ant Design (частично), standalone build |
| **Backend** | NestJS 11, порт 3000, Supabase (PostgreSQL), BullMQ, Redis |
| **Интеграции** | WhatsApp (Baileys), Telegram (MTProto), Prodamus, Google Sheets |

**Конфиги:** `frontend/next.config.ts` (rewrites `/api/*` → backend), `docker-compose.yml`, Dockerfile в frontend/ и backend/.

---

## 2. Экраны (Frontend) — маршруты и элементы

### 2.1 Список всех маршрутов (17)

| Маршрут | Файл | Назначение |
|---------|------|------------|
| `/` | `app/page.tsx` | Главная (лендинг) |
| `/auth/phone` | `app/auth/phone/page.tsx` | Ввод телефона |
| `/auth/code` | `app/auth/code/page.tsx` | Ввод кода из SMS |
| `/auth/register` | `app/auth/register/page.tsx` | Регистрация (реферал) |
| `/admin` | `app/admin/page.tsx` | Админка (пользователи, подписки) |
| `/dashboard` | `app/dashboard/page.tsx` | Дашборд |
| `/dashboard/campaign` | `app/dashboard/campaign/page.tsx` | Запуск одной рассылки |
| `/dashboard/campaigns` | `app/dashboard/campaigns/page.tsx` | Список/управление рассылками |
| `/dashboard/analytics` | `app/dashboard/analytics/page.tsx` | Аналитика |
| `/dashboard/groups` | `app/dashboard/groups/page.tsx` | Группы WhatsApp |
| `/dashboard/telegram-groups` | `app/dashboard/telegram-groups/page.tsx` | Группы Telegram |
| `/dashboard/templates` | `app/dashboard/templates/page.tsx` | Список шаблонов |
| `/dashboard/templates/new` | `app/dashboard/templates/new/page.tsx` | Создание шаблона |
| `/dashboard/templates/[templateId]` | `app/dashboard/templates/[templateId]/page.tsx` | Редактирование шаблона |
| `/cabinet` | `app/cabinet/page.tsx` | Личный кабинет (подписка, WA/TG, пауза, профиль) |
| `/cabinet/subscription` | `app/cabinet/subscription/page.tsx` | Подписка |
| `/cabinet/support` | `app/cabinet/support/page.tsx` | Поддержка |

### 2.2 Layout и глобальные элементы

- **Корневой layout:** `app/layout.tsx` — шрифт Manrope, `NotifyProvider`, `LoaderProvider`, `globals.css`, критичные inline-стили в `<head>`.
- **Вложенные layout:** `dashboard/groups/layout.tsx`, `dashboard/telegram-groups/layout.tsx`, `dashboard/templates/new/layout.tsx`.
- **Middleware:** отсутствует — защита маршрутов через редирект при 401 в `lib/api.ts` (apiPost/apiGet снимают cookie и делают `window.location.href = '/auth/phone'`).

### 2.3 Компоненты (14 основных)

- `WhatsappConnectBlock`, `TelegramQrConnect` — подключение WA/TG, кнопки Пауза/Возобновить.
- `CampaignBlock`, `TemplatesSyncBlock`, `SheetsBlock` — блоки в ЛК/дашборде.
- `TemplateRichEditor`, `ChannelIcon`, `MediaViewerModal`, `WhatsappLinkingSteps`, `TelegramLinkingSteps`.

### 2.4 Запросы к API и авторизация

- Токен: `Cookies.get('token')`, заголовок `Authorization: Bearer ${token}`.
- Централизованные обёртки: `lib/api.ts` — `apiPost`, `apiPostForm`, `apiGet` с таймаутом 20 с, единой обработкой 401 (редирект на `/auth/phone`) и сетевыми ошибками.
- Часть страниц (groups, telegram-groups, campaigns, templates, admin) дополнительно передают token в fetch вручную.

---

## 3. Backend — модули, эндпоинты, логика

### 3.1 Модули (11)

`auth`, `admin`, `campaigns`, `queue`, `templates`, `sheets`, `telegram`, `whatsapp`, `subscriptions`, `payments` (Prodamus), `leads`, `supabase`.

### 3.2 Контроллеры и защита

| Контроллер | Префикс | Охрана | Проверка владельца |
|------------|---------|--------|---------------------|
| AppController | `/` | нет | — |
| AuthController | `/auth` | частично (me, update-profile — JWT) | — |
| AdminController | `/admin` | JWT + AdminGuard + AdminPasswordGuard | — |
| CampaignsController | `/campaigns` | JWT; start-multi, requeue — + SubscriptionGuard | по userId из JWT |
| TemplatesController | `/templates` | JWT | ensureUserParam / template.user_id |
| SheetsController | `/sheets` | JWT | — |
| TelegramController | `/telegram` | JWT | ensureUserParam(paramUserId) |
| WhatsappController | `/whatsapp` | JWT | ensureUserParam(paramUserId) |
| SubscriptionsController | `/subscriptions` | JWT | — |
| ProdamusController | `/payments/prodamus` | create — JWT; webhook — подпись | — |
| LeadsController | `/leads` | **нет** | — (публичная форма лидов) |

- **Публичные эндпоинты:** `POST /log-client-error` (без ограничений по телу), `POST /leads` (с проверкой consent_personal), `POST /payments/prodamus/webhook` (проверка подписи).
- **userId в URL:** везде, где есть `:userId`, проверяется через `ensureUserParam(req, paramUserId)` (JWT.userId === paramUserId), иначе ForbiddenException.

### 3.3 Валидация ввода

- Глобальный `ValidationPipe` (whitelist, forbidNonWhitelisted, transform).
- DTO с class-validator: `StartCampaignDto`, `CreateLeadDto`; остальные эндпоинты часто принимают `@Body() body: any` или `Record<string, unknown>` с ручным приведением (templates create/update, admin и т.д.) — **неидеально**.

### 3.4 Очередь и воркер

- **BullMQ:** очередь `campaign-send`, воркер в `queue/campaign.worker.ts` (concurrency 1, lockDuration 120s).
- Повтор волн: `CampaignRepeatService` (интервал из env, по умолчанию 10 с), выбирает кампании с `repeat_enabled`, `status=running`, `paused=false`, `next_repeat_at <= now`.
- Воркер: загрузка job из `campaign_jobs`, проверка `campaign.paused`, подписки, отправка в WA/TG; при паузе — статус job `paused`, при resume — джобы переставляются в очередь.

---

## 4. База данных (Supabase / PostgreSQL)

### 4.1 Таблицы (по коду и миграциям)

| Таблица | Назначение |
|---------|------------|
| `users` | Пользователи, timezone, referral и т.д. |
| `otp_codes` | Коды подтверждения по телефону |
| `campaigns` | Рассылки (status, channel, paused, repeat_*, time_from/to, timezone) |
| `campaign_jobs` | Задачи рассылки (campaign_id, user_id, group_jid, template_id, status, scheduled_at, channel) |
| `message_templates` | Шаблоны (user_id, text, media_url, send_media_as_file, wa/tg_speed_factor, default_send_time) |
| `template_group_targets` | Переопределения по парам шаблон–группа (send_time_override) |
| `whatsapp_groups` | Группы WA (user_id, wa_phone, is_selected, last_send_error и т.д.) |
| `telegram_groups` | Группы TG (user_id, tg_phone, last_send_error, views_count и т.д.) |
| `subscriptions` | Подписки (plan, доступ по каналам, даты) |
| `payments` | Платежи Prodamus |
| `referrals` | Рефералы |
| `lead_requests` | Заявки с лендинга |

### 4.2 Миграции

- **backend/migrations:** add_campaigns_paused, add_tg_phone_to_groups, add_wa_phone_to_groups, add_last_send_error_groups, add_message_templates_send_media, add_telegram_groups_stats, add_users_timezone, add_groups_indexes, enable_rls_campaign_jobs, fix_duplicate_groups, RUN_IN_SUPABASE.
- **supabase/migrations:** add_wa_phone_to_whatsapp_groups.
- Явной единой схемы (Prisma и т.п.) нет — структура задаётся SQL и использованием Supabase в коде.

### 4.3 RLS и индексы

- **RLS:** включён только для `campaign_jobs`; доступ anon/authenticated отозван, бэкенд использует service_role.
- **Индексы (add_groups_indexes):**  
  `idx_whatsapp_groups_user_updated`, `idx_telegram_groups_user_updated`,  
  `idx_whatsapp_groups_user_selected`, `idx_telegram_groups_user_selected`,  
  `idx_whatsapp_groups_user_announcement`.  
- Индексы для `campaigns` (user_id, status, channel, paused, next_repeat_at) и `campaign_jobs` (campaign_id, status) в миграциях **не описаны** — при росте данных возможны медленные запросы.

---

## 5. Зависимости и типы

### 5.1 Frontend (package.json)

- next ^16.1.6, react 19.2.0, antd ^6.1.1, js-cookie, qrcode.react.
- Dev: TypeScript ^5, ESLint 9, babel-plugin-react-compiler (отключён в next.config из-за RSC).
- **npm audit:** есть уязвимости (в т.ч. minimatch high, ajv moderate) в транзитивных зависимостях.

### 5.2 Backend (package.json)

- NestJS 11, @supabase/supabase-js, bullmq, ioredis, passport-jwt, jsonwebtoken, class-validator, class-transformer, luxon, axios, telegram, @whiskeysockets/baileys, multer, papaparse, dotenv, qrcode, pino.
- **npm audit:** moderate (ajv через @nestjs/schematics / @angular-devkit/core) — в dev-зависимостях.

### 5.3 Типы и any

- **Backend:** много использований `any` (в т.ч. req, body, результаты Supabase) в campaigns, templates, telegram, whatsapp, payments, auth, queue.
- **Frontend:** `any` встречается в страницах (dashboard/groups, telegram-groups, campaigns, templates, admin, cabinet, auth) и в компонентах (WhatsappConnectBlock, TelegramQrConnect, TemplatesSyncBlock, SheetsBlock).
- Строгая типизация ответов API и моделей БД не везде выдержана.

---

## 6. Производительность и оптимизации

### 6.1 Лимиты выборок (backend)

- Кампании: список — 50, активная — 1, repeat tick — 20.
- **campaign_jobs:** getJobs / requeue — лимит **50_000**; createWave — вставка пачкой, без лимита по количеству групп/шаблонов.
- **message_templates:** list — 500; campaign_jobs stats — 10_000.
- **template_group_targets:** до **100_000** в createWave.
- **whatsapp_groups / telegram_groups:** в createWave — до **50_000** выбранных групп каждый.
- **admin:** пользователи — limit 500.

Риск: при очень больших объёмах (десятки тысяч джобов/групп/целей) возможны высокое потребление памяти и долгие запросы.

### 6.2 Индексы

- Группы WA/TG хорошо покрыты индексами (user_id, updated_at, is_selected, is_announcement).
- Для `campaigns` и `campaign_jobs` составные индексы под частые фильтры (user_id + status + channel, campaign_id + status, next_repeat_at) **рекомендуется добавить** при росте нагрузки.

### 6.3 Frontend

- Next: standalone output, кэш статики 1 год для `/_next/static/*`.
- Нет единого data-fetching слоя (React Query/SWR) — много ручного fetch с разными таймаутами и повторами.
- Крупные страницы (например, `dashboard/templates/[templateId]/page.tsx`) — тяжёлые по логике и количеству состояний.

---

## 7. Безопасность

### 7.1 Хорошо

- JWT на всех важных API; проверка владельца по userId в URL (ensureUserParam).
- Prodamus webhook — проверка подписи; ошибки в try/catch, без утечки секретов в лог.
- CORS ограничен списком origin (env + дефолты).
- Пароли/секреты не коммитятся (правила .cursor); есть .env.example.

### 7.2 Замечания и риски

- **POST /log-client-error** — без аутентификации; тело логируется в console. Теоретически возможен спам логов или передача чувствительных данных в message/stack — стоит ограничить размер/тип или защитить.
- **POST /leads** — публичный; есть проверка consent_personal и нормализация телефона; rate limit не прослеживался в коде.
- **Отсутствие middleware на фронте:** защита только реактивная (401 → редирект). Прямой заход на /dashboard или /admin без токена даст загрузку страницы и затем редирект после первого 401 — не критично, но можно улучшить проверкой токена до рендера.
- **AdminGuard:** проверка роли админа по БД (users); пароль админки — отдельный AdminPasswordGuard.

---

## 8. Что хорошо

- Чёткое разделение frontend/backend, единая точка входа API через next rewrites.
- Централизованная обработка 401 и сетевых ошибок в api.ts.
- Проверка владельца (userId) на всех релевантных эндпоинтах WA/TG/templates/campaigns.
- Повтор волн и пауза рассылок реализованы согласованно (paused в campaigns, воркер и repeat учитывают).
- Лимиты на список шаблонов и размер выборок джобов/статистики заданы константами.
- Индексы для групп WA/TG добавлены, пагинация групп по limit/offset есть.
- Prodamus webhook с проверкой подписи и безопасным логированием.

---

## 9. Что неидеально (частично исправлено 2026-03-08)

- Много `any` и ручного приведения типов на бэкенде и фронте — добавлены DTO для templates (create/update/delete), campaigns (set-pause).
- Не все мутации принимают DTO с class-validator — templates переведены на CreateTemplateDto, UpdateTemplateDto, DeleteTemplateDto.
- Единый data-fetching на фронте — добавлен SWR и хук `useBackendSWR` в `frontend/src/lib/useBackendSWR.ts`.
- Middleware для ранней проверки авторизации — добавлен `frontend/src/middleware.ts` (редирект на `/auth/phone` при заходе на /dashboard, /cabinet, /admin без cookie `token`).
- Лимиты снижены (10k/20k), индексы добавлены (миграция и скрипт).

---

## 10. Критично к исправлению (выполнено 2026-03-08)

1. **Индексы БД:** добавлена миграция `backend/migrations/add_campaigns_and_jobs_indexes.sql` и скрипт `scripts/run-campaigns-indexes-migration.js`. Применить на всех окружениях.
2. **Лимиты и пагинация:** снижены лимиты в `campaigns.service.ts`: JOBS_SELECT_LIMIT 10k, GROUPS_SELECT_LIMIT 10k, TARGETS_SELECT_LIMIT 20k.
3. **POST /log-client-error:** ограничена длина полей (message 2000, stack 8000, url/path 500, userAgent 400, digest 100); тело без DTO (публичный эндпоинт).
4. **npm audit:** frontend — `npm audit fix` применён (0 уязвимостей). Backend — уязвимости только в dev-зависимостях (NestJS CLI/schematics); исправление требует понижения версии.
5. **Миграция add_campaigns_paused:** инструкции и скрипт в `docs/MIGRATIONS.md` и `scripts/run-campaigns-paused-migration.js`.

---

## 11. Сводная таблица

| Область | Оценка | Комментарий |
|---------|--------|-------------|
| Структура проекта | Хорошо | Монорепо, понятное разделение |
| Экраны и маршруты | Хорошо | 17 маршрутов, компоненты переиспользуются |
| Защита API | Хорошо | JWT + проверка userId; leads и webhook осознанно публичные |
| Валидация ввода | Средне | DTO не везде, много body: any |
| Типизация | Средне | Много any на бэкенде и фронте |
| БД и индексы | Средне | Индексы для групп есть; для campaigns/jobs — нет |
| Лимиты выборок | Внимание | Большие лимиты 50k/100k при росте данных |
| Очередь и воркер | Хорошо | Пауза, повтор, подписка учтены |
| Безопасность | Хорошо | Есть точечные риски (log-client-error, rate limit на leads) |
| Зависимости | Внимание | Есть уязвимости в транзитивных пакетах |

Итог: проект в целом согласован и пригоден к эксплуатации; приоритетно — индексы для campaigns/campaign_jobs, пересмотр лимитов/пагинации для тяжёлых выборок, защита/ограничение log-client-error и обновление зависимостей по audit.
