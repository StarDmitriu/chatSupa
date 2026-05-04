# WhatsApp: жизненный цикл сообщения и прод-дебаг

Документ описывает путь одного сообщения в WhatsApp-рассылке: от `campaign_jobs` до отправки в группу, включая статусы, обработку лимитов и SQL-диагностику.

---

## 1) Архитектура канала WhatsApp в проекте

- Транспорт WhatsApp: `Baileys` (`@whiskeysockets/baileys`).
- Сервис отправки: `backend/src/whatsapp/whatsapp.service.ts`.
- Контроллер: `backend/src/whatsapp/whatsapp.controller.ts`.
- Оркестрация job: `backend/src/queue/campaign.worker.ts`.
- Auth-состояние WA: файловая сессия в `wa_auth/<userId>` (через `useMultiFileAuthState`).
- Статус сессии WA хранится в памяти сервиса (`not_connected`, `connecting`, `pending_qr`, `connected`, `error`).

---

## 2) End-to-end: путь одного WA-сообщения

### Шаг 1. Воркер берет job

Файл: `backend/src/queue/campaign.worker.ts`.

- Читает `campaign_jobs` по `jobId`.
- Если запись не найдена — удаляет stale-job и завершает.
- Если статус не `pending` — завершает без действий.

### Шаг 2. Предпроверки и блокировка

- Проверяет `campaigns` (`stopped`/`paused`).
- Переводит `pending -> processing`.
- Повторно проверяет `stopped` после захвата.

### Шаг 3. Проверка шаблона и доступа

- Читает `message_templates`.
- `template_not_found` -> `failed`.
- `template_disabled` -> `skipped`.
- Проверяет подписку через `hasAccessForChannel(userId, 'wa')`.
- При отсутствии доступа ставит кампанию/джобы в `paused`.

### Шаг 4. Маршрутизация в WA-канал

- Ветка `channel === 'wa'` вызывает `whatsapp.sendToGroup(...)` с таймаутом 60с.
- Если в WA-job попал numeric TG id -> `failed/wrong_target_for_wa`.

### Шаг 5. Проверка WA-сессии

Перед отправкой воркер проверяет `whatsapp.getStatus(userId)`:

- Если `connected` -> отправка.
- Если `connecting` -> мягкий рескедул конкретной job (25-35с), статус обратно `pending`.
- Если не подключен (не connecting) -> кампанию/джобы в `paused` с `wa_not_connected`.

### Шаг 6. Отправка в `WhatsappService.sendToGroup`

Файл: `backend/src/whatsapp/whatsapp.service.ts`.

- Проверяет активный `sock` и `status === connected`.
- Готовит текст (`templateMarkdownToWhatsAppText`).
- Варианты отправки:
  - только текст;
  - медиа с определением типа (video/image/audio/document);
  - fallback на текст при проблемах скачивания/валидации медиа.
- Отправка идет через `sendMessageWithRateLimitRetry`.

### Шаг 7. Финализация

- Успех: `status='sent'`, `error=null`, `sent_at=now`.
- Ошибка: `failed` + запись текста ошибки.
- Дополнительно: `whatsapp_groups.last_send_error` обновляется для UI.

---

## 3) Таблица статусов `campaign_jobs` (WhatsApp)

| Событие | Новый статус | Поле `error` | Что видит пользователь |
|---|---|---|---|
| Job взят в работу | `processing` | `null` | В процессе |
| Успешная отправка | `sent` | `null` | Отправлено |
| Кампания остановлена | `skipped` | `campaign_stopped` | Пропущено |
| Кампания на паузе | `paused` | `campaign_paused` | На паузе |
| Шаблон не найден | `failed` | `template_not_found` | Ошибка шаблона |
| Шаблон выключен | `skipped` | `template_disabled` | Пропущено |
| Подписка/план не позволяет | `paused` | `subscription_expired` / `trial_expired` / `plan_not_allowed` / ... | Нужна подписка/доступ |
| WA в `connecting` | `pending` + перенос `scheduled_at` | `null` | Небольшая авто-задержка и повтор |
| WA не подключен | `paused` (обычно по кампании) | `wa_not_connected` | Нужна перепривязка WA |
| Неверный target для WA | `failed` | `wrong_target_for_wa` | Ошибка маршрутизации |
| Прочая ошибка отправки | `failed` | Текст ошибки | Ошибка доставки |

---

## 4) Специфичная обработка лимитов/ошибок WA

### WA rate-limit при `sendMessage`

В `sendMessageWithRateLimitRetry`:

- Ловит `rate-overlimit` / `retry-after`.
- Пишет событие в `limit_learning_events` (`channel='wa'`, `event_type='wa_rate_limit'`).
- Ждет `SEND_RATE_LIMIT_RETRY_DELAY_MS` (30с).
- Делает повторную отправку.

Важно: это ретрай внутри одной попытки отправки сервиса; на уровне воркера такие кейсы обычно не превращаются в отдельный delayed-job как TG FloodWait.

### WA disconnect и user-friendly диагностика

В `connection.update`:

- Обрабатываются коды `401/403/408/411/428/440/500/503/515`.
- Для части кодов отключает авто-ретрай и переводит в `error`.
- Для конфликтов (`401 conflict`, `440`) чистит auth-dir по таймеру, чтобы следующий запуск дал свежий QR.

### Медиа fallback

- Если медиа не скачалось/битое — отправляется текст.
- Для unknown типа медиа — также текстовый fallback.

---

## 5) Где смотреть проблемы на проде

- Основные статусы: `campaign_jobs`.
- Ошибки по WA-группам: `whatsapp_groups.last_send_error`, `last_send_error_at`.
- События лимитов WA: `limit_learning_events` (`channel='wa'`).
- Состояние подключения пользователя: эндпоинт `GET /whatsapp/status/:userId` + логика сессии в памяти.

---

## 6) SQL: быстрая диагностика WhatsApp

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

### 6.2 Проблемные job по кампании

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

### 6.3 Подвисшие `pending` (часто WA connecting/рескедул)

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
order by scheduled_at asc
limit 200;
```

### 6.4 Лимиты WA по пользователю

```sql
select
  created_at,
  event_type,
  seconds,
  label,
  left(error, 200) as error
from limit_learning_events
where user_id = :user_id
  and channel = 'wa'
order by created_at desc
limit 200;
```

### 6.5 Ошибки по WA-группам (для UI и triage)

```sql
select
  wa_group_id,
  subject,
  last_send_error,
  last_send_error_at
from whatsapp_groups
where user_id = :user_id
  and last_send_error is not null
order by last_send_error_at desc nulls last
limit 200;
```

---

## 7) Чек-лист быстрого triage (WhatsApp)

1. Проверить `campaign_jobs` (распределение по статусам).
2. Если много `paused` с `wa_not_connected` — проверить WA-сессию/QR.
3. Если много `pending` и `scheduled_at` в будущем — дождаться рескедула.
4. Если `failed` — посмотреть `error` и сопоставить с таблицей статусов.
5. Проверить `whatsapp_groups.last_send_error` для проблемных групп.
6. Проверить `limit_learning_events` по WA rate-limit.

