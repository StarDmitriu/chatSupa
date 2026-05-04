# Полный отчёт: исследование UI и бэкенда, стандартизация, вкладки и связи

**Дата:** 2026-03-08  
**Цель:** единые стандарты для всех компонентов, понятная структура вкладок, связи между экранами и бэкендом, список улучшений.

---

## 1. Что сделано в рамках задачи

### 1.1 Константы каналов (единый источник)

- **Файл:** `frontend/src/constants/channels.ts`
- **Содержимое:** `CHANNELS` ('wa' | 'tg'), `CHANNEL_LABELS`, `PLAN_CODES` (wa, tg, wa_tg), `PLAN_LABELS`, хелперы `isChannel()`, `isPlanCode()`.
- **Назначение:** один источник правды для каналов и тарифов; использовать в UI и при вызовах API вместо литералов. Бэкенд уже использует те же значения (campaigns.channel, subscriptions.plan_code, Prodamus).

**Рекомендация:** постепенно заменить в коде строки `'wa'`/`'tg'` на импорт из `@/constants/channels` (campaigns, cabinet, subscription, ChannelIcon уже по смыслу совпадают).

### 1.2 Единая шапка дашборда (layout + компонент)

- **Файлы:**
  - `frontend/src/app/dashboard/layout.tsx` — обёртка для всех маршрутов `/dashboard/*` с общим header.
  - `frontend/src/components/DashboardHeader.tsx` — логотип + навигация: «← В кабинет», «Рассылки», «Шаблоны», «Группы WA», «Группы TG», «Аналитика». Текущая страница подсвечивается (`tpl-header__pill--active`).
  - `frontend/src/app/dashboard/dashboard-layout.css` — стили шапки (совместимы с прежними .camp .tpl-header).
- **Страницы:** с каждой страницы дашборда убран дублирующий блок (лого + навигационные пилюли). Оставлены только заголовок раздела (label) и при необходимости кнопки раздела (Обновить, Создать шаблон и т.д.).

**Итог:** навигация между Рассылки / Шаблоны / Группы WA / Группы TG / Аналитика и выход в кабинет — в одном месте, без копипаста.

---

## 2. Текущая структура вкладок и куда что встроено

### 2.1 Дашборд (после изменений)

| Вкладка (кнопка в шапке) | Маршрут | Назначение | Связи с другими разделами |
|--------------------------|--------|------------|---------------------------|
| Рассылки | `/dashboard/campaigns` | Запуск/пауза рассылок WA/TG, окно времени, паузы между группами/шаблонами, повтор волны | Шаблоны (нужны включённые), Группы WA/TG (выбранные), Кабинет (подписка, пауза из-за оплаты), Прогресс рассылки → `/dashboard/campaign` |
| Шаблоны | `/dashboard/templates` | Список шаблонов, вкл/выкл, создание, редактирование | Рассылки (какие шаблоны отправлять), Группы (цели по шаблону), `/templates/new`, `/templates/[id]` |
| Группы WA | `/dashboard/groups` | Список групп WhatsApp, выбор, интервал по группе, синхронизация | Рассылки (какие группы получают), шаблоны (цели WA), Кабинет (подключение WA) |
| Группы TG | `/dashboard/groups/telegram` | Список групп Telegram, выбор, интервал, синхронизация (редирект с `/dashboard/telegram-groups`) | Рассылки (какие группы получают), шаблоны (цели TG), Кабинет (подключение TG) |
| Аналитика | `/dashboard/analytics` | История рассылок, сводки по каналам и статусам, ссылки на «Прогресс» | Рассылки (откуда приходит пользователь за историей) |
| ← В кабинет | `/cabinet` | Выход из дашборда в ЛК | Подписка, WA/TG подключение, профиль, реферал |

**Специальные маршруты без отдельной кнопки в шапке:**

- `/dashboard/campaign` — прогресс одной рассылки (query `wa`, `tg`); вход с страницы «Рассылки» или из таблицы «Аналитика».
- `/dashboard/templates/new` — создание шаблона; вход с «Шаблоны» (кнопка «Создать шаблон»).
- `/dashboard/templates/[templateId]` — редактирование шаблона; вход из списка шаблонов.

### 2.2 Кабинет

