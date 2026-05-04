# Аудит: оплаты, списания и запреты при неактивной подписке

## 1. Что проверено

- Логика подписки и доступа (`subscriptions.service`, `subscription.guard`)
- Защита API запуска/повтора рассылок (campaigns)
- Обработка платежей и вебхуков Prodamus
- Воркер отправки сообщений (BullMQ)
- Сервис повторных волн (repeat)
- Типы пользователей (обычный, заблокированный, админ)

---

## 2. Что работает хорошо

### 2.1 Проверка доступа (подписка)

- **`hasAccess(userId)`** в `subscriptions.service.ts`:
  - Учитывает `is_blocked` — заблокированные пользователи не имеют доступа.
  - Доступ даётся при активном триале (`trial_ends_at > now`) или оплаченном периоде (`current_period_end > now`).
  - Возвращаются понятные коды: `trial_expired`, `subscription_expired`, `no_subscription`, `blocked`, `user_not_found`.

- **`hasAccessForChannel(userId, channel)`**:
  - Сначала проверяется общий доступ, затем план.
  - Планы `wa_tg` и `base` — доступ к обоим каналам.
  - План `wa` или `tg` — доступ только к соответствующему каналу (`plan_not_allowed` для другого).

### 2.2 Защита API кампаний

- **SubscriptionGuard** стоит на:
  - `POST /campaigns/start-multi` — запуск рассылки;
  - `POST /campaigns/:campaignId/requeue` — повтор волны.
- Guard читает `body.channel` и вызывает `hasAccessForChannel(userId, channel)` при указании канала, иначе `hasAccess(userId)`.
- При отказе возвращается `ForbiddenException` с причиной (`no_access`, `trial_expired` и т.д.).

### 2.3 Оплаты (Prodamus)

- **Создание платежа** (`POST /payments/prodamus/create`): создаётся запись в `payments`, строится ссылка на оплату с `subscriptionId` по плану (`wa`, `tg`, `wa_tg`).
- **Вебхук** (`POST /payments/prodamus/webhook`):
  - Проверка подписи.
  - Обновление `payments` (status, paid_at).
  - При успешной оплате — upsert в `subscriptions`: `status: 'active'`, `current_period_end` из `subscription.date_next_payment` или +30 дней.
  - Реферальные награды (добавление дней рефереру).
- Списанья (автопродление) идут на стороне Prodamus; при успешном списании провайдер присылает вебхук — мы обновляем `current_period_end` по данным из вебхука.

### 2.4 Фронт

- На странице кампаний при ошибке старта показываются сообщения для `no_subscription`, `trial_expired`, `subscription_expired`, `plan_not_allowed` с переходом на оформление подписки/пробного периода.
- Кабинет и страница подписки запрашивают `/subscriptions/me` и отображают статус, план, дни до конца.

### 2.5 WhatsApp / отключение

- При `disconnect` группы в БД не удаляются, только сбрасывается сессия и кэши — это согласовано с идеей «несколько номеров по очереди».

---

## 3. Проблемы и риски

### 3.1 Воркер отправки не проверял подписку — **ИСПРАВЛЕНО**

**Файл:** `backend/src/queue/campaign.worker.ts`

**Сделано:** перед отправкой вызывается `SubscriptionsService.hasAccessForChannel(userId, channel)`. При отсутствии доступа job переводится в статус `skipped` с `error: reason` (например `subscription_expired`), отправка не выполняется. В `QueueModule` подключён `SubscriptionsModule`, в воркер внедрён `SubscriptionsService`.

### 3.2 Повторные волны без проверки подписки — **ИСПРАВЛЕНО**

**Файл:** `backend/src/campaigns/campaigns.service.ts` (метод `repeatWaveIfReady`)

**Сделано:** в начале `repeatWaveIfReady` после загрузки кампании вызывается `SubscriptionsService.hasAccessForChannel(user_id, channel)`. При отсутствии доступа возвращается `{ success: false, message: reason }`, новая волна не создаётся.

### 3.3 Requeue и проверка по каналу — **ИСПРАВЛЕНО**

**Файл:** `backend/src/campaigns/campaigns.service.ts` (метод `requeueCampaign`)

**Сделано:** при вызове `requeueCampaign` с `userId` загружается кампания с полем `channel`, затем вызывается `hasAccessForChannel(userId, channel)`. При отсутствии доступа (в т.ч. `plan_not_allowed` для другого канала) возвращается `{ success: false, message: reason }`. Пользователь с планом «только WA» не сможет успешно сделать requeue для TG-кампании.

### 3.4 Админы и подписка — **ИСПРАВЛЕНО**

**Файл:** `backend/src/subscriptions/subscriptions.service.ts`

**Сделано:** в `getUserAndSub` в выборку пользователя добавлено поле `is_admin`. В начале `hasAccess` при `user.is_admin === true` возвращается `{ allowed: true }` без проверки подписки. `hasAccessForChannel` использует `hasAccess`, поэтому админы обходят проверку и по каналу.

### 3.5 Дублирование логики «активности» подписки

Логика «доступ есть, если trial или paid период не истёк» живёт в `getMySubscription` (для UI) и в `hasAccess`. Даты одни и те же, но формулы разнесены. При изменении правил (например, grace period) легко обновить в одном месте и забыть в другом.

**Рекомендация:** вынести единую функцию вида `getAccessState(user, sub): { allowed, reason }` и использовать её и в `hasAccess`, и при формировании ответа `getMySubscription`.

---

## 4. Сводка по типам пользователей

| Тип              | is_blocked | Подписка      | Результат |
|------------------|------------|---------------|-----------|
| Обычный          | false      | активна       | Доступ есть |
| Обычный          | false      | истекла/нет   | Нет доступа (trial_expired / subscription_expired / no_subscription) |
| Заблокированный | true       | любая         | Нет доступа (blocked) |
| Админ            | —          | не проверяется | Как обычный пользователь (обхода нет) |

---

## 5. Список улучшений (приоритет)

1. ~~**Высокий:** Добавить проверку подписки в воркер отправки~~ — **сделано**
2. ~~**Высокий:** Добавить проверку подписки в `repeatWaveIfReady`~~ — **сделано**
3. ~~**Средний:** При requeue проверять доступ по каналу кампании~~ — **сделано**
4. ~~**Низкий:** Исключение для `is_admin` в `hasAccess`~~ — **сделано**
5. **Низкий:** Общая функция «состояние доступа» для `hasAccess` и `getMySubscription` (рефакторинг при желании).

Запрет на отправку при неактивной подписке соблюдается на уровне API (Guard), воркера отправки и повторных волн. Requeue проверяет канал; админы обходят проверку подписки.
