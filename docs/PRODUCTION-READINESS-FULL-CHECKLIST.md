# Полный чек-лист готовности к продакшену

**Проект:** ЧатРассылка (frontend Next.js 16 + backend NestJS + Supabase + BullMQ)  
**Дата:** 2026-03-08  
**Цель:** ничего не упустить — все компоненты, маршруты, интеграции, безопасность, БД, деплой.

---

## 1. Frontend — маршруты и страницы

| # | Маршрут | Файл | Чек-лист |
|---|---------|------|----------|
| 1.1 | `/` | `app/page.tsx` | [ ] Лендинг, форма лида, контент без ошибок |
| 1.2 | `/auth/phone` | `app/auth/phone/page.tsx` | [ ] Ввод телефона, отправка кода, редирект на code |
| 1.3 | `/auth/code` | `app/auth/code/page.tsx` | [ ] Ввод кода, верификация, редирект в ЛК/dashboard |
| 1.4 | `/auth/register` | `app/auth/register/page.tsx` | [ ] Регистрация по рефералу, сохранение полей |
| 1.5 | `/dashboard` | `app/dashboard/page.tsx` | [ ] Редирект на campaigns или контент дашборда |
| 1.6 | `/dashboard/campaigns` | `app/dashboard/campaigns/page.tsx` | [ ] Список рассылок, запуск/пауза, интервалы, подписка, ошибки |
| 1.7 | `/dashboard/campaign` | `app/dashboard/campaign/page.tsx` | [ ] Прогресс одной рассылки, статусы job (в т.ч. paused) |
| 1.8 | `/dashboard/groups` | `app/dashboard/groups/page.tsx` | [ ] Группы WA, выбор, интервал по группе, фильтр |
| 1.9 | `/dashboard/groups/telegram` | `app/dashboard/groups/telegram/page.tsx` | [ ] Группы TG, выбор, интервал, фильтр (редирект с /dashboard/telegram-groups) |
| 1.10 | `/dashboard/templates` | `app/dashboard/templates/page.tsx` | [ ] Список шаблонов, создание/редактирование |
| 1.11 | `/dashboard/templates/new` | `app/dashboard/templates/new/page.tsx` | [ ] Создание шаблона, паузы по каналам |
| 1.12 | `/dashboard/templates/[templateId]` | `app/dashboard/templates/[templateId]/page.tsx` | [ ] Редактирование шаблона, сохранение |
| 1.13 | `/dashboard/analytics` | `app/dashboard/analytics/page.tsx` | [ ] Аналитика, данные без падений |
| 1.14 | `/cabinet` | `app/cabinet/page.tsx` | [ ] ЛК: подписка, WA/TG блоки, пауза, профиль, таймзона, реферал |
| 1.15 | `/cabinet/subscription` | `app/cabinet/subscription/page.tsx` | [ ] Подписка, тарифы, оплата |
| 1.16 | `/cabinet/support` | `app/cabinet/support/page.tsx` | [ ] Поддержка |
| 1.17 | `/admin` | `app/admin/page.tsx` | [ ] Админка: пользователи, блокировка, триал, пароль |

**Дополнительно:**  
- [ ] Error boundaries: `app/error.tsx`, `app/dashboard/error.tsx`, `app/cabinet/error.tsx`, `app/dashboard/groups/error.tsx` — показывают сообщение и ссылку назад  
- [ ] Loading states: страницы с fetch показывают спиннер/скелетон до загрузки (где реализовано)  
- [ ] Middleware: `middleware.ts` — редирект на `/auth/phone` при заходе на `/dashboard/*`, `/cabinet/*`, `/admin/*` без cookie `token`  
- [ ] API: `lib/api.ts` — `apiPost`, `apiGet`, таймаут 20s, при 401 снятие cookie и редирект на `/auth/phone`

---

## 2. Frontend — компоненты и провайдеры