| Блок на странице `/cabinet` | Назначение | Связи |
|-----------------------------|------------|--------|
| Моя подписка | Тариф, статус, дни, оплата, отмена автосписания | `/cabinet/subscription`, Prodamus, Рассылки (пауза при отсутствии оплаты) |
| Telegram | Подключение/отключение, пауза рассылок TG | Группы TG, Рассылки (канал TG) |
| WhatsApp | Подключение/отключение, пауза рассылок WA | Группы WA, Рассылки (канал WA) |
| Рассылка (CampaignBlock) | Кнопка перехода к рассылкам | `/dashboard/campaigns` |
| Реферальная ссылка | Копирование/шаринг | Регистрация по рефералу |
| Немного обо мне | Профиль (имя, телефон, пол, TG, день рождения, город) | Auth, timezone в том же блоке |

**Сделано:** блоки «Google Таблица» (SheetsBlock) и «Синхронизация шаблонов» (TemplatesSyncBlock) выведены в кабинете в секции «Интеграции» (после CampaignBlock).

### 2.3 Админка

- **Маршрут:** `/admin`. Отдельная зона, не входит в дашборд; доступ по JWT + AdminGuard + (опционально) пароль админки.
- **Связи:** пользователи, блокировка, trial/доступ; не связана с вкладками дашборда по навигации.

---

## 3. Связи компонентов и вкладок (кратко)

- **ChannelIcon** — используется везде, где нужно обозначить WA/TG (дашборд, кабинет, подписка). Имеет смысл опираться на `CHANNEL_LABELS` из `channels.ts` для подписей.
- **WhatsappConnectBlock / TelegramQrConnect** — только кабинет; после подключения группы подтягиваются в «Группы WA» / «Группы TG».
- **CampaignBlock** — кабинет → переход на «Рассылки».
- **TemplateRichEditor, MediaViewerModal** — только страницы шаблонов (список, new, [templateId]).
- **useNotify, useGlobalLoader** — глобально; все страницы дашборда и кабинета вызывают loader при переходах и при запросах.
- **apiPost / apiGet** — единая точка вызова API с таймаутом и обработкой 401 (редирект на `/auth/phone`).

---

## 4. Бэкенд: стандарты и расхождения

### 4.1 Формат ответов

- **Стандарт:** `{ success: true, ... }` или `{ success: false, message: string, ... }`.
- **Исключения:** корень `GET /` (строка), `POST /log-client-error` (204), `whatsapp/group-avatar-content` (бинарный поток), webhook Prodamus иногда возвращает `error` вместо `message`.
- **Рекомендация:** в обработчиках на фронте по умолчанию ожидать `message`; для webhook не трогать (вызов не с фронта). По желанию — единый тип ApiError с полем `code` для маппинга (no_subscription, trial_expired и т.д.), уже частично есть в campaignErrors.

### 4.2 Валидация (DTO)

- **С DTO (class-validator):** campaigns (SetPauseDto, StartCampaignDto), templates (Create/Update/Delete), leads (CreateLeadDto).
- **Сделано:** auth — VerifyCodeDto, UpdateProfileDto; subscriptions — CancelSubscriptionDto.
- **Без DTO (остаётся):** admin (block, grant-trial, …), whatsapp/telegram (select, time, …), prodamus create/webhook. По мере доработок вводить DTO для admin и для важных POST в whatsapp/telegram.

### 4.3 userId и владелец

- **Паттерн:** в маршрутах с `:userId` — `ensureUserParam(req, paramUserId)` (JWT.userId === paramUserId), иначе 403. В маршрутах без :userId — `authUserId(req)` (throw при отсутствии).
- **Использование:** templates, whatsapp, telegram, campaigns (внутренне). Единообразие соблюдено.

---

## 5. Что сделать дальше (чек-лист для вас)

### 5.1 Обязательно

1. **Проверить навигацию дашборда** — вручную: Рассылки, Шаблоны, Группы WA, Группы TG, Аналитика, «В кабинет»; активная кнопка и переходы. На мобильных — бургер-меню (реализовано в DashboardHeader).
2. **SheetsBlock и TemplatesSyncBlock** — сделано: возвращены в кабинет в секции «Интеграции».
3. **Константы каналов** — применены в analytics, cabinet, subscription; PLAN_PRICES в channels.ts; в новом коде использовать CHANNEL_LABELS, PLAN_LABELS, isChannel() из `@/constants/channels`.

### 5.2 Желательно

