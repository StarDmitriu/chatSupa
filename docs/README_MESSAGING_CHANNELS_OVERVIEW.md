# Каналы мессенджеров: обзор проекта (WhatsApp + Telegram)

Один документ «связка»: общий стек, как каналы сосуществуют, документы по отдельности, деплой и вектор развития.

---

## 1. Два подробных README

| Канал | Файл |
|-------|------|
| **WhatsApp** (Baileys, файлы `wa_auth`, QR, transient 408, зонд `web.whatsapp.com`) | [README_WHATSAPP_CHANNEL.md](./README_WHATSAPP_CHANNEL.md) |
| **Telegram** (GramJS, `tg_session` в БД, QR + телефон, MTProto, FLOOD_WAIT) | [README_TELEGRAM_CHANNEL.md](./README_TELEGRAM_CHANNEL.md) |

Термины (**RTT**, **WebSocket**, **сессия**, **очередь** и т.д.) расписаны там; этот файл не дублирует глоссарий, а описывает **общую картину**.

---

## 2. Общий технический стек

| Слой | Технологии |
|------|------------|
| **Frontend** | Next.js (React), компоненты кабинета и дашборда |
| **Backend** | NestJS, модули `whatsapp`, `telegram`, `campaigns`, `queue` |
| **БД / BaaS** | Supabase (Postgres): пользователи, группы, кампании, `tg_session` |
| **Очереди** | BullMQ + Redis: несколько очередей `campaign-send-{shard}` (см. `CAMPAIGN_SEND_SHARD_COUNT`) + опционально осушение легаси `campaign-send` |
| **Процессы** | Типично PM2: `backend`, `frontend` |
| **WA-сессии** | Файловая система сервера: `backend`-рабочая директория → `wa_auth/<userId>/` |
| **TG-сессии** | Поле `users.tg_session` (StringSession GramJS) |

---

## 3. Как каналы связаны в продукте

1. **Личный кабинет** — блоки подключения WhatsApp и Telegram (якоря `#whatsapp`, `#telegram` и т.п.).
2. **Кампании** — канал задаётся в шаблоне/кампании; воркер ветвится на WA или TG (`sendToGroup` / аналог).
3. **Восстановление после коннекта** — и WA, и TG после успешного подключения планируют **возобновление** отложенных job’ов (`autoResumeDisconnectedJobsForUser`, `autoWakeConnectivityRetryJobsForUser`) с разными задержками env (`TG_POST_CONNECT_RESUME_DELAY_MS` и аналоги для WA).
4. **Ошибки «не подключено»** — `whatsapp_not_connected`, `telegram_not_connected`: задачи ставятся на паузу/ретрай, UI ведёт в кабинет.

---

## 4. Переменные окружения (ориентир)

Точный список — в `.env.example` (если есть) и в коде. Минимально для мессенджеров:

