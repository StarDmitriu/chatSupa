# Telegram: жизненный цикл сообщения и прод-дебаг

Документ описывает полный путь одного сообщения в Telegram-рассылке: от `campaign_jobs` до фактической отправки в группу/канал, включая статусы, ошибки и SQL для быстрой диагностики.

---

## 1) Архитектура канала Telegram в проекте

- Транспорт Telegram: `GramJS` (`telegram` npm-пакет).
- Протокол: MTProto (подключение как пользовательский аккаунт, не Bot API).
- Сервис отправки: `backend/src/telegram/telegram.service.ts`.
- Контроллер: `backend/src/telegram/telegram.controller.ts`.
- Авторизация/QR/2FA: `backend/src/telegram/telegram.qr.ts`.
- Оркестрация job: `backend/src/queue/campaign.worker.ts`.
- Сессия Telegram: сохраняется в `users.tg_session` (Supabase).

---

## 2) End-to-end: путь одного TG-сообщения

### Шаг 1. Воркер берет job

Файл: `backend/src/queue/campaign.worker.ts` (`process(job)`).

- Читает `campaign_jobs` по `jobId`.
- Если записи нет — удаляет stale-job из очереди и завершает.
- Если `status != 'pending'` — завершает без действий.

### Шаг 2. Предпроверки кампании и атомарная блокировка

- Проверяет `campaigns`: если `stopped` -> `skipped`, если `paused` -> `paused`.
- Переводит job из `pending` в `processing`.
- Повторно проверяет, не остановлена ли кампания после захвата.

### Шаг 3. Получение шаблона

- Загружает `message_templates` (`text`, `media_url`, `send_media_as_file`, `enabled`).
- Если не найден: `failed/template_not_found`.
- Если отключен: `skipped/template_disabled`.

### Шаг 4. Проверка подписки/доступа

- Через `SubscriptionsService.hasAccessForChannel(userId, 'tg')`.
- Если доступа нет: ставит кампанию/джобы в `paused` с причиной (`reason`).

### Шаг 5. Маршрутизация в TG-канал

- Для `channel === 'tg'` вызывает `telegram.sendToGroup(...)` с таймаутом 90с.
- Валидация направления: если в TG-job попал WA jid (`@g.us`) -> `failed/wrong_target_for_tg`.

### Шаг 6. Отправка в `TelegramService.sendToGroup`

Файл: `backend/src/telegram/telegram.service.ts`.

- Восстанавливает клиента из `users.tg_session` через `StringSession`.
- При отсутствии/битой сессии -> ошибка (`telegram_not_connected` и т.п.).
- Достает peer-данные из `telegram_groups` (`tg_type`, `tg_access_hash`).
- Для channel/supergroup пытается `getInputEntity`, fallback на `InputPeerChannel`.
- Конвертирует форматирование текста в Telegram HTML.
- Отправляет:
  - без медиа: `sendMessage`;
  - с медиа: `sendFile` (URL-путь для изображений + fallback на download + типизация image/video/audio).
- Если медиа не скачалось, делает fallback: отправка только текста.

### Шаг 7. Финализация job

- Успех: `campaign_jobs.status = 'sent'`, `error = null`, `sent_at = now`.
- Ошибка: либо adaptive reschedule (FloodWait), либо `failed`.

---

## 3) Таблица статусов `campaign_jobs` (Telegram)

| Событие | Новый статус | Поле `error` | Что видит пользователь |
|---|---|---|---|
| Job взят в обработку | `processing` | `null` | Сообщение "в процессе" |
| Успешная отправка | `sent` | `null` | Отправлено |
| Кампания остановлена | `skipped` | `campaign_stopped` | Пропущено (остановлено) |
| Кампания на паузе | `paused` | `campaign_paused` | На паузе |
| Нет шаблона | `failed` | `template_not_found` | Ошибка шаблона |
| Шаблон выключен | `skipped` | `template_disabled` | Пропущено (шаблон off) |
| Неверный target для TG | `failed` | `wrong_target_for_tg` | Ошибка канала/группы |
| Подписка/план не позволяет отправку | `paused` | `subscription_expired` / `trial_expired` / `plan_not_allowed` / ... | Нужно продлить/сменить план |
| FloodWait от Telegram | `pending` + перенос `scheduled_at` | `tg_flood_wait_{N}s` | Временное ограничение, авто-повтор |
| Прочая ошибка отправки | `failed` | Текст ошибки | Ошибка доставки |

---

## 4) Специфичная обработка ошибок Telegram

### FloodWait (rate limit)

В `campaign.worker.ts`:

- Парсит `"A wait of N seconds is required"`.
- Пишет событие в `limit_learning_events` (`tg_flood_wait`).
- Считает адаптивную задержку (`N + буфер + jitter`).
- Возвращает job в `pending`, ставит новый `scheduled_at`.
- Создает новую delayed-job в BullMQ.

### AUTH_KEY_DUPLICATED / битая сессия

В `telegram.service.ts`:

- При `AUTH_KEY_DUPLICATED` очищает `users.tg_session = null`.
- Это предотвращает бесконечные попытки автоподключения с испорченным ключом.

### Ошибки peer/access_hash

- Для channel/supergroup сначала `getInputEntity(rawId)` (приоритетный путь).
- Fallback на `InputPeerChannel` с `tg_access_hash` из БД.

---

## 5) Где смотреть ошибки на проде

- Основной статус отправки: таблица `campaign_jobs`.
- Ошибка последней отправки по группе: `telegram_groups.last_send_error`, `last_send_error_at`.
- Обучающие события лимитов: `limit_learning_events` (`channel='tg'`).

---

## 6) SQL: быстрая диагностика Telegram

### 6.1 Срез по кампании

```sql
select
  status,
  count(*) as cnt
from campaign_jobs
where campaign_id = :campaign_id
group by status
order by status;
```

### 6.2 Последние проблемные job по кампании

```sql
select
  id,
  status,
  error,
  scheduled_at,
  sent_at,
  group_jid,
  template_id
from campaign_jobs
where campaign_id = :campaign_id
  and status in ('failed', 'paused', 'skipped', 'pending')
order by updated_at desc
limit 100;
```

### 6.3 Отложенные из-за FloodWait

```sql
select
  id,
  status,
  error,
  scheduled_at,
  now() as now_utc,
  (scheduled_at - now()) as eta
from campaign_jobs
where campaign_id = :campaign_id
  and status = 'pending'
  and error like 'tg_flood_wait_%'
order by scheduled_at asc
limit 100;
```

### 6.4 Лимиты/обучение по пользователю (TG)

```sql
select
  created_at,
  event_type,
  seconds,
  label,
  left(error, 200) as error
from limit_learning_events
where user_id = :user_id
  and channel = 'tg'
order by created_at desc
limit 200;
```

### 6.5 Ошибки по TG-группам в UI

```sql
select
  tg_chat_id,
  title,
  last_send_error,
  last_send_error_at
from telegram_groups
where user_id = :user_id
  and last_send_error is not null
order by last_send_error_at desc nulls last
limit 200;
```

---

## 7) Чек-лист быстрого triage (Telegram)

1. Проверить `campaign_jobs` (статусы + `error`).
2. Если много `pending` — сверить `scheduled_at` (FloodWait/переносы).
3. Если `paused` — проверить подписку и channel-доступ.
4. Если `failed` — взять `error` и сопоставить с таблицей статусов.
5. Проверить `telegram_groups.last_send_error` для влияния на конкретные чаты.
6. Проверить `limit_learning_events` (частота flood wait, тренд).

