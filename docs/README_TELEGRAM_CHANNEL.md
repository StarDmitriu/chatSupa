# Telegram-канал в проекте: термины, архитектура, перенос, развитие

Документ зеркалирует структуру WhatsApp-README: термины, как устроен TG в **этом** репозитории, перенос, развитие.

---

## 1. Глоссарий терминов

| Термин | Значение |
|--------|----------|
| **MTProto** | Бинарный протокол Telegram для клиент–сервер; шифрование, RPC-запросы. Не HTTP REST в привычном виде. |
| **GramJS / пакет `telegram`** | Библиотека `telegram` на npm (часто называют GramJS) — клиент MTProto на TypeScript/JavaScript. В проекте: `import { TelegramClient } from 'telegram'`. |
| **api_id / api_hash** | Пара из [my.telegram.org](https://my.telegram.org): идентификатор приложения и секрет. Хранятся в **переменных окружения** (`TG_API_ID`, `TG_API_HASH`). Без них клиент не стартует. |
| **StringSession** | Строка-сессия GramJS: сериализованные ключи авторизации после успешного входа. У вас хранится в БД в поле пользователя **`users.tg_session`**, а не в отдельной папке как у WA. |
| **QR-логин Telegram** | Поток «отсканировать QR в приложении Telegram»: бэкенд держит `TelegramClient`, получает `tg://login?token=…`, фронт показывает QR. Реализовано в `TelegramQrService`. |
| **Логин по телефону (код + пароль 2FA)** | Альтернативный поток: номер → SMS/код → при 2FA пароль. Эндпоинты вида `/telegram/start`, `/telegram/confirm-code`, `/telegram/confirm-password` в `TelegramController`. |
| **AUTH_KEY_DUPLICATED** | Ошибка MTProto: один и тот же ключ сессии используется с **двух мест одновременно**. В коде сессия сбрасывается (`tg_session: null`), пользователю нужно перелогиниться. На это завязаны **per-user locks**. |
| **FLOOD_WAIT** | Telegram просит **подождать** (rate limit). В логике авторизации/отправки учитывается; при массовой рассылке критично соблюдать паузы. |
| **AUTH_KEY_UNREGISTERED** | Ключ сессии недействителен (сброшен на стороне TG и т.п.) — обрабатывается в сервисе при операциях вроде getDialogs. |
| **RPC** | Удалённый вызов в MTProto (`invoke` методов API Telegram). Ошибки приходят как RPC-исключения с кодами/сообщениями. |
| **TL (Type Language)** | Описание типов и методов API Telegram; GramJS генерирует обёртки (`Api`, сущности чатов и сообщений). |
| **`telegram_groups`** | Таблица/логика в Supabase: привязанные TG-чаты пользователя для рассылок, RPC для пагинации (см. миграции в репозитории). |
| **NestJS** | Backend-фреймворк; сервисы `TelegramService`, `TelegramQrService`. |
| **Next.js** | UI: `TelegramQrConnect.tsx`, страницы дашборда с проверкой `/telegram/qr/status`. |
| **BullMQ / воркер** | Очередь кампаний вызывает `TelegramService.sendToGroup`; при `telegram_not_connected` job может быть отложен/пауза. |

---

## 2. Как связано в коде

### Два входа в Telegram

1. **QR** (`TelegramQrService`, `telegram.qr.ts`):
   - `POST /telegram/qr/start` — старт, генерация QR;
   - `GET /telegram/qr/status/:userId` — статус (`not_connected`, `pending_qr`, `awaiting_password`, `connected`, `error`);
   - при наличии `tg_session` в БД — периодическая проверка «живости» через короткое `connect` + `getMe` (кэш ~30 с), чтобы кабинет не врал про `connected`.

2. **Телефон** (`TelegramService.startAuth`, `confirmCode`, `confirmPassword`):
   - для сценариев без QR (если включено в продукте).

### Сессии в памяти

- `sessions: Map<userId, TelegramClient>` — активные клиенты для отправки и RPC.
- `pending` / `pending` в QR-сервисе — клиенты в процессе авторизации.

### Кампании

- `campaign.worker.ts` / `campaigns.service.ts`: перед отправкой проверяется статус; отправка медиа через загрузку по URL, `CustomFile`, HTML из шаблона.

Ключевые файлы:

- `backend/src/telegram/telegram.service.ts`
- `backend/src/telegram/telegram.qr.ts`
- `backend/src/telegram/telegram.controller.ts`
- `frontend/src/components/TelegramQrConnect.tsx`

---

## 3. Перенос на другой сервер (чеклист)

1. **Код** и **`.env`**: `TG_API_ID`, `TG_API_HASH`, Supabase, Redis, JWT и остальное.
2. **База**: строка **`users.tg_session`** для каждого пользователя — это и есть сохранённая авторизация GramJS. Резервное копирование БД = копирование TG-сессий (наряду с прочими данными).
3. **Не запускать два процесса** с одной и той же сессией одновременно — риск **AUTH_KEY_DUPLICATED**; в коде есть блокировки per `userId`, но архитектурно лучше один writer на пользователя.
4. **Сеть**: стабильный исходящий доступ к дата-центрам Telegram (иногда релевантны прокси/geolocation — по политике Telegram и хостинга).
5. Сборка и запуск как для остального backend (`nest build`, `pm2`).

Папки вида `wa_auth` к Telegram **не относятся** — сессия TG в **Postgres** (Supabase).

---

## 4. Отличия от WhatsApp (в одном абзаце)

| | WhatsApp (Baileys) | Telegram (GramJS) |
|--|-------------------|-------------------|
| Протокол | WhatsApp Web | MTProto |
| Хранение сессии | Файлы в `wa_auth/<userId>/` | Строка `users.tg_session` |
| Подключение в UI | QR через Baileys | QR (`TelegramQrService`) или телефон |
| Типичные ошибки обрыва | 408, ETIMEDOUT, WebSocket | FLOOD_WAIT, AUTH_KEY_*, RPC errors |

---

## 5. Ограничения и риски

- Клиентский MTProto через **GramJS** — **не** Bot API: это пользовательский аккаунт; правила Telegram про автоматизацию и массовые рассылки нужно соблюдать.
- **FLOOD_WAIT** и лимиты — при «мессенджере + ИИ» обязательны бэкпрешер, очереди, уважение к задержкам.

---

## 6. Перспектива: полноценный клиент + ИИ

| Направление | Идея |
|-------------|------|
| **Диалоги в реальном времени** | Подписка на `NewMessage`, хранение истории в своей БД, UI списка чатов. |
| **Синхронизация** | `getDialogs`, инкрементальные updates, аккуратно с памятью и лимитами. |
| **ИИ** | Тот же паттерн: входящее → очередь → модель → `sendMessage`; защита от циклов и флуда. |
| **Масштаб** | Шардирование по процессам, один активный клиент на `userId`, мониторинг RPC-ошибок. |

---

## 7. Зависимости (backend)

- `telegram` (GramJS) — см. `backend/package.json`

---

## 8. Ошибки доставки и поддержка

Сценарии для операторов (без рекомендации «сначала убрать чаты из шаблона»): [TELEGRAM_DELIVERY_SUPPORT.md](./TELEGRAM_DELIVERY_SUPPORT.md).