- **Telegram:** `TG_API_ID`, `TG_API_HASH`
- **WhatsApp:** отдельные ключи при использовании внешних сервисов не обязательны для Baileys; важны пути данных и сеть
- **Общие:** Supabase, Redis, JWT, `NEXT_PUBLIC_BACKEND_URL`, URL фронта для CORS/прокси — по вашему деплою
- **Параллельные рассылки:** `CAMPAIGN_SEND_SHARD_COUNT` (1 … `CAMPAIGN_SEND_MAX_SHARD_COUNT`). Если **не задано**, в коде **20** шардов — ориентир на **~20 одновременно активных** аккаунтов (кабинет + рассылки); для **~10 постоянных** пользователей с запасом тоже ок. Потолок шардов по умолчанию **1024** (`CAMPAIGN_SEND_MAX_SHARD_COUNT`, hard cap 1024). Для 256/512/1024 используйте готовые `docker-compose.workers-*.yml` overlays с явными `CAMPAIGN_SEND_WORKER_SHARD_START/END`; worker без range не стартует выше `CAMPAIGN_SEND_WORKER_MAX_UNPARTITIONED_SHARDS` (по умолчанию 64). **Один `userId`**: задачи **WA** и **TG** попадают в **один шард** и выполняются **по очереди** (в один момент не уходит параллельно в оба мессенджера). **Разные пользователи** на разных шардах могут идти параллельно. `=1` — одна очередь `campaign-send`. При N>1 воркер осушает легаси `campaign-send`; **`runSerializedByUser`** страхует гонки легаси/шард для одного пользователя.
- **Мониторинг очередей:** задайте **`INTERNAL_METRICS_KEY`**, затем `GET /health/campaign-queues` с заголовком **`X-Internal-Metrics-Key`**. Без ключа маршрут отвечает **404**. Удобно для алертов по росту `waiting`/`delayed`.
- **Ресурсы при «любой сервер можно»:** для **10–20 онлайн** с WA+TG разумно **2–4 GB RAM** у VPS и при необходимости **`NODE_OPTIONS=--max-old-space-size=4096`** — Baileys держит сокеты и буферы в одном Node-процессе; узкие места часто **FLOOD Telegram** и **обрывы WA**, а не только CPU.

**Не коммитить** реальные секреты.

---

## 5. Клонирование проекта на новый сервер (краткий чеклист)

1. Клон репозитория, установка зависимостей, `npm run build` в `backend` и `frontend`.
2. Перенос **`.env`**.
3. **Postgres / Supabase** — миграции, данные (в т.ч. `tg_session`).
4. **Файлы `wa_auth/`** — целиком, если нужно сохранить WA без повторного QR.
5. **Redis** — для очередей; при переносе без данных очередь «с нуля».
6. Проверка исходящей сети до WhatsApp и Telegram.
7. `pm2 start` / systemd / Docker — по принятому у вас способу.

---

## 6. Вектор «полноценный мессенджер + ИИ»

Оба README в конце содержат раздел про развитие. Общее:

- **Единый слой сообщений** в БД (thread_id, direction, payload) поверх событий Baileys/GramJS.
- **Очереди и rate limit** — отдельно для WA и TG (разные лимиты и ошибки).
- **ИИ** — изолированный pipeline с идемпотентностью и политиками.
- **Юридический контур** — пользовательский клиент (GramJS / Baileys) vs официальные API (WhatsApp Cloud API, Telegram Bot API) при масштабировании B2B.

---

## 7. Быстрая навигация по коду

| Назначение | Путь |
|------------|------|
| WA сервис | `backend/src/whatsapp/whatsapp.service.ts` |
| WA UI | `frontend/src/components/WhatsappConnectBlock.tsx` |
| TG сервис | `backend/src/telegram/telegram.service.ts` |
| TG QR | `backend/src/telegram/telegram.qr.ts` |
| TG UI QR | `frontend/src/components/TelegramQrConnect.tsx` |
| Воркер кампаний | `backend/src/queue/campaign.worker.ts` |
| Очереди / шардирование | `backend/src/queue/queue.service.ts` |
| Классификатор ошибок доставки | `backend/src/queue/delivery-error-classifier.ts` |
| Метрики очередей | `backend/src/queue/campaign-queue-metrics.controller.ts` |
| VIP-приоритет / синхронизация с БД | `backend/src/queue/campaign-vip.service.ts` |
| Кампании | `backend/src/campaigns/campaigns.service.ts` |

**Эксплуатация очередей** (метрики, алерты, смена шардов, VIP): [CAMPAIGN_QUEUE_RUNBOOK.md](./CAMPAIGN_QUEUE_RUNBOOK.md)

**Продвинутые темы** (отдельный воркер, вынос WA): [CAMPAIGN_ADVANCED_OPERATIONS.md](./CAMPAIGN_ADVANCED_OPERATIONS.md)

---

*Документ можно дополнять ссылками на внутренние runbook’и по мере появления.*