| # | Компонент/провайдер | Назначение | Чек-лист |
|---|---------------------|------------|----------|
| 2.1 | `WhatsappConnectBlock` | Подключение WA, QR, пауза/отключить, аккаунт | [ ] Работает с backend, анимации появления |
| 2.2 | `TelegramQrConnect` | Подключение TG по QR, пауза/отключить, аккаунт | [ ] Работает с backend, анимации появления |
| 2.3 | `CampaignBlock` | Блок рассылок в ЛК/дашборде | [ ] Ссылки и логика корректны |
| 2.4 | `TemplatesSyncBlock` | Синхронизация шаблонов | [ ] Вызов API без ошибок |
| 2.5 | `SheetsBlock` | Google Sheets | [ ] Вызов API, ошибки обрабатываются |
| 2.6 | `TemplateRichEditor` | Редактор шаблона (текст, медиа) | [ ] Сохранение, превью |
| 2.7 | `ChannelIcon` | Иконки WA/TG | [ ] Отображение |
| 2.8 | `MediaViewerModal` | Просмотр медиа | [ ] Открытие/закрытие |
| 2.9 | `WhatsappLinkingSteps` / `TelegramLinkingSteps` | Инструкции подключения | [ ] Тексты и шаги |
| 2.10 | `NotifyProvider` | Глобальные уведомления | [ ] Показ toast при успехе/ошибке |
| 2.11 | `LoaderProvider` | Глобальный лоадер | [ ] Показ/скрытие при запросах |

---

## 3. Backend — модули и контроллеры

| # | Модуль | Контроллер | Защита | Чек-лист |
|---|--------|------------|--------|----------|
| 3.1 | Auth | `auth.controller.ts` | login/code/register — без JWT; me, update-profile — JWT | [ ] Выдача JWT, проверка кода, обновление профиля |
| 3.2 | Admin | `admin.controller.ts` | JWT + AdminGuard + AdminPasswordGuard | [ ] Список пользователей, блокировка, триал, доступ |
| 3.3 | Campaigns | `campaigns.controller.ts` | JWT; start-multi, requeue — + SubscriptionGuard | [ ] Старт, пауза, прогресс, requeue, set-pause, pause-state |
| 3.4 | Templates | `templates.controller.ts` | JWT, ensureUserParam / user_id | [ ] CRUD шаблонов, список, владелец |
| 3.5 | WhatsApp | `whatsapp.controller.ts` | JWT, ensureUserParam(userId) | [ ] Статус, старт, сброс, группы, account-info, time |
| 3.6 | Telegram | `telegram.controller.ts` | JWT, ensureUserParam(userId) | [ ] QR статус/старт, disconnect, группы, account-info |
| 3.7 | Sheets | `sheets.controller.ts` | JWT | [ ] create, привязка к пользователю |
| 3.8 | Subscriptions | `subscriptions.controller.ts` | JWT | [ ] /me, данные подписки и доступа |
| 3.9 | Payments | `prodamus.controller.ts` | create — JWT; webhook — проверка подписи | [ ] Создание ссылки на оплату, webhook обновляет подписку и снимает паузу |
| 3.10 | Leads | `leads.controller.ts` | Публичный, RateLimitLeadsGuard 60/мин | [ ] Валидация consent_personal, нормализация телефона |
| 3.11 | App | `app.controller.ts` | log-client-error — публичный, RateLimitLogGuard 30/мин | [ ] Ограничение длины полей (message, stack, url), не падать при спаме |

**Общее:**  
- [ ] Везде, где в path есть `:userId`, вызывается `ensureUserParam(req, paramUserId)` (403 при несовпадении)  
- [ ] SubscriptionGuard проверяет hasAccessForChannel(userId, channel) для start-multi и requeue  
- [ ] Prodamus webhook: проверка подписи, try/catch, без утечки секретов в ответе

---

## 4. Backend — очередь и воркер

| # | Элемент | Файл/сервис | Чек-лист |
|---|---------|-------------|----------|
| 4.1 | Очередь BullMQ | `queue/` | [ ] Очередь `campaign-send`, Redis подключён |
| 4.2 | Воркер отправки | `queue/campaign.worker.ts` | [ ] Проверка campaign.paused и hasAccessForChannel перед отправкой; при отсутствии доступа — job в paused/skipped с reason |
| 4.3 | Повтор волн | `campaigns.service.ts` (CampaignRepeatService) | [ ] repeatWaveIfReady проверяет hasAccessForChannel; при отсутствии доступа кампания в paused, волна не создаётся |
| 4.4 | Пауза после оплаты | `payments/prodamus.controller.ts` | [ ] После успешного webhook вызывается setPause(userId, 'wa', false), setPause(userId, 'tg', false) |
| 4.5 | Лимиты и таймауты | Воркер, TG/WA сервисы | [ ] JOBS_SELECT_LIMIT, GROUPS_SELECT_LIMIT, TARGETS_SELECT_LIMIT в разумных пределах; таймауты отправки (60/90s) |