4. **Один маршрут «Группы»** — сделано: TG группы под `/dashboard/groups/telegram`, редирект с `/dashboard/telegram-groups`; навигация «Группы WA» → `/dashboard/groups`, «Группы TG» → `/dashboard/groups/telegram`.
5. **useBackendSWR** — подключён для subscriptions/me, campaigns/active; при необходимости расширить на auth/me, templates/list.
6. **План и цены в константы** — сделано: PLAN_PRICES в channels.ts, cabinet и subscription используют их.

### 5.3 По возможности

7. **DTO на бэкенде** — сделано для auth (VerifyCodeDto, UpdateProfileDto), subscriptions (CancelSubscriptionDto). Остаётся: admin, whatsapp/telegram (select, time).
8. **TelegramConnect** — удалён как неиспользуемый компонент (в кабинете только TelegramQrConnect).
9. **Единый формат ошибок API (поле code)** — на фронте используется message как код (campaignErrors); при желании добавить отдельное поле code в ответах бэкенда.

---

## 6. Дополнительные улучшения (ничего не упуская)

### 6.1 UI/UX

- **Загрузка и скелетоны:** на тяжёлых страницах при первой загрузке — скелетон/спиннер в контенте (частично есть; при необходимости добавить на группы/шаблоны).
- **Ошибки сети:** показывать сообщение и кнопку «Повторить» (реализовано на subscription, при необходимости тиражировать).
- **Доступность:** в DashboardHeader добавлены aria-label, aria-current, role="banner", aria-expanded для бургера.
- **Мобильная шапка:** реализовано бургер-меню для дашборда (dashboard-layout.css, tpl-header__burger, tpl-header__mobile-panel).

### 6.2 Бэкенд

- **Лимиты и пагинация:** без изменений; при росте данных — курсорная пагинация/батчи.
- **Индексы БД:** по docs/MIGRATIONS.md.
- **Rate limit:** реализован: POST /leads — RateLimitLeadsGuard 60/мин по IP; POST /log-client-error — RateLimitLogGuard 30/мин (common/rate-limit.guard.ts).

### 6.3 Интеграции

- **Проверка интеграций:** по docs/INTEGRATIONS-STATUS.md проверить Telegram, WhatsApp, Prodamus, Google Apps Script на реальных сценариях (подключение, оплата, синхронизация).
- **Переменные окружения:** в backend/.env.example добавлены комментарии (BIND_HOST, CORS_ORIGINS, REDIS_*, OTP_*, SUPABASE_TIMEOUT_MS, CAMPAIGN_REPEAT_*, ADMIN_PANEL_PASSWORD и др.).

### 6.4 Документация и код

- **Типизация:** постепенно заменять `any` на типы и DTO (особенно ответы API и тела запросов).
- **Чек-лист продакшена:** обновлять docs/PRODUCTION-READINESS-FULL-CHECKLIST.md по мере внедрения пунктов из этого отчёта.

---

## 7. Сводная схема: куда что встроено и как связано

```
[Лендинг /]     → auth (phone, code, register)
[Кабинет /cabinet] → Подписка, WA/TG блоки, CampaignBlock → /dashboard/campaigns
                   → /cabinet/subscription, /cabinet/support
[Дашборд] layout → DashboardHeader (навигация)
    ├── Рассылки   /dashboard/campaigns    → шаблоны, группы WA/TG, подписка, /dashboard/campaign
    ├── Шаблоны    /dashboard/templates   → /new, /[id], рассылки, группы
    ├── Группы WA  /dashboard/groups       → рассылки, шаблоны (цели WA), кабинет (WA)
    ├── Группы TG  /dashboard/groups/telegram → рассылки, шаблоны (цели TG), кабинет (TG)
    └── Аналитика  /dashboard/analytics  → /dashboard/campaign (прогресс по id)
[Админка /admin]  → отдельная зона, пользователи и доступ
```

---

Итог: единая шапка дашборда, константы каналов, useBackendSWR (subscriptions/me, campaigns/active), один маршрут групп (groups/telegram + редирект), DTO auth/subscriptions, rate limit leads и log-client-error, бургер-меню и aria-labels в дашборде, SheetsBlock/TemplatesSyncBlock в кабинете, удалён TelegramConnect. Чек-лист п. 5 и п. 6 частично закрыт; остаётся ручная проверка навигации и при необходимости — скелетоны на остальных тяжёлых страницах, DTO для admin и wa/tg.
