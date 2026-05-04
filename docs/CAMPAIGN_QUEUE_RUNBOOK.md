# Рассылки: метрики, шардирование, VIP — эксплуатация и алерты

Связано с кодом: `queue.service.ts`, `campaign.worker.ts`, `campaigns.service.ts`, `campaign-vip.service.ts`, `campaign-queue-metrics.controller.ts`.

---

## 1. Метрики (P0): `GET /health/campaign-queues`

### Включение

1. В `.env` задать **`INTERNAL_METRICS_KEY`** (длинная случайная строка).
2. Запрос: заголовок **`X-Internal-Metrics-Key: <значение>`**.
3. Без ключа в env — **404**; неверный ключ — **403** (не светим структуру очередей публично).

### Поля ответа (кратко)

| Поле | Смысл |
|------|--------|
| `queues.<name>.*` | По каждой очереди: `waiting`, `active`, `delayed`, `paused`, `prioritized`, `waitingChildren`, `failed` |
| `summary.totals` | Сумма по всем очередям |
| `summary.maxWaitingQueue` / `maxDelayedQueue` / `maxFailedQueue` | Где «жирнее» всего хвост (удобно для алертов) |
| `skew.*` | Перекос **только между шардами** `campaign-send-0` … `campaign-send-(N-1)` |
| `skew.legacyWaiting` | Хвост в легаси **`campaign-send`** при `CAMPAIGN_SEND_SHARD_COUNT > 1` (должен сходить к 0 после осушения) |
| `workerListenerCount` | Число подписок воркера (= число имён очередей); при N>1 это **N + 1** (шарды + легаси) |
| `concurrencyPerListener` | Сейчас всегда **1** (см. `CampaignBullWorker`) |
| `campaignVip` | `{ mergedCount, lastRefreshAt, lastDbError, dbSyncEnabled }` — без списка UUID |
| `failedSummary.windows` | Сводка причин `failed` за 1ч/24ч: top reasons по `wa`/`tg` (normalized code) |

### Как читать цифры вместе с логикой воркера

- **`delayed`** часто растёт при **TG FLOOD_WAIT** и **WA/TG connectivity retry** — это не обязательно поломка.
- **`failed`** — job в Redis в статусе failed (`removeOnFail: false` для send). Рост требует разбора (шаблон, peer, сеть).
- **`prioritized`** — job с полем priority в ожидании; полезно при **VIP** и диагностике голодания очереди.
- **`active`** держится долго при **ритме кампании** (`enforceCampaignSendRhythm`, sleep), **таймаутах send** (TG до 90s, WA с медиа до 120s) и тяжёлой отправке. У воркера **`lockDuration: 120_000` ms** — при аномально долгой обработке смотрите логи stall в BullMQ.

### Примеры порогов для алертов (подстроить под базовую линию)

- `summary.totals.waiting > <база> * 3` в течение **15 минут**.
- `summary.totals.failed` растёт монотонно **сутки** — проверка Redis/логов.
- `skew.coefficientOfVariation` **> 0.5** при **равномерной** нагрузке пользователей — перекос шардов или один «тяжёлый» аккаунт на шарде (ожидаемо; при аномалии — смотреть `skew.max`).
- `skew.legacyWaiting > 0` **долго** при работающем воркере — старые job в легаси-очереди; см. §2.

Инструменты: Uptime Kuma (keyword по JSON), Prometheus + json_exporter, cron + `curl` + `jq`.

Пример извлечения:

```bash
curl -sS -H "X-Internal-Metrics-Key: $INTERNAL_METRICS_KEY" \
  https://<backend>/health/campaign-queues \
  | jq '.summary.totals, .skew, .campaignVip, .failedSummary.windows'
```

---

## 2. Смена `CAMPAIGN_SEND_SHARD_COUNT` (P1)

### Риск

При смене **N** меняется `hash(userId) % N` — новые job попадают в **другие** имена очередей Redis. **Старые** ключи с непустым хвостом останутся без воркера, если новый конфиг **не** слушает старое имя.

### Безопасная процедура

1. Снять снимок метрик (§1); убедиться, что **`waiting`/`delayed` приемлемы**.
2. Остановить постановку новых волн (пауза кампаний / окно обслуживания).
3. Дождаться **нулевых** или пренебрежимо малых `waiting` и `active` по **всем** именам из текущего ответа метрик (`queues`).
4. Выставить новый **`CAMPAIGN_SEND_SHARD_COUNT`** (одинаково на **всех** инстансах backend).
5. Перезапустить backend (PM2). Убедиться, что в логе воркера список имён очередей ожидаемый.
6. Проверить **`skew.legacyWaiting`**: при N>1 легаси **`campaign-send`** должна осушаться; не нулевая длительно — ручной разбор Redis/Bull.

### Не делать

- Менять N «на лету» без мониторинга при большом хвосте.
- Разные N на разных репликах API.

---

## 3. VIP-приоритет (P2)

### Источники (объединяются)

1. **`CAMPAIGN_VIP_USER_IDS`** — список UUID через запятую/пробел.
2. Колонка **`users.campaign_send_vip = true`** (миграция `supabase/migrations/20260406120000_users_campaign_send_vip.sql`).

### Поведение

- Список VIP в памяти обновляется каждые **`CAMPAIGN_VIP_REFRESH_INTERVAL_MS`** (по умолчанию 60s, минимум 5s).
- **`CAMPAIGN_VIP_DB_SYNC=false`** — только env (БД не опрашивается).
- При ошибке БД смотрите **`campaignVip.lastDbError`** в метриках; приоритет остаётся хотя бы от env.

### Приоритет BullMQ

- **`CAMPAIGN_VIP_JOB_PRIORITY`** (по умолчанию **0**) и **`CAMPAIGN_NORMAL_JOB_PRIORITY`** (по умолчанию **100000**): меньше = раньше. VIP автоматически ограничивается `< normal`.

### Подводные камни

- Приоритет действует **внутри одной очереди** шарда; разные пользователи на разных шардах не конкурируют по `priority`.
- Непрерывный поток VIP на шарде может отодвигать обычные job (**starvation**) — продуктовая политика; смотреть `prioritized` и `waiting`.

### SQL-пример

```sql
UPDATE public.users SET campaign_send_vip = true WHERE id = '<uuid>';
```

---

## 4. Связанные переменные окружения

См. `backend/.env.example`: `INTERNAL_METRICS_KEY`, `CAMPAIGN_SEND_*`, `CAMPAIGN_VIP_*`, `TG_AUTO_UNSELECT_*`.

---

## 5. Safe cleanup проблемных TG-целей (операционный скрипт)

Для пользователя Натальи добавлен безопасный скрипт:

`backend/scripts/natalia-tg-cleanup.cjs`

- По умолчанию **dry-run** (только печать кандидатов).
- Порог: `NATALIA_TG_FAIL_THRESHOLD` (по умолчанию 3).
- Применение изменений: `APPLY=true node scripts/natalia-tg-cleanup.cjs`.
- Скрипт отключает `telegram_groups.is_selected=false` только для целей с перманентными ошибками (`CHAT_WRITE_FORBIDDEN`, `USER_BANNED_IN_CHANNEL`, `CHAT_ADMIN_REQUIRED`, `PEER_ID_INVALID`, `CHANNEL_INVALID`, `CHANNEL_PRIVATE`).

---

*Дополнения: [CAMPAIGN_ADVANCED_OPERATIONS.md](./CAMPAIGN_ADVANCED_OPERATIONS.md), [README_MESSAGING_CHANNELS_OVERVIEW.md](./README_MESSAGING_CHANNELS_OVERVIEW.md).*