---

## 5. База данных (Supabase / PostgreSQL)

| # | Таблица | Назначение | Чек-лист |
|---|---------|------------|----------|
| 5.1 | users | Пользователи, timezone, is_admin, is_blocked | [ ] Поля есть, индексы при необходимости |
| 5.2 | otp_codes | Коды подтверждения по телефону | [ ] TTL, очистка |
| 5.3 | campaigns | Рассылки (status, channel, paused, repeat_*, time_*) | [ ] Индексы: user_id+status+channel, next_repeat_at (миграция add_campaigns_and_jobs_indexes) |
| 5.4 | campaign_jobs | Задачи рассылки (campaign_id, status, scheduled_at, channel) | [ ] RLS включён; индексы campaign_id+status, campaign_id+scheduled_at |
| 5.5 | message_templates | Шаблоны (user_id, text, media, send_time, speed_factor) | [ ] Лимит выборки (500) в list |
| 5.6 | template_group_targets | Переопределения шаблон–группа (send_time_override) | [ ] Лимит в createWave (20k) |
| 5.7 | whatsapp_groups | Группы WA (user_id, is_selected, wa_phone, last_send_error) | [ ] Индексы: user_id+updated_at, user_id+is_selected, wa_phone, is_announcement |
| 5.8 | telegram_groups | Группы TG (user_id, tg_phone, last_send_error, stats) | [ ] Индексы: user_id+updated_at, user_id+is_selected, tg_phone |
| 5.9 | subscriptions | Планы, trial, current_period_end, cancel_at_period_end | [ ] Обновление из webhook |
| 5.10 | payments | Платежи Prodamus | [ ] Запись и обновление status |
| 5.11 | referrals | Рефералы и награды | [ ] Начисление дней при оплате по рефералу |
| 5.12 | lead_requests | Лиды с лендинга | [ ] consent_personal, нормализация телефона |

**Миграции:**  
- [ ] Применены: add_campaigns_paused, add_campaigns_and_jobs_indexes, add_groups_indexes, add_*_phone_to_groups, add_last_send_error_groups, add_telegram_groups_stats, add_users_timezone, enable_rls_campaign_jobs, fix_duplicate_groups (см. docs/MIGRATIONS.md)  
- [ ] RUN_IN_SUPABASE.sql / APPLY_IN_SUPABASE_SQL_EDITOR.sql — при первом деплое выполнить в Supabase SQL Editor

---

## 6. Интеграции

| # | Сервис | Переменные / конфиг | Чек-лист |
|---|--------|----------------------|----------|
| 6.1 | Supabase | SUPABASE_URL, SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY | [ ] Подключение, таблицы доступны |
| 6.2 | Redis | REDIS_HOST, REDIS_PORT | [ ] BullMQ подключается |
| 6.3 | SMS (SMS.ru) | SMSRU_API_ID, SMSRU_FROM | [ ] Отправка кодов на auth/code |
| 6.4 | Telegram API | TG_API_ID, TG_API_HASH | [ ] QR-подключение, отправка в группы |
| 6.5 | WhatsApp (Baileys) | (сессии в wa_auth/) | [ ] Подключение по QR, отправка в группы |
| 6.6 | Prodamus | PRODAMUS_FORM_URL, PRODAMUS_SECRET_KEY, PRODAMUS_SYS | [ ] Создание платежа, webhook с подписью |
| 6.7 | Google Apps Script (Sheets) | APPS_SCRIPT_URL, APPS_SCRIPT_SECRET | [ ] Опционально; вызов из Sheets модуля |

---

## 7. Безопасность

