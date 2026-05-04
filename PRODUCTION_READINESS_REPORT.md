# Исследование готовности сайта ЧатРассылка к продакшену

**Дата:** 07.02.2026  
**Задача:** оценить готовность к продакшену, что работает, что не доделано. Код и конфиги не изменялись.

---

## 1. Общая архитектура

- **Frontend:** Next.js 16 (App Router), React 19, порт 3001, `output: standalone` для Docker.
- **Backend:** NestJS 11, порт 3000, Redis (BullMQ), Supabase (users, leads, подписки).
- **Инфраструктура:** Docker Compose (redis, backend, frontend, nginx), nginx — 80/443, проксирование `/api/` на backend, остальное на frontend.
- **Домен:** chatrassylka.ru, www; в nginx настроен редирект HTTP→HTTPS и SSL (Let's Encrypt).

Архитектура для продакшена подходит: разделение сервисов, healthcheck’и, лимиты CPU/RAM, логи.

---

## 2. Backend — что работает и что требуется

### 2.1 Обязательные переменные окружения

Бэкенд **не стартует** без:

- `SUPABASE_URL`, `SUPABASE_KEY` (или `SUPABASE_SERVICE_ROLE_KEY`) — пользователи, лиды, подписки.
- `JWT_SECRET` — выдача и проверка токенов.

В `docker-compose.yml` они закомментированы и должны быть в `backend/.env`.

### 2.2 Модули и функциональность

| Модуль | Назначение | Зависимости / примечания |
|--------|------------|---------------------------|
| Auth | Вход по SMS-коду, JWT, профиль | SUPABASE, JWT_SECRET, SMS (см. ниже) |
| Supabase | users, lead_requests, подписки | SUPABASE_URL, KEY |
| SMS | Отправка кода (sms.ru) | `SMSRU_API_ID` — если не задан, в лог пишется «DEV mode: SMS не отправляем» |
| Telegram | QR-авторизация, группы, кампании | `TG_API_ID`, `TG_API_HASH` — в compose закомментированы |
| WhatsApp | Baileys, группы, кампании | Supabase (сессии в БД) |
| Campaigns | Запуск/остановка кампаний, повтор | Redis, BullMQ, Telegram/WhatsApp |
| Templates | Шаблоны, медиа, цели | — |
| Queue | Очереди кампаний | REDIS_HOST, REDIS_PORT (в compose заданы) |
| Sheets | Интеграция с Google Apps Script | `APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET` — опционально |
| Payments (Prodamus) | Оформление подписки, webhook | При вызове создания платежа проверяется: `PRODAMUS_FORM_URL`, `PRODAMUS_SECRET_KEY`, `PRODAMUS_SYS`. Если не заданы — ошибка при обращении к оплате |
| Leads | Заявки с лендинга | Supabase, таблица lead_requests |
| Admin | Пользователи, блокировка, trial/доступ | JWT + проверка is_admin в Supabase |

Итог: ядро (auth, кабинет, кампании, шаблоны, Telegram/WhatsApp) может работать при наличии SUPABASE и JWT. Для продакшена нужны: SMS (SMSRU), при необходимости Telegram (TG_*), оплата (PRODAMUS_*), при желании Sheets (APPS_SCRIPT_*).

### 2.3 Недоделки / риски (без правок кода)

- **SMS:** без `SMSRU_API_ID` коды входа не отправляются — только лог. Для прода — переменная обязательна.
- **Оплата:** без `PRODAMUS_*` создание платежа и webhook падают с «Missing env». Для тарифов — переменные обязательны.
- **Telegram:** без `TG_API_ID` / `TG_API_HASH` функциональность Telegram (QR, группы) не будет работать.
- **Логирование:** в коде есть `console.log`/`console.warn` (auth, payments, telegram, queue). Для прода лучше единый логгер (например, Pino уже в зависимостях) и без вывода секретов.
- **Prodamus:** в коде есть `console.log('SECRET:', ...)` — риск утечки секрета в логах; желательно убрать при следующем рефакторинге.

---

## 3. Frontend — что работает и что не доделано

### 3.1 Маршруты и защита

- Лендинг `/`, форма заявки, ссылки на кабинет, тарифы, якоря (#about, #how, #pricing).
- Авторизация: `/auth/phone` → код `/auth/code` → при необходимости регистрация `/auth/register` → `/cabinet`.
- Кабинет `/cabinet`, подписка `/cabinet/subscription`, поддержка `/cabinet/support`.
- Dashboard: шаблоны (`/dashboard/templates`, new, [templateId]), группы (`/dashboard/groups`, `/dashboard/telegram-groups`), кампании (`/dashboard/campaigns`, `/dashboard/campaign`).
- Админка `/admin` — доступ по JWT + is_admin на бэкенде.

Проверка доступа: **нет единого middleware**. В кабинете и дашборде при отсутствии токена или при неуспешном `/auth/me` делается редирект на `/auth/phone`. То есть защита — на клиенте и через API; при отключённом JS страницы дашборда/кабинета могут отрисоваться до редиректа, но API без токена не отдаст данные.

### 3.2 API и ошибки

- Запросы идут на `NEXT_PUBLIC_BACKEND_URL` (в проде через rewrites на backend). Таймаут 20 с, есть обработка сетевых ошибок и ApiError.
- Токен хранится в cookie, передаётся в заголовке Authorization.

### 3.3 Недоделки / SEO (без правок кода)

- **Layout:** `lang="en"` при русском контенте; нет экспорта `metadata` (title, description, Open Graph). Нет `robots.txt`, `sitemap.xml` — как и описывалось в SEO-аудите.
- **Шрифт:** Manrope только `subsets: ['latin']`, кириллица не подключена — возможны проблемы с отображением русского текста в части символов.
- **Плейсхолдеры:** в формах используются обычные `placeholder` (текст подсказок), не заглушки функциональности.
- **Маскировка телефона:** в коде ввода кода отображается вид «XX XXX XXX-XX-XX» (в коде есть строка с «XXX» в середине) — это маскировка номера, а не недоделка.

---

## 4. Инфраструктура и деплой

### 4.1 Docker Compose

- Сервисы: redis (с volume и healthcheck), backend (env_file: backend/.env, healthcheck по корню), frontend (healthcheck по :3001), nginx (80/443, volumes для certbot).
- Зависимости: frontend и nginx ждут здоровый backend; backend ждёт redis. Порядок запуска корректен.
- Переменные для backend частично в compose, частично должны быть в `backend/.env` (SUPABASE, JWT, при необходимости SMS, TG, PRODAMUS, APPS_SCRIPT).

### 4.2 Nginx

- HTTP→HTTPS редирект, сервер для chatrassylka.ru и www.
- SSL: сертификаты из `/etc/letsencrypt/live/chatrassylka.ru/` (в контейнере маппятся из `./deploy/certbot/conf`). Для работы HTTPS сертификаты должны быть получены (certbot) и лежать в этом пути.
- `location /api/` → proxy_pass на backend:3000.
- `location /` → proxy_pass на frontend:3001.
- Для OPTIONS в `/api/` отдаётся 204 с CORS-заголовками.

Критично: при отсутствии файлов сертификатов nginx не запустится или не откроет 443.

### 4.3 Сборка

- В среде проверки не было npm, сборка frontend/backend не запускалась. Рекомендуется перед деплоем выполнить `npm run build` в backend и frontend и убедиться, что артефакты собираются без ошибок.

---

## 5. Безопасность и продакшен

- **CORS:** backend — `origin: '*'`; nginx добавляет `Access-Control-Allow-Origin: $http_origin`. Для прода при желании можно сузить origin до домена.
- **Секреты:** JWT_SECRET, ключи Supabase, Prodamus, SMS, Telegram не должны попадать в репозиторий; используются через env и env_file. Файлы `.env` в .gitignore — проверено.
- **Админка:** доступ по JWT + проверка is_admin в БД (AdminGuard). Отдельного «секретного» URL нет — защита только ролью.

---

## 6. Краткий чек-лист готовности к продакшену

| Категория | Статус | Комментарий |
|-----------|--------|-------------|
| Сборка backend/frontend | Не проверялась | Запустить `npm run build` в обоих проектах |
| Запуск по Docker Compose | Ожидаемо ок | Зависимости и healthcheck’и настроены |
| SSL (HTTPS) | Зависит от сертификатов | Нужны реальные сертификаты в deploy/certbot/conf |
| Auth (вход по SMS) | Работает при наличии SMSRU | Иначе только режим «логируем код» |
| JWT + Supabase | Обязательны | Без них backend не стартует |
| Оплата (Prodamus) | Работает при наличии PRODAMUS_* | Иначе ошибка при создании платежа |
| Telegram | Работает при наличии TG_* | Иначе функциональность Telegram недоступна |
| Защита маршрутов frontend | Клиентская + API | Нет server-side middleware, приемлемо при доверии к API |
| SEO (metadata, robots, sitemap) | Не сделано | lang, мета-теги, кириллица шрифта — по прежнему из аудита |
| Логи и секреты | Есть риски | Убрать вывод секретов в лог; по возможности перейти на единый логгер |

---

## 7. Итог

- **Работоспособность:** при корректном `backend/.env` (SUPABASE, JWT_SECRET, при необходимости SMSRU, TG_*, PRODAMUS_*) и наличии SSL-сертификатов приложение можно выводить в продакшен: авторизация, кабинет, кампании, шаблоны, группы, лиды с лендинга и админка реализованы и связаны с бэкендом.
- **Недоделки:** без перечисленных env часть функций (SMS, оплата, Telegram) не будет работать; SEO (мета-теги, robots, sitemap, lang, шрифт) не делались; в коде есть места с логированием секретов и разрозненным использованием console.
- **Никаких правок в код и конфиги в рамках этого исследования не вносилось.**
