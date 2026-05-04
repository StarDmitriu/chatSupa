# Campaign Invariants Check

Ежедневная проверка инвариантов рассылок запускается скриптом:

- `cd backend && npm run check:campaign-invariants`

Скрипт печатает JSON-отчёт и возвращает код выхода:

- `0` — критических нарушений нет
- `2` — найдены нарушения инвариантов
- `3` — техническая ошибка проверки

## Что проверяется

- `repeat_overlap_invariant`:
  - `CAMPAIGN_REPEAT_ALLOW_OVERLAP=true` без явного аварийного override `CAMPAIGN_REPEAT_OVERLAP_FORCE_UNSAFE=true`
- `due_pending_runaway`:
  - у `running` кампаний `duePending` выше порога
- `wa_exhausted_spike_1h`:
  - всплеск `wa_connectivity_retry_exhausted` за последний час
- `tg_peer_errors_spike_1h`:
  - всплеск `CHANNEL_INVALID` + `PEER_ID_INVALID` за последний час
- `tg_due_pending_without_processing` (warning):
  - у running TG-кампании есть `due_pending`, но нет `processing`
- `daily_eject_candidates`:
  - ежедневный список TG-групп-кандидатов “на вылет” (sent=0, failed>0, streak по дням, причины фейлов)
  - причины агрегируются по: `CHANNEL_INVALID`, `CHAT_WRITE_FORBIDDEN`, `USER_BANNED_IN_CHANNEL`, `CHANNEL_PRIVATE`

## Пороговые env

- `CAMPAIGN_INVARIANT_DUE_PENDING_THRESHOLD` (default `250`)
- `CAMPAIGN_INVARIANT_WA_EXHAUSTED_1H_THRESHOLD` (default `120`)
- `CAMPAIGN_INVARIANT_TG_PEER_ERRORS_1H_THRESHOLD` (default `40`)
- `CAMPAIGN_INVARIANT_TG_EJECT_LOOKBACK_DAYS` (default `14`)
- `CAMPAIGN_INVARIANT_TG_EJECT_FAILED_24H_THRESHOLD` (default `5`)
- `CAMPAIGN_INVARIANT_TG_EJECT_STREAK_DAYS_THRESHOLD` (default `2`)
- `CAMPAIGN_INVARIANT_TG_EJECT_TOP_LIMIT` (default `50`)

## Формат отчёта

Скрипт возвращает:

- JSON с полями:
  - `daily_eject_candidates` — топ кандидатов с `failed24h`, `sent24h`, `streakDays`, `reasons24h`, `candidateAction`
  - `morningSummary` — готовый текстовый summary для канала/лога
- Exit code как и раньше:
  - `0` — критических нарушений нет
  - `2` — есть `violations`
  - `3` — техническая ошибка проверки

## Рекомендуемый cron

Пример (каждые 15 минут):

`*/15 * * * * cd /var/www/backend && npm run check:campaign-invariants >/var/log/campaign-invariants.log 2>&1`

Для алерта проверяйте `exit code != 0` и JSON поле `violations`.

Для “утреннего отчёта” (например в 09:00) можно запускать тот же скрипт и отправлять поле `morningSummary` в ваш канал уведомлений.