| # | Элемент | Чек-лист |
|---|---------|----------|
| 7.1 | Секреты | [ ] JWT_SECRET, PRODAMUS_SECRET_KEY, ключи Supabase, пароль админки — только в .env, не в репозитории |
| 7.2 | .env.example | [ ] backend/.env.example и frontend/.env.example без реальных значений, с комментариями |
| 7.3 | CORS | [ ] Ограничен списком origin (env), не * в продакшене |
| 7.4 | POST /log-client-error | [ ] Ограничена длина message, stack, url, userAgent (реализовано в app.controller) |
| 7.5 | POST /leads, POST /log-client-error | [x] Rate limit по IP (RateLimitLeadsGuard 60/мин, RateLimitLogGuard 30/мин) |
| 7.6 | Admin | [ ] AdminGuard по БД (is_admin), отдельный пароль (AdminPasswordGuard) |

---

## 8. Подписка и доступ

| # | Логика | Где | Чек-лист |
|---|--------|-----|----------|
| 8.1 | hasAccess(userId) | subscriptions.service | [ ] Учитывает is_blocked, trial_ends_at, current_period_end; коды: trial_expired, subscription_expired, no_subscription, blocked |
| 8.2 | hasAccessForChannel(userId, channel) | subscriptions.service | [ ] План wa_tg/base — оба канала; wa/tg — только свой; plan_not_allowed для другого |
| 8.3 | Админы | hasAccess | [ ] is_admin === true → allowed без проверки подписки |
| 8.4 | Guard на start-multi, requeue | campaigns.controller | [ ] SubscriptionGuard вызывает hasAccessForChannel |
| 8.5 | Воркер и repeat | campaign.worker, repeatWaveIfReady | [ ] Перед отправкой/повтором проверка доступа; при отказе — paused/skipped и не создавать волну |
| 8.6 | UI при ошибке старта | dashboard/campaigns | [ ] Сообщения и кнопка «Оформить подписку» при no_subscription, trial_expired, subscription_expired, plan_not_allowed |
| 8.7 | Пауза из-за оплаты | dashboard/campaigns | [ ] Бейдж «нужна оплата», ссылка на /cabinet/subscription, кнопка «Продолжить рассылку» после оплаты |

---

## 9. Интервалы и UX (рассылки)

| # | Элемент | Чек-лист |
|---|---------|----------|
| 9.1 | Окно времени (когда отправлять) | [ ] Кнопка «Время» на странице рассылок, подсказка в попапе |
| 9.2 | Паузы рассылки (между группами, шаблонами, повтор волны) | [ ] Попап «Интервалы рассылки», подписи слайдеров понятные |
| 9.3 | Интервал по группе | [ ] Группы WA и TG — колонка «Интервал» (SEND_INTERVAL_OPTIONS); шаблон — переопределение send_time |
| 9.4 | Справка (?) на странице рассылок | [ ] Блок «Интервалы и время — где что настраивать» (docs/PRODUCTION-READINESS-INTERVALS-UX.md) |
| 9.5 | Синхронизация опций | [ ] GROUP_INTERVALS (backend) и SEND_INTERVAL_OPTIONS (frontend) совпадают по ключам |

---

## 10. Конфигурация и деплой

| # | Элемент | Чек-лист |
|---|---------|----------|
| 10.1 | Backend .env | [ ] PORT, SUPABASE_*, JWT_SECRET, REDIS_*, PRODAMUS_*, при необходимости TG_*, SMSRU_*, APPS_SCRIPT_*, ADMIN_PANEL_PASSWORD, CAMPAIGN_REPEAT_ENABLED |
| 10.2 | Frontend .env | [ ] NEXT_PUBLIC_BACKEND_URL=/api (или полный URL бэкенда) |
| 10.3 | Сборка backend | [ ] npm run build, без ошибок TypeScript |
| 10.4 | Сборка frontend | [ ] npm run build (standalone), без ошибок |
| 10.5 | PM2 | [ ] backend и frontend в ecosystem.config.cjs; pm2 startup при необходимости |
| 10.6 | Nginx | [ ] Прокси /api → backend:3000, остальное → frontend:3001; SSL (Let's Encrypt) |
| 10.7 | Домен | [ ] chatrassylka.ru / www, DNS и сертификат настроены |

---

## 11. Логирование и мониторинг

| # | Элемент | Чек-лист |
|---|---------|----------|
| 11.1 | Логи backend | [ ] Логи воркера, repeat tick, ошибки API в stdout/stderr или файл |
| 11.2 | Логи frontend | [ ] Клиентские ошибки в error boundary → POST /log-client-error (если настроено) |
| 11.3 | PM2 логи | [ ] pm2 logs, ротация при необходимости (docs/PM2_MEMORY_AND_LOGS.md) |

---

## 12. Тестирование и качество кода

| # | Элемент | Чек-лист |
|---|---------|----------|
| 12.1 | Backend unit-тесты | [ ] auth.service.spec, auth.controller.spec, app.controller.spec — при изменениях запускать |
| 12.2 | npm audit | [ ] frontend: 0 critical/high; backend: по возможности исправить dev-зависимости |
| 12.3 | Типизация и DTO | [ ] Auth: VerifyCodeDto, UpdateProfileDto; subscriptions: CancelSubscriptionDto; campaigns/templates — уже с DTO. Постепенно заменять any на типы. |

---

## 13. Документация (в docs/)

| # | Документ | Назначение |
|---|----------|------------|
| 13.1 | MIGRATIONS.md | Порядок и скрипты миграций БД |
| 13.2 | FULL-AUDIT-REPORT.md | Общий аудит, маршруты, защита, лимиты |
| 13.3 | SUBSCRIPTION_PAYMENTS_AUDIT.md | Подписка, оплаты, воркер, requeue |
| 13.4 | INTERVALS-LOGIC-REPORT.md | Логика интервалов и времени рассылок |
| 13.5 | PRODUCTION-READINESS-INTERVALS-UX.md | Интервалы и единый UX для клиентов |
| 13.6 | AUTO-RESUME-CAMPAIGNS-AFTER-PAYMENT.md | Снятие паузы рассылок после оплаты |
| 13.7 | INTEGRATIONS-STATUS.md | Статус интеграций и переменные |
| 13.8 | PAYMENT_DEBUG.md, ADMIN_PANEL_PASSWORD.md | Отладка оплат, пароль админки |
| 13.9 | PM2-SETUP.md, HESTIA-CHATRASSYLKA.md, SSL-*.md | Деплой, хостинг, SSL |

---

## 14. Известные ограничения и рекомендации

- **Лимиты выборок:** JOBS_SELECT_LIMIT 10k, GROUPS 10k, TARGETS 20k — при росте числа групп/шаблонов рассмотреть пагинацию или батчи.
- **Таймаут БД (57014):** при ошибке «canceling statement due to statement timeout» — в Supabase (Database → Settings) можно увеличить statement_timeout. Остановка рассылки (stop) обновляет job'ы батчами по 500, чтобы снизить риск таймаута.
- **Rate limit:** реализован в backend: POST /leads — 60 запросов/мин по IP (RateLimitLeadsGuard), POST /log-client-error — 30/мин (RateLimitLogGuard). При необходимости можно добавить nginx limit_req.
- **Middleware Next.js:** текущий middleware проверяет только наличие cookie; при необходимости можно проверять валидность JWT до рендера (доп. запрос или проверка на клиенте уже есть при первом API-вызове).
- **Автозапуск новой рассылки по расписанию:** не реализован; реализовано только авто-снятие паузы после оплаты (webhook Prodamus).

---

## Сводка: что проверить перед релизом

1. Все миграции из docs/MIGRATIONS.md применены на целевой БД.  
2. В .env продакшена заданы все обязательные переменные (backend и frontend).  
3. Prodamus webhook URL и подпись настроены; после тестовой оплаты подписка обновляется и пауза снимается.  
4. Middleware и JWT: заход на /dashboard без токена редиректит на /auth/phone.  
5. На странице рассылок при отсутствии подписки показывается сообщение и переход в ЛК; при паузе из-за оплаты — бейдж и кнопка «Продолжить».  
6. Сборки backend и frontend проходят без ошибок; PM2 поднимает оба процесса; Nginx проксирует и отдаёт SSL.

Использование: пройти по разделам 1–13 и отмечать пункты по мере проверки или доработки.
