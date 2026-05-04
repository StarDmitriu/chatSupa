# API Contract For Go Backend

Дата фиксации контракта: 2026-05-01

Этот файл нужен для переписывания backend на Go без изменений во frontend. Ниже описан не "идеальный REST", а фактический контракт, который сейчас ожидает клиент.

Если новый backend отступит от этого контракта, фронтенд начнет ломаться не только по маршрутам, но и по:
- именам полей;
- типам полей;
- кодам ошибок в `message`;
- nullable/non-nullable значениям;
- поведению file/download endpoints;
- совместимости JWT/cookie/headers;
- особенностям WA/TG status flow.

## 1. Общие правила совместимости

### 1.1 Base URL

Frontend ходит на:

- `process.env.NEXT_PUBLIC_BACKEND_URL`
- если env не задан: `/api`

Значит новый Go-backend должен оставаться доступен через тот же базовый префикс, который пробрасывает nginx.

### 1.2 Формат ответа

Почти все JSON endpoints используют схему:

```json
{ "success": true, ... }
```

или

```json
{ "success": false, "message": "some_code_or_text", ... }
```

Ключевые требования:
- поле `success` обязательно;
- при ошибках фронт часто читает именно `message`;
- `message` иногда является machine-readable кодом, а не человекочитаемым текстом;
- нельзя без необходимости менять коды ошибок.

### 1.3 Авторизация

Сейчас используются оба механизма:

1. После `/auth/verify-code` backend выставляет cookie `token`.
2. Frontend затем почти везде сам читает cookie и отправляет:

```http
Authorization: Bearer <jwt>
```

Значит Go-backend должен:
- продолжать выдавать тот же JWT-like token;
- принимать `Authorization: Bearer ...`;
- не требовать httpOnly cookie как единственный способ auth;
- сохранять payload как минимум с `userId`.

### 1.4 Поведение при `401`

Во frontend helper `frontend/src/lib/api.ts` при `401`:
- удаляет cookie `token`;
- редиректит на `/auth/phone`.

Значит новый backend для просроченного/битого токена должен отдавать именно `401`, а не всегда `200 { success:false }`.

### 1.5 Content types

Нужно сохранить:
- JSON endpoints: `application/json`
- upload endpoints: `multipart/form-data`
- export/download endpoints: бинарный/CSV ответ, не JSON

### 1.6 Таймауты и длинные запросы

Во frontend есть места, где ожидаются долгие операции:
- сохранение шаблона;
- загрузка/синхронизация групп;
- пересчет/массовые операции.

Нельзя искусственно делать короткие таймауты на reverse proxy / upstream.

### 1.7 Совместимость `message`

Очень много UI-логики завязано на `message`, например:
- `whatsapp_not_connected`
- `telegram_not_connected`
- `payment_config_error`
- `template_owner_mismatch`
- `user_id_mismatch`
- `subscription_expired`
- `trial_expired`
- `plan_not_allowed`
- `pause_not_supported_by_schema`
- `supabase_targets_insert_error`

Новый backend должен либо:
- сохранять эти коды полностью;
- либо фронтенд придется переписывать.

## 2. Модули и endpoint groups

- Public / auth / profile
- WhatsApp
- Telegram
- Templates
- Campaigns
- Subscriptions
- Payments / Prodamus
- Leads
- Sheets
- Admin
- Internal health

---

## 3. Public / Auth

### `GET /`

Назначение:
- простой health endpoint;
- используется для healthcheck контейнера backend.

Auth:
- не нужен

Ответ:
- plain text / simple 200 OK

Требование:
- endpoint должен оставаться быстрым и без side effects.

### `POST /log-client-error`

Назначение:
- клиентский лог ошибок Next.js / runtime.

Auth:
- не нужен

Body:

```json
{
  "message": "string",
  "digest": "string",
  "path": "string",
  "url": "string",
  "userAgent": "string",
  "stack": "string"
}
```

Фактически body loose, строгой DTO-валидации нет.

Ответ:
- `204 No Content`

Требование:
- endpoint не должен падать от лишних полей.

### `POST /auth/send-code`

Назначение:
- инициировать вход по номеру телефона;
- сохранить OTP в `otp_codes`;
- отправить SMS или, если SMS provider не настроен, перейти в dev/log fallback.

Auth:
- не нужен

Body:

```json
{
  "phone": "+375..."
}
```

Успех:

```json
{
  "success": true
}
```

Основные ошибки:
- `phone is required`
- `too_many_requests`
- `supabase_error`
- `supabase_timeout`
- `sms_send_failed`

Особое поведение:
- если `SMSRU_API_ID` отсутствует, backend не должен ломать login flow;
- в таком режиме OTP логируется, но endpoint все равно возвращает успех.

### `POST /auth/verify-code`

Назначение:
- проверить OTP;
- создать пользователя при первом входе;
- обновить профиль;
- выпустить JWT;
- поставить cookie `token`.

Auth:
- не нужен

Body:

```json
{
  "phone": "+375...",
  "code": "123456",
  "full_name": "optional",
  "gender": "optional",
  "telegram": "optional",
  "birthday": "optional",
  "city": "optional",
  "ref": "optional referral code",
  "consent_personal": true,
  "consent_marketing": false
}
```

Обязательные поля:
- `phone`
- `code`

Критично:
- `consent_personal` и `consent_marketing` сейчас должны приниматься, даже если логика регистрации их не всегда использует;
- если убрать их из DTO нового backend, фронт снова получит `property ... should not exist`.

Успех:

```json
{
  "success": true,
  "token": "jwt",
  "user": {
    "id": "uuid",
    "phone": "...",
    "...": "..."
  }
}
```

Cookie:
- имя: `token`
- path `/`
- maxAge около 30 дней
- `secure` только в production
- `sameSite: lax`
- cookie сейчас `httpOnly: false`

Ошибки:
- `invalid_code`
- `code_expired`
- `too_many_attempts`
- `user_not_found`
- `supabase_error`

### `GET /auth/me`

Назначение:
- вернуть текущего пользователя по Bearer token.

Auth:
- Bearer JWT в `Authorization`

Успех:

```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "phone": "string",
    "full_name": "string|null",
    "gender": "string|null",
    "telegram": "string|null",
    "birthday": "string|null",
    "city": "string|null",
    "email": "string|null",
    "timezone": "string|null",
    "gsheet_url": "string|null",
    "is_admin": true,
    "is_blocked": false,
    "...": "..."
  }
}
```

Требования:
- не возвращать `tg_session`;
- payload токена должен однозначно резолвиться в `userId`.

Типовые ошибки:

```json
{ "success": false, "message": "No token provided" }
{ "success": false, "message": "Invalid token" }
{ "success": false, "message": "User not found" }
```

### `POST /auth/update-profile`

Назначение:
- обновить профиль текущего пользователя.

Auth:
- Bearer JWT

Body:

```json
{
  "full_name": "optional",
  "gender": "optional",
  "telegram": "optional",
  "birthday": "optional",
  "city": "optional",
  "timezone": "optional",
  "gsheet_url": "optional"
}
```

Успех:

```json
{
  "success": true,
  "user": { "...": "updated user" }
}
```

Ошибки:
- `No token provided`
- `Invalid token`

### `POST /auth/dev-get-otp-code`

Назначение:
- dev/E2E-only получение OTP из БД.

Auth:
- отдельный секрет в header `x-e2e-secret`

Body:

```json
{ "phone": "+375..." }
```

Поведение:
- в production должен быть запрещен;
- требует env `E2E_DEV_CODE_SECRET`.

Успех:

```json
{ "success": true, "code": "123456" }
```

Ошибки:
- `forbidden`
- `missing_secret`
- `invalid_secret`
- `code_not_found_or_expired`

---

## 4. WhatsApp API

Все endpoints этого раздела:
- под JWT guard;
- почти везде требуют, чтобы `:userId` совпадал с userId из токена;
- при несовпадении должен быть `user_id_mismatch`.

### `POST /whatsapp/start`

Назначение:
- запустить WA session / начать подключение.

Auth:
- JWT

Body:
- пустой

Успех:
- зависит от состояния сессии, но фронт ожидает JSON с `success`

### `GET /whatsapp/proxy-settings`

Назначение:
- прочитать настройки proxy для WA.

Auth:
- JWT

Ответ:
- JSON с `success` и текущими proxy settings

### `POST /whatsapp/proxy-settings`

Назначение:
- сохранить proxy settings для WA.

Auth:
- JWT

Body:
- объект с proxy-параметрами

Требование:
- не ломать shape текущего ответа; фронт использует простую success/fail модель.

### `GET /whatsapp/status/:userId`

Назначение:
- отдать детальный статус WA session.

Auth:
- JWT
- `param userId` должен принадлежать текущему пользователю

Успех:

```json
{
  "success": true,
  "status": {
    "status": "not_connected|connecting|pending_qr|connected|temporary_network_issue|error",
    "qr": "optional string",
    "lastError": "optional string",
    "retryAttempt": 1,
    "retryMax": 5,
    "nextRetryAt": 1234567890,
    "networkIssue": true,
    "wsReachability": "optional",
    "wsLastCheckAt": 1234567890,
    "wsRttMs": 123,
    "wsError": "optional",
    "stateSinceAt": 1234567890,
    "stateDurationSec": 12,
    "disconnectSinceAt": 1234567890,
    "disconnectDurationSec": 34,
    "proxyBypassUntil": 1234567890
  }
}
```

Критично:
- status enum нельзя менять;
- фронт по нему рисует подключение, QR flow и reconnect states.

### `GET /whatsapp/network-incident`

Назначение:
- глобальный индикатор сетевой проблемы с WA.

Auth:
- JWT

Успех:

```json
{
  "success": true,
  "globalIssue": false,
  "affected": 0,
  "total": 0,
  "message": null
}
```

### `GET /whatsapp/account-info/:userId`

Назначение:
- информация о подключенном WA-аккаунте.

Auth:
- JWT

Успех:

```json
{
  "success": true,
  "connected": true,
  "wa_id": "optional",
  "jid": "optional"
}
```

Если не подключен:

```json
{
  "success": true,
  "connected": false
}
```

### `POST /whatsapp/sync-groups`

Назначение:
- синхронизировать WA-группы из живой сессии в БД.

Auth:
- JWT

Успех:
- JSON c `success: true`

Критичные ошибки:
- `whatsapp_not_connected`

Требование:
- sync должен upsert-ить группы, а не пересоздавать пользовательские selection/time данные.

### `GET /whatsapp/groups/:userId`

Назначение:
- список WA-групп пользователя.

Auth:
- JWT

Query:
- `limit?: number`
- `offset?: number`
- `selectedOnly?: boolean|string`
- `waPhone?: string`

Успех:

```json
{
  "success": true,
  "groups": [
    {
      "wa_group_id": "string",
      "subject": "string|null",
      "participants_count": 123,
      "is_announcement": false,
      "is_restricted": false,
      "is_selected": true,
      "send_time": "string|null",
      "updated_at": "ISO string",
      "last_send_error": "string|null",
      "last_send_error_at": "ISO string|null",
      "wa_phone": "string|null"
    }
  ],
  "total": 123,
  "hasMore": false
}
```

Критично:
- `groups` должен быть массивом;
- `wa_group_id` строка;
- `send_time` может быть `null`;
- `last_send_error` используется фронтом для warning на карточке группы.

### `GET /whatsapp/groups/:userId/phones`

Назначение:
- список WA phone/account keys, на которые сейчас разложены группы.

Успех:

```json
{
  "success": true,
  "phones": ["+375...", "..."]
}
```

### `GET /whatsapp/groups/:userId/count`

Назначение:
- summary по количеству выбранных/всех WA-групп.

Успех:

```json
{
  "success": true,
  "selected": 10,
  "total": 50
}
```

### `GET /whatsapp/group-avatar/:userId?wa_group_id=...`

Назначение:
- вернуть URL аватарки WA-группы.

Успех:

```json
{
  "success": true,
  "url": "https://... | null"
}
```

### `GET /whatsapp/group-avatar-content/:userId?wa_group_id=...`

Назначение:
- прокси raw avatar bytes для WA-группы.

Критично:
- фронт использует endpoint как `img src`;
- на missing avatar сейчас допустим fallback;
- исторически endpoint мог редиректить на `/logo-heart.png`.

### `GET /whatsapp/account-avatar/:userId`

Назначение:
- вернуть URL аватарки аккаунта.

Ответ:

```json
{
  "success": true,
  "url": "https://... | null"
}
```

### `GET /whatsapp/account-avatar-content/:userId`

Назначение:
- raw avatar bytes аккаунта.

### `POST /whatsapp/groups/select`

Назначение:
- выбрать/снять одну группу.

Body:

```json
{
  "wa_group_id": "string",
  "is_selected": true
}
```

Успех:

```json
{
  "success": true,
  "group": {
    "wa_group_id": "string",
    "is_selected": true
  }
}
```

Ошибка:
- `wa_group_id is required`

### `POST /whatsapp/groups/select-batch`

Назначение:
- массовое изменение selection.

Body:

```json
{
  "wa_group_ids": ["id1", "id2"],
  "is_selected": true
}
```

Успех:

```json
{
  "success": true,
  "updated": 2,
  "total": 2
}
```

### `POST /whatsapp/groups/time`

Назначение:
- сохранить send interval/time на уровне WA-группы.

Body:

```json
{
  "wa_group_id": "string",
  "send_time": "string|null"
}
```

Успех:

```json
{
  "success": true,
  "group": {
    "wa_group_id": "string",
    "send_time": "string|null"
  }
}
```

### `POST /whatsapp/disconnect`

Назначение:
- отключить WA session.

Body:

```json
{
  "source": "optional"
}
```

Успех:

```json
{ "success": true }
```

### `POST /whatsapp/reset`

Назначение:
- hard reset WA state/credentials/session caches.

Успех:

```json
{ "success": true }
```

---

## 5. Telegram API

Все endpoints защищены JWT guard.

Критично:
- TG flow реализован в двух режимах: QR и обычный auth flow;
- фронт активно использует status enums;
- групповые endpoints должны поддерживать большие списки и keyset pagination.

### 5.1 QR auth flow

#### `POST /telegram/qr/start`

Назначение:
- запустить QR login flow Telegram.

Успех:
- JSON `success`

#### `GET /telegram/qr/status/:userId`

Назначение:
- получить статус QR auth flow.

Успех:

```json
{
  "success": true,
  "status": "not_connected|pending_qr|awaiting_password|connected|error",
  "qr": "string|null",
  "expiresAt": 1234567890,
  "lastError": "string|null"
}
```

Критично:
- фронт напрямую рисует UI по `status`;
- enum менять нельзя.

#### `POST /telegram/qr/confirm-password`

Body:

```json
{ "password": "string" }
```

Ошибка:
- `password is required`

#### `POST /telegram/qr/disconnect`

Назначение:
- disconnect QR session / finalized session.

#### `POST /telegram/qr/abort`

Назначение:
- прервать незавершенный QR flow.

### 5.2 Classic Telegram auth flow

#### `GET /telegram/status/:userId`

Назначение:
- статус Telegram account/session.

Успех:

```json
{
  "success": true,
  "status": "connected|not_connected|awaiting_code|awaiting_password|error",
  "lastError": "optional",
  "cooldownSeconds": 10
}
```

Допустимо:
- backend может попытаться восстановить session из сохраненного `tg_session`.

#### `GET /telegram/premium-status/:userId`

Успех:

```json
{
  "success": true,
  "isPremium": true,
  "maxFileSize": 4294967296
}
```

Критично:
- фронт использует `maxFileSize` для media UI.

#### `GET /telegram/account-info/:userId`

Успех:

```json
{
  "success": true,
  "id": "optional",
  "username": "optional",
  "first_name": "optional",
  "last_name": "optional",
  "phone": "optional",
  "is_premium": true
}
```

#### `GET /telegram/account-avatar/:userId`

Успех:

```json
{
  "success": true,
  "url": "https://... | null"
}
```

#### `POST /telegram/start`

Назначение:
- обычный старт login flow без QR.

Успех:
- `success`

Если уже подключен:

```json
{
  "success": true,
  "status": "connected",
  "message": "already_connected"
}
```

#### `POST /telegram/confirm-code`

Body:

```json
{ "code": "12345" }
```

Ошибка:
- `code is required`

#### `POST /telegram/confirm-password`

Body:

```json
{ "password": "string" }
```

Ошибка:
- `password is required`

#### `POST /telegram/disconnect`

Назначение:
- отключить Telegram session.

### 5.3 TG groups sync and listing

#### `POST /telegram/sync-groups`

Назначение:
- загрузить/обновить Telegram dialogs/groups в БД;
- оживить stale dialogs;
- обновить `last_send_error`/availability контекст.

Успех:
- `success: true`

Критично:
- sync не должен сбрасывать пользовательский selection и send_time;
- sync должен поддерживать очень большие списки групп.

#### `GET /telegram/groups/:userId/phones`

Назначение:
- список TG account keys, например `tgid:7937080435`.

Успех:

```json
{
  "success": true,
  "phones": ["tgid:7937080435"]
}
```

#### `GET /telegram/groups/:userId`

Назначение:
- список TG-групп.

Query:
- `limit?: number`
- `offset?: number`
- `selectedOnly?: boolean|string`
- `tgPhone?: string`
- `cursorUpdatedAt?: string`
- `cursorTgChatId?: string`
- `template?: true|false`

Смысл параметров:
- `selectedOnly` фильтрует только выбранные группы;
- `tgPhone` фильтрует по TG account key;
- `cursorUpdatedAt + cursorTgChatId` используются для keyset pagination;
- `offset` остается как fallback;
- `template=true` включает template mode для страницы шаблонов.

Успех:

```json
{
  "success": true,
  "groups": [
    {
      "tg_chat_id": "-100123...",
      "title": "string|null",
      "participants_count": 123,
      "tg_type": "chat|channel|supergroup|...",
      "tg_access_hash": "string|null",
      "tg_phone": "string|null",
      "is_selected": true,
      "send_time": "string|null",
      "updated_at": "ISO string",
      "avatar_url": "string|null",
      "views_count": 1,
      "forwards_count": 2,
      "replies_count": 3,
      "last_send_error": "string|null",
      "last_send_error_at": "ISO string|null"
    }
  ],
  "total": 123,
  "totalRows": 123,
  "hasMore": true,
  "nextOffset": 50,
  "nextCursor": {
    "updated_at": "ISO string",
    "tg_chat_id": "-100..."
  }
}
```

Критично:
- должны поддерживаться оба режима: cursor и offset;
- `tg_chat_id` должен остаться string;
- `template=true` нужен странице редактирования/создания шаблона;
- `last_send_error` фронт показывает как warning "группа недоступна...".

#### `GET /telegram/groups/:userId/count`

Успех:

```json
{
  "success": true,
  "selected": 10,
  "total": 50
}
```

#### `POST /telegram/groups/select`

Body:

```json
{
  "tg_chat_id": "-100...",
  "is_selected": true
}
```

Успех:

```json
{
  "success": true,
  "group": {
    "tg_chat_id": "-100...",
    "is_selected": true
  }
}
```

Ошибка:
- `tg_chat_id is required`

#### `POST /telegram/groups/select-all`

Body:

```json
{
  "is_selected": true
}
```

Успех:

```json
{
  "success": true,
  "selected": 10,
  "total": 50
}
```

#### `POST /telegram/groups/time`

Body:

```json
{
  "tg_chat_id": "-100...",
  "send_time": "string|null"
}
```

Успех:

```json
{
  "success": true,
  "group": {
    "tg_chat_id": "-100...",
    "send_time": "string|null"
  }
}
```

#### `POST /telegram/send-test`

Назначение:
- ручная тестовая отправка в группу тем же путем, что и настоящая рассылка.

Body:

```json
{
  "tg_chat_id": "-100...",
  "text": "optional"
}
```

Успех:

```json
{ "success": true }
```

Ошибка:

```json
{ "success": false, "message": "..." }
```

Критично:
- ошибки Telegram send path должны маппиться в строку `message`;
- для UI и диагностики важно сохранять, например, `PEER_ID_INVALID`, `CHAT_WRITE_FORBIDDEN`, `CHANNEL_PRIVATE`.

---

## 6. Templates API

Все endpoints под JWT.

Ключевая идея:
- шаблон = контент + media + TG/WA timing/speed settings + targets assignment.

### `POST /templates/sync`

Назначение:
- импорт шаблонов из Google Sheet пользователя.

Успех:
- `{ success: true, ... }`

### `POST /templates/check-sheet`

Назначение:
- проверить доступность Google Sheet.

Успех:

```json
{
  "success": true,
  "message": "Таблица доступна и готова к загрузке.",
  "details": {
    "csvRows": 10,
    "dataRows": 9,
    "presentHeaders": [],
    "missingHeaders": []
  }
}
```

### `GET /templates/export`

Назначение:
- скачать backup шаблонов как CSV.

Ответ:
- `text/csv`
- с `Content-Disposition: attachment`

Критично:
- это не JSON endpoint;
- фронт скачивает файл.

### `POST /templates/import`

Назначение:
- восстановить шаблоны из CSV.

Поддерживаемые режимы:
- multipart file field `file`
- либо body field `csv`

Успех:

```json
{
  "success": true,
  "count": 10,
  "totalRows": 10,
  "importedRows": 9,
  "skippedRows": 1
}
```

Ошибка:
- `Нужен файл CSV или поле csv в теле запроса`

### `GET /templates/list/:userId`

Назначение:
- список шаблонов пользователя плюс агрегаты.

Успех:

```json
{
  "success": true,
  "templates": [
    {
      "id": "uuid",
      "sheet_row": 1,
      "enabled": true,
      "order": 1,
      "title": "string|null",
      "text": "string|null",
      "media_url": "string|null",
      "send_media_as_file": false,
      "wa_speed_factor": 100,
      "tg_speed_factor": 100,
      "wa_between_groups_sec_min": 2,
      "wa_between_groups_sec_max": 3,
      "tg_between_groups_sec_min": 2,
      "tg_between_groups_sec_max": 3,
      "wa_default_send_time": "string|null",
      "tg_default_send_time": "string|null",
      "updated_at": "ISO string",
      "created_at": "ISO string",
      "stats": {
        "total": 0,
        "sent": 0,
        "failed": 0,
        "firstSentAt": null,
        "lastSentAt": null
      },
      "targets_count": {
        "wa": 0,
        "tg": 0
      },
      "problematic_groups": {
        "total": 0,
        "by_reason": {},
        "top_groups": []
      }
    }
  ],
  "totals": {
    "templatesTotal": 1,
    "templatesWithGroupsSelected": 1,
    "totalTargetsAssigned": 2,
    "uniqueGroupsAll": 2,
    "uniqueGroupsWa": 1,
    "uniqueGroupsTg": 1,
    "uniqueUndeliverableSelectedGroups": 0,
    "uniqueUndeliverableSelectedGroupsWa": 0,
    "problematicWaSummary": {
      "total": 0,
      "topReasons": [],
      "topGroups": []
    }
  }
}
```

Критично:
- фронт очень активно использует `totals`;
- отсутствие этих полей приведет к поломке шаблонных страниц и аналитики выбора групп.

### `POST /templates/create`

Назначение:
- создать шаблон вручную.

Body:

```json
{
  "title": "string|null",
  "text": "string|null",
  "media_url": "string|null",
  "send_media_as_file": false,
  "enabled": true,
  "order": 1,
  "wa_speed_factor": 100,
  "tg_speed_factor": 100,
  "wa_between_groups_sec_min": 2,
  "wa_between_groups_sec_max": 3,
  "tg_between_groups_sec_min": 2,
  "tg_between_groups_sec_max": 3,
  "wa_default_send_time": "string|null",
  "tg_default_send_time": "string|null"
}
```

Успех:

```json
{
  "success": true,
  "template": { "...": "created template" }
}
```

Важный compatibility case:
- если в схеме БД нет части optional полей, старый backend мог сохранять шаблон по fallback и вернуть success с warning;
- новый backend должен либо полностью поддерживать эти поля, либо возвращать совместимый degraded ответ, пока миграции не применены.

### `POST /templates/upload-media`

Назначение:
- загрузить media для шаблона.

Multipart:
- field `file`

Успех:

```json
{
  "success": true,
  "path": "storage path",
  "publicUrl": "https://...",
  "mime": "image/png",
  "size": 12345
}
```

Ошибка:
- `file is required`

### `POST /templates/update`

Назначение:
- обновить шаблон.

Body:

```json
{
  "templateId": "uuid",
  "title": "optional",
  "text": "optional",
  "media_url": "optional",
  "send_media_as_file": false,
  "enabled": true,
  "order": 1,
  "wa_speed_factor": 100,
  "tg_speed_factor": 100,
  "wa_between_groups_sec_min": 2,
  "wa_between_groups_sec_max": 3,
  "tg_between_groups_sec_min": 2,
  "tg_between_groups_sec_max": 3,
  "wa_default_send_time": "optional",
  "tg_default_send_time": "optional"
}
```

Успех:

```json
{
  "success": true
}
```

### `GET /templates/get/:templateId`

Назначение:
- получить один шаблон.

Успех:

```json
{
  "success": true,
  "template": {
    "...": "template row"
  }
}
```

Критично:
- backend проверяет owner;
- при чужом шаблоне должен быть `template_owner_mismatch`.

### `POST /templates/delete`

Body:

```json
{
  "templateId": "uuid"
}
```

Успех:

```json
{ "success": true }
```

### `GET /templates/targets/:userId/:templateId/:channel`

Назначение:
- получить назначенные группы для шаблона по каналу.

Path:
- `channel = wa | tg`

Успех:

```json
{
  "success": true,
  "groupJids": ["jid1", "jid2"],
  "overrides": {
    "jid1": "00:30"
  }
}
```

Критично:
- для TG targets сейчас есть account scoping;
- новый backend не должен смешивать группы разных TG account keys в одном списке шаблонных targets.

### `POST /templates/targets/set`

Назначение:
- сохранить полное назначение групп шаблону.

Body:

```json
{
  "templateId": "uuid",
  "groupJids": ["id1", "id2"],
  "channel": "wa|tg",
  "overrides": {
    "id1": "00:30"
  }
}
```

Успех:

```json
{
  "success": true,
  "count": 2
}
```

Критичные ошибки:
- `templateId is required`
- `groupJids must be array`
- `supabase_targets_insert_error`

### `GET /templates/targets/summary/:userId/:channel`

Назначение:
- агрегаты для правой панели планирования.

Успех:
- JSON с `success: true` и summary-объектом

Требование:
- shape должен остаться совместим с текущими шаблонными страницами;
- даже если поля будут расширяться, существующие имена ломать нельзя.

---

## 7. Campaigns API

Все endpoints под JWT.

Часть endpoints также защищены `SubscriptionGuard`.

### `GET /campaigns/active/:channel`

Назначение:
- активная рассылка по конкретному каналу.

Успех:

```json
{
  "success": true,
  "active": null
}
```

или

```json
{
  "success": true,
  "active": {
    "campaignId": "uuid"
  }
}
```

### `GET /campaigns/active`

Назначение:
- активные кампании сразу по WA и TG.

Успех:

```json
{
  "success": true,
  "wa": { "campaignId": "uuid" } | null,
  "tg": { "campaignId": "uuid" } | null
}
```

### `GET /campaigns/list`

Назначение:
- история кампаний пользователя.

Успех:

```json
{
  "success": true,
  "campaigns": [
    {
      "id": "uuid",
      "status": "running|finished|failed|...",
      "channel": "wa|tg",
      "created_at": "ISO string"
    }
  ]
}
```

Критично:
- frontend сортирует по `created_at`.

### `GET /campaigns/pause-state/:channel`

Назначение:
- состояние кнопки pause/play для канала.

Успех:

```json
{
  "success": true,
  "paused": false,
  "reason": null,
  "campaignId": "uuid|null"
}
```

### `POST /campaigns/set-pause`

Body:

```json
{
  "channel": "wa|tg",
  "paused": true
}
```

Успех:

```json
{
  "success": true,
  "paused": true,
  "updated": 10,
  "enqueued": 0
}
```

Важные ошибки:
- `subscription_expired`
- `trial_expired`
- `no_subscription`
- `plan_not_allowed`
- `pause_not_supported_by_schema`

### `POST /campaigns/start-multi`

Назначение:
- главный запуск кампании.

Защита:
- JWT
- `SubscriptionGuard`

Body:

```json
{
  "channel": "wa|tg",
  "timeFrom": "08:00",
  "timeTo": "17:00",
  "betweenGroupsSecMin": 2,
  "betweenGroupsSecMax": 3,
  "betweenTemplatesMinMin": 2,
  "betweenTemplatesMinMax": 3,
  "repeatEnabled": true,
  "repeatMinMin": 2,
  "repeatMinMax": 3,
  "repeatScheduleKind": "minutes|next_day|clock_time",
  "repeatClockTime": "09:00",
  "betweenGroupsScaleTemplate": true
}
```

Что реально шлет фронт сейчас:
- `channel`
- `timeFrom`
- `timeTo`
- `repeatEnabled`
- `repeatScheduleKind`
- `betweenGroupsScaleTemplate`

Успех:

```json
{
  "success": true,
  "campaignId": "uuid",
  "alreadyRunning": false,
  "message": "already_running"
}
```

Критичные ошибки:
- `whatsapp_not_connected`
- `telegram_not_connected`
- `no_groups`
- `no_templates`
- `tg_preflight_blocked`
- `subscription_expired`
- `trial_expired`
- `plan_not_allowed`

### `GET /campaigns/preflight/tg`

Назначение:
- предварительная оценка доли нерезолвимых TG targets.

Query:
- `threshold?: number`

Успех:

```json
{
  "success": true,
  "totalTargets": 10,
  "resolvableTargets": 9,
  "unresolvableTargets": 1,
  "badRate": 0.1,
  "threshold": 0.15,
  "ok": true
}
```

### `GET /campaigns/:campaignId/progress`

Назначение:
- детальный прогресс кампании.

Успех:

```json
{
  "success": true,
  "campaignId": "uuid",
  "total": 100,
  "sent": 50,
  "failed": 10,
  "pending": 30,
  "processing": 5,
  "skipped": 5,
  "paused": 0,
  "done": false,
  "jobs": [
    {
      "id": "uuid",
      "group_jid": "string",
      "template_id": "uuid",
      "status": "pending|processing|sent|failed|skipped|paused",
      "scheduled_at": "ISO string",
      "sent_at": "ISO string|null",
      "error": "string|null"
    }
  ]
}
```

Критично:
- `jobs` обязателен;
- `status` enum нельзя менять;
- frontend строит analytics/progress по этим полям.

### `GET /campaigns/:campaignId/recent-outcomes`

Query:
- `windowMin?: number`

Успех:

```json
{
  "success": true,
  "campaignId": "uuid",
  "channel": "wa|tg",
  "windowMinutes": 5,
  "rates": {
    "sentPerMinute": 0,
    "failedPerMinute": 0
  },
  "counts": {
    "sent": 0,
    "failed": 0,
    "failedTransient": 0,
    "failedExhausted": 0
  },
  "from": "ISO string",
  "at": "ISO string"
}
```

### `GET /campaigns/:campaignId/jobs`

Назначение:
- raw jobs кампании.

Успех:

```json
{
  "success": true,
  "jobs": [
    {
      "id": "uuid",
      "group_jid": "string",
      "template_id": "uuid",
      "status": "pending|processing|sent|failed|skipped|paused",
      "scheduled_at": "ISO string",
      "sent_at": "ISO string|null",
      "error": "string|null"
    }
  ]
}
```

### `POST /campaigns/group-delivery-summary`

Назначение:
- summary по доставке в конкретные группы.

Body:

```json
{
  "channel": "wa|tg",
  "groupJids": ["id1", "id2"],
  "lookbackDays": 30,
  "includeTemplatesIncluded": true
}
```

Успех:

```json
{
  "success": true,
  "channel": "wa",
  "summaries": {
    "id1": {
      "templatesIncluded": 3,
      "sent": 10,
      "failed": 1,
      "total": 11,
      "successRate": 0.91,
      "lastSentAt": "ISO string|null",
      "lastFailedAt": "ISO string|null",
      "topReasons": []
    }
  }
}
```

### `POST /campaigns/:campaignId/requeue`

Назначение:
- перекинуть jobs кампании обратно в работу.

Защита:
- `SubscriptionGuard`

Body:

```json
{
  "includeSent": false,
  "forceNow": false,
  "statuses": ["failed", "skipped"]
}
```

Допустимые `statuses`:
- `pending`
- `processing`
- `failed`
- `skipped`
- `sent`
- `paused`

Успех:
- `{ "success": true, ... }`

### `POST /campaigns/:campaignId/resync-schedule-from-templates`

Назначение:
- пересчитать pending jobs по текущим template pause settings.

Защита:
- `SubscriptionGuard`

Успех:
- `{ "success": true, ... }`

Типовые ошибки:
- `campaign_not_running`
- `no_pending_jobs`
- `supabase_templates_select_error`

### `POST /campaigns/:campaignId/stop`

Назначение:
- остановить кампанию.

Успех:

```json
{
  "success": true,
  "message": "campaign_stopped",
  "jobsUpdated": 10
}
```

---

## 8. Subscriptions API

### `GET /subscriptions/me`

Назначение:
- получить effective subscription/access state пользователя.

Успех:

```json
{
  "success": true,
  "isBlocked": false,
  "subscription": {
    "status": "none|trial|active",
    "plan_code": "wa|tg|wa_tg|base",
    "provider": "prodamus|null",
    "trial_started_at": "ISO|null",
    "trial_ends_at": "ISO|null",
    "current_period_start": "ISO|null",
    "current_period_end": "ISO|null",
    "cancel_at_period_end": false
  },
  "status": "none|trial|active",
  "trialDaysLeft": 0,
  "paidDaysLeft": 0,
  "accessDaysLeft": 0,
  "trialEndsAt": null,
  "paidEndsAt": null,
  "accessEndsAt": null,
  "now": "ISO string"
}
```

Критично:
- frontend использует и `subscription`, и summary fields.

### `POST /subscriptions/start-trial`

Назначение:
- запустить триал.

Успех:

```json
{
  "success": true,
  "subscription": { "...": "..." }
}
```

Ошибки:
- `user_not_found`
- `user_blocked`
- `already_active`
- `trial_already_running`
- `supabase_upsert_error`

### `POST /subscriptions/cancel`

Назначение:
- включить/выключить cancel at period end.

Body:

```json
{
  "cancel": true
}
```

Успех:

```json
{
  "success": true,
  "subscription": { "...": "..." }
}
```

Ошибки:
- `user_not_found`
- `subscription_not_found`
- `customer_contact_missing`
- `prodamus_set_activity_failed`

---

## 9. Payments / Prodamus

### `POST /payments/prodamus/create`

Назначение:
- создать ссылку на оплату.

Auth:
- JWT

Body:

```json
{
  "plan_code": "wa|tg|wa_tg"
}
```

Успех:

```json
{
  "success": true,
  "payment_url": "https://..."
}
```

Ошибки:
- `payment_config_error`
- `supabase_users_error`
- `user_not_found`
- `invalid_plan_code`
- `supabase_payments_insert_error`
- `payment_provider_error`

Критично:
- `payment_url` должен остаться именно этим именем;
- UI открытия оплаты зависит от него.

### `POST /payments/prodamus/webhook`

Назначение:
- callback от Prodamus.

Auth:
- по подписи, не по JWT

Headers:
- `sign` или `Sign`

Body:
- form-like payload;
- backend должен уметь раскрывать bracket notation.

Критичные side effects:
- найти payment;
- изменить статус payment;
- активировать/продлить subscription;
- авторезюмить paused campaigns;
- применить referral reward.

Успех:
- vendor-compatible JSON success

Ошибка:
- `invalid_signature`

Требование:
- новый backend должен быть полностью совместим с текущим форматом webhook payload, иначе платежи перестанут подтверждаться.

---

## 10. Leads API

### `POST /leads`

Назначение:
- создать lead request с лендинга/формы.

Auth:
- не нужен

Body:

```json
{
  "full_name": "string",
  "phone": "string",
  "birth_date": "optional date",
  "city": "string",
  "telegram": "optional string",
  "consent_personal": true,
  "consent_marketing": false
}
```

Критично:
- `consent_personal` обязателен и должен быть true;
- `consent_marketing` должен приниматься как boolean.

Успех:

```json
{ "success": true }
```

Ошибки:
- `invalid_phone`
- `consent_personal_required`
- `supabase_insert_error`

---

## 11. Sheets API

### `POST /sheets/create`

Назначение:
- создать/подготовить Google Sheet для пользователя.

Auth:
- JWT

Body:
- пустой

Успех:
- JSON `success`

Требование:
- shape ответа должен остаться совместим с текущим UI кабинета.

---

## 12. Admin API

Все endpoints:
- JWT
- admin guard
- admin password guard

### `GET /admin/users`

Назначение:
- админский список пользователей.

Успех:

```json
{
  "success": true,
  "users": [
    {
      "id": "uuid",
      "phone": "string",
      "is_blocked": false,
      "is_admin": false,
      "subscription": { "...": "joined subscription row" }
    }
  ]
}
```

### `POST /admin/users/:id/block`

Body:

```json
{
  "blocked": true
}
```

Успех:

```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "is_blocked": true
  }
}
```

### `POST /admin/users/:id/grant-trial`

Body:

```json
{
  "days": 7
}
```

Успех:
- `{ "success": true, "subscription": { ... } }`

### `POST /admin/users/:id/grant-access`

Body:

```json
{
  "days": 30
}
```

Успех:
- `{ "success": true, "subscription": { ... } }`

### `POST /admin/users/:id/reduce-trial`

Body:

```json
{
  "days": 1
}
```

Успех:
- `{ "success": true, "subscription": { ... } }`

### `POST /admin/users/:id/reduce-access`

Body:

```json
{
  "days": 1
}
```

Успех:
- `{ "success": true, "subscription": { ... } }`

### `GET /admin/campaigns/diagnostics`

Query:
- `limit?: number`
- `userId?: string`

Назначение:
- диагностика по кампаниям и очередям.

Успех:
- `{ "success": true, "items": [...] }` либо совместимый diagnostics payload

Требование:
- не менять shape без синхронизации с admin UI.

---

## 13. Internal Metrics

### `GET /health/campaign-queues`

Назначение:
- internal метрики очередей campaign send.

Auth:
- header `x-internal-metrics-key`

Поведение:
- если env ключа нет: `404`
- если ключ неверный: `403`

Успех:
- JSON с queue metrics object

Требование:
- это мониторинговый endpoint, не user-facing API.

---

## 14. Критические frontend-зависимости

Это не просто "желательно". Это то, что новый backend должен сохранить, если цель действительно не переписывать фронтенд.

### 14.1 JWT payload

В токене должен быть `userId`.

### 14.2 `Authorization: Bearer`

Frontend отправляет Bearer почти везде. Нельзя переключить auth только на server-side cookie session.

### 14.3 `success` + `message`

Большая часть UI полагается не на HTTP status, а на:

```json
{ "success": false, "message": "..." }
```

### 14.4 WA/TG status enums

Нельзя менять:

WA:
- `not_connected`
- `connecting`
- `pending_qr`
- `connected`
- `temporary_network_issue`
- `error`

TG QR:
- `not_connected`
- `pending_qr`
- `awaiting_password`
- `connected`
- `error`

TG regular:
- `connected`
- `not_connected`
- `awaiting_code`
- `awaiting_password`
- `error`

### 14.5 Group IDs как строки

Нельзя переводить:
- `wa_group_id`
- `tg_chat_id`

в числа. Только строки.

### 14.6 `send_time`

`send_time` должен оставаться nullable string.

UI трактует:
- `null` / `""` как "без интервала" / auto;
- `HH:mm` как interval-like значение в ряде TG экранов;
- другие значения как named interval rules.

### 14.7 Template target overrides

`/templates/targets/set` и `/templates/targets/...` должны сохранить поддержку:
- `groupJids`
- `overrides`

Иначе сломается тонкая настройка TG-групп на уровне конкретного шаблона.

### 14.8 `last_send_error`

Для WA/TG group rows:
- `last_send_error`
- `last_send_error_at`

используются для warning badges во frontend.

Новый backend должен:
- записывать ошибку при провале отправки;
- очищать ее после успешной доставки.

### 14.9 Pagination compatibility

Для TG groups нужно сохранить:
- `offset/limit`
- keyset cursor через `cursorUpdatedAt + cursorTgChatId`
- `nextCursor`
- `nextOffset`
- `hasMore`

### 14.10 File/media endpoints

Нужно сохранить:
- `/templates/upload-media`
- `/templates/export`
- avatar content endpoints WA

Особенно важно:
- upload остается multipart;
- export остается file response;
- avatar endpoints остаются пригодными для `<img src=...>`.

### 14.11 Payment bootstrap

`/payments/prodamus/create` должен вернуть:

```json
{ "success": true, "payment_url": "..." }
```

Именно `payment_url`, не `url`, не `link`.

### 14.12 Subscription reason codes

Campaign UI ожидает machine-readable причины отказа:
- `subscription_expired`
- `trial_expired`
- `no_subscription`
- `plan_not_allowed`

### 14.13 `user_id_mismatch`

Во всех `:userId` endpoints надо сохранить жесткую проверку owner mismatch там, где она сейчас есть.

### 14.14 `template_owner_mismatch`

Для `/templates/get/:templateId` нужен тот же смысл и тот же код.

---

## 15. Минимальный план миграции на Go без поломки фронта

1. Сначала реализовать все перечисленные routes с теми же path/method.
2. Сохранить все response field names 1:1.
3. Сохранить ключевые `message` codes 1:1.
4. Сохранить JWT auth semantics.
5. Отдельно прогнать:
   - login flow;
   - profile update;
   - WA connect / TG connect;
   - groups sync/list/select/time;
   - template create/update/targets;
   - campaign start/progress/stop;
   - subscription trial;
   - prodamus create + webhook sandbox;
   - admin users.
6. Только после этого переключать frontend на новый backend.

---

## 16. Исходники, из которых снят контракт

Backend controllers:
- `backend/src/app.controller.ts`
- `backend/src/auth/auth.controller.ts`
- `backend/src/whatsapp/whatsapp.controller.ts`
- `backend/src/telegram/telegram.controller.ts`
- `backend/src/templates/templates.controller.ts`
- `backend/src/campaigns/campaigns.controller.ts`
- `backend/src/subscriptions/subscriptions.controller.ts`
- `backend/src/payments/prodamus.controller.ts`
- `backend/src/admin/admin.controller.ts`
- `backend/src/leads/leads.controller.ts`
- `backend/src/sheets/sheets.controller.ts`
- `backend/src/queue/campaign-queue-metrics.controller.ts`

Frontend consumers:
- `frontend/src/lib/api.ts`
- `frontend/src/components/WhatsappConnectBlock.tsx`
- `frontend/src/components/TelegramQrConnect.tsx`
- `frontend/src/app/cabinet/page.tsx`
- `frontend/src/app/dashboard/groups/page.tsx`
- `frontend/src/app/dashboard/groups/telegram/page.tsx`
- `frontend/src/app/dashboard/templates/page.tsx`
- `frontend/src/app/dashboard/templates/new/page.tsx`
- `frontend/src/app/dashboard/templates/[templateId]/page.tsx`
- `frontend/src/app/dashboard/campaigns/page.tsx`
- `frontend/src/app/dashboard/campaign/page.tsx`
- `frontend/src/app/dashboard/campaigns/timing/page.tsx`
- `frontend/src/app/dashboard/analytics/page.tsx`

Если понадобится, следующий логичный шаг:
- сделать вторую версию этого файла в формате OpenAPI/Swagger YAML;
- отдельно выписать JSON schemas по каждому endpoint;
- отдельно составить список "message codes" как enum-контракт.

---

## 17. Runtime-level поведение, которое тоже является контрактом

Это не "детали реализации". Это то, что текущий frontend и текущий deploy уже считают нормой.

### 17.1 Health behavior

В `main.ts` backend дополнительно регистрирует:

- `GET /` -> `200 ok`

Даже если внутри framework-контроллер тоже объявляет `/`, итоговое ожидание prod-окружения одно:
- root endpoint должен отвечать быстро;
- без auth;
- plain text;
- статус `200`.

### 17.2 CORS

Сейчас backend включает CORS со списком origin:

- `https://chatrassylka.ru`
- `https://www.chatrassylka.ru`
- `http://localhost:3001`
- `http://127.0.0.1:3001`
- либо env `CORS_ORIGINS`, comma-separated

Allowed methods:
- `GET`
- `POST`
- `PUT`
- `PATCH`
- `DELETE`
- `OPTIONS`

Allowed headers:
- `Content-Type`
- `Authorization`

Новый backend должен:
- поддержать те же origin/headers;
- не сломать dev mode на `localhost:3001`.

### 17.3 Global validation

Сейчас в Nest включен global `ValidationPipe`:

- `whitelist: true`
- `forbidNonWhitelisted: true`
- `transform: true`

Это означает:
- лишние поля в DTO-backed endpoint'ах вызывают `400`;
- boolean/number могут приходить как строки и быть преобразованы;
- если какое-то поле фронт уже шлет, его нужно явно оставить в DTO нового backend.

Критичный уже пойманный кейс:
- `consent_personal`
- `consent_marketing`

Если их убрать из `/auth/verify-code`, frontend снова упадет на validation error.

### 17.4 Response style

Текущий backend смешивает два подхода:

1. machine-readable JSON:

```json
{ "success": false, "message": "invalid_plan_code" }
```

2. raw HTTP status для некоторых системных случаев:
- `204 No Content` у `/log-client-error`
- `401` в auth helper scenarios
- `403` на guard-level ошибках
- `404` для отключенного internal metrics endpoint
- `302` redirect у `group-avatar-content`

Новый backend должен сохранить оба слоя поведения.

### 17.5 Cookie semantics

На `/auth/verify-code` cookie выставляется не только ради backend-session. Она нужна еще и фронтенду, который читает ее через JS.

Значит:
- `token` должен оставаться читаемым с клиента;
- просто перевести все на httpOnly cookie нельзя без переписывания frontend auth flow.

### 17.6 Rate limiting

Публичные endpoints, на которых уже есть guard-level limit:
- `/log-client-error`
- `/leads`

Go-версия должна тоже ограничивать их, иначе изменится runtime-поведение и эксплуатационная устойчивость.

---

## 18. Подробная таблица endpoint inventory

Это полный перечень того, что должен реализовать Go-backend для бесшовной замены.

| Method | Path | Auth | Body type | Response type | Front-critical |
|---|---|---|---|---|---|
| GET | `/` | no | none | text | healthcheck |
| POST | `/log-client-error` | no | JSON | 204 | yes |
| POST | `/auth/send-code` | no | JSON | JSON | yes |
| POST | `/auth/verify-code` | no | JSON | JSON + cookie | yes |
| GET | `/auth/me` | Bearer | none | JSON | yes |
| POST | `/auth/update-profile` | Bearer | JSON | JSON | yes |
| POST | `/auth/dev-get-otp-code` | header secret | JSON | JSON | e2e/dev |
| POST | `/whatsapp/start` | JWT | none | JSON | yes |
| GET | `/whatsapp/proxy-settings` | JWT | none | JSON | yes |
| POST | `/whatsapp/proxy-settings` | JWT | JSON | JSON | yes |
| GET | `/whatsapp/status/:userId` | JWT | none | JSON | yes |
| GET | `/whatsapp/network-incident` | JWT | none | JSON | yes |
| GET | `/whatsapp/account-info/:userId` | JWT | none | JSON | yes |
| POST | `/whatsapp/sync-groups` | JWT | none | JSON | yes |
| GET | `/whatsapp/groups/:userId` | JWT | query | JSON | yes |
| GET | `/whatsapp/groups/:userId/phones` | JWT | none | JSON | yes |
| GET | `/whatsapp/groups/:userId/count` | JWT | none | JSON | yes |
| GET | `/whatsapp/group-avatar/:userId` | JWT | query | JSON | yes |
| GET | `/whatsapp/group-avatar-content/:userId` | JWT | query | image/302 | yes |
| GET | `/whatsapp/account-avatar/:userId` | JWT | none | JSON | yes |
| GET | `/whatsapp/account-avatar-content/:userId` | JWT | none | image/404 | yes |
| POST | `/whatsapp/groups/select` | JWT | JSON | JSON | yes |
| POST | `/whatsapp/groups/select-batch` | JWT | JSON | JSON | yes |
| POST | `/whatsapp/groups/time` | JWT | JSON | JSON | yes |
| POST | `/whatsapp/disconnect` | JWT | JSON | JSON | yes |
| POST | `/whatsapp/reset` | JWT | none | JSON | yes |
| POST | `/telegram/qr/start` | JWT | none | JSON | yes |
| GET | `/telegram/qr/status/:userId` | JWT | none | JSON | yes |
| POST | `/telegram/qr/confirm-password` | JWT | JSON | JSON | yes |
| POST | `/telegram/qr/disconnect` | JWT | none | JSON | yes |
| POST | `/telegram/qr/abort` | JWT | none | JSON | yes |
| GET | `/telegram/status/:userId` | JWT | none | JSON | yes |
| GET | `/telegram/premium-status/:userId` | JWT | none | JSON | yes |
| GET | `/telegram/account-info/:userId` | JWT | none | JSON | yes |
| GET | `/telegram/account-avatar/:userId` | JWT | none | JSON | yes |
| POST | `/telegram/start` | JWT | none | JSON | yes |
| POST | `/telegram/confirm-code` | JWT | JSON | JSON | yes |
| POST | `/telegram/confirm-password` | JWT | JSON | JSON | yes |
| POST | `/telegram/disconnect` | JWT | none | JSON | yes |
| POST | `/telegram/sync-groups` | JWT | none | JSON | yes |
| GET | `/telegram/groups/:userId/phones` | JWT | none | JSON | yes |
| GET | `/telegram/groups/:userId` | JWT | query | JSON | yes |
| GET | `/telegram/groups/:userId/count` | JWT | none | JSON | yes |
| POST | `/telegram/groups/select` | JWT | JSON | JSON | yes |
| POST | `/telegram/groups/select-all` | JWT | JSON | JSON | yes |
| POST | `/telegram/groups/time` | JWT | JSON | JSON | yes |
| POST | `/telegram/send-test` | JWT | JSON | JSON | yes |
| POST | `/templates/sync` | JWT | none | JSON | yes |
| POST | `/templates/check-sheet` | JWT | none | JSON | yes |
| GET | `/templates/export` | JWT | none | CSV | yes |
| POST | `/templates/import` | JWT | multipart/JSON | JSON | yes |
| GET | `/templates/list/:userId` | JWT | none | JSON | yes |
| POST | `/templates/create` | JWT | JSON | JSON | yes |
| POST | `/templates/upload-media` | JWT | multipart | JSON | yes |
| POST | `/templates/update` | JWT | JSON | JSON | yes |
| GET | `/templates/get/:templateId` | JWT | none | JSON | yes |
| POST | `/templates/delete` | JWT | JSON | JSON | yes |
| GET | `/templates/targets/:userId/:templateId/:channel` | JWT | none | JSON | yes |
| POST | `/templates/targets/set` | JWT | JSON | JSON | yes |
| GET | `/templates/targets/summary/:userId/:channel` | JWT | none | JSON | yes |
| GET | `/campaigns/active/:channel` | JWT | none | JSON | yes |
| GET | `/campaigns/active` | JWT | none | JSON | yes |
| GET | `/campaigns/list` | JWT | none | JSON | yes |
| GET | `/campaigns/pause-state/:channel` | JWT | none | JSON | yes |
| POST | `/campaigns/set-pause` | JWT | JSON | JSON | yes |
| POST | `/campaigns/start-multi` | JWT + subscription | JSON | JSON | yes |
| GET | `/campaigns/preflight/tg` | JWT | none | JSON | yes |
| GET | `/campaigns/:campaignId/progress` | JWT | none | JSON | yes |
| GET | `/campaigns/:campaignId/recent-outcomes` | JWT | none | JSON | yes |
| GET | `/campaigns/:campaignId/jobs` | JWT | none | JSON | yes |
| POST | `/campaigns/group-delivery-summary` | JWT | JSON | JSON | yes |
| POST | `/campaigns/:campaignId/requeue` | JWT + subscription | JSON | JSON | yes |
| POST | `/campaigns/:campaignId/resync-schedule-from-templates` | JWT + subscription | none | JSON | yes |
| POST | `/campaigns/:campaignId/stop` | JWT | none | JSON | yes |
| GET | `/subscriptions/me` | JWT | none | JSON | yes |
| POST | `/subscriptions/start-trial` | JWT | none | JSON | yes |
| POST | `/subscriptions/cancel` | JWT | JSON | JSON | yes |
| POST | `/payments/prodamus/create` | JWT | JSON | JSON | yes |
| POST | `/payments/prodamus/webhook` | signature | form/multipart | JSON | critical |
| POST | `/leads` | no | JSON | JSON | yes |
| POST | `/sheets/create` | JWT | none | JSON | yes |
| GET | `/admin/users` | JWT + admin | none | JSON | admin |
| POST | `/admin/users/:id/block` | JWT + admin | JSON | JSON | admin |
| POST | `/admin/users/:id/grant-trial` | JWT + admin | JSON | JSON | admin |
| POST | `/admin/users/:id/grant-access` | JWT + admin | JSON | JSON | admin |
| POST | `/admin/users/:id/reduce-trial` | JWT + admin | JSON | JSON | admin |
| POST | `/admin/users/:id/reduce-access` | JWT + admin | JSON | JSON | admin |
| GET | `/admin/campaigns/diagnostics` | JWT + admin | query | JSON | admin |
| GET | `/health/campaign-queues` | x-internal-metrics-key | none | JSON | ops |

---

## 19. DTO and validation details

Ниже то, что сейчас фактически валидируется. Это важно перенести в Go не дословно по библиотеке, а по смыслу.

### 19.1 `/auth/verify-code`

| Field | Type | Required | Constraints |
|---|---|---:|---|
| `phone` | string | yes | min length 10, max 32 |
| `code` | string | yes | min length 4, max 10 |
| `full_name` | string | no | max 200 |
| `gender` | string | no | max 20 |
| `telegram` | string | no | max 100 |
| `birthday` | string | no | max 50 |
| `city` | string | no | max 200 |
| `ref` | string | no | max 100 |
| `consent_personal` | boolean | no | must be accepted if sent |
| `consent_marketing` | boolean | no | must be accepted if sent |

Validation behavior:
- лишние поля -> `400`;
- неправильные типы boolean -> `400`;
- строки короче min -> `400`.

### 19.2 `/auth/update-profile`

| Field | Type | Required | Constraints |
|---|---|---:|---|
| `full_name` | string | no | max 200 |
| `gender` | string | no | max 20 |
| `telegram` | string | no | max 100 |
| `birthday` | string | no | max 50 |
| `city` | string | no | max 200 |
| `timezone` | string | no | max 80 |
| `gsheet_url` | string/null | no | max 2000 |

### 19.3 `/templates/create`

| Field | Type | Required | Constraints |
|---|---|---:|---|
| `title` | string | no | max 500 |
| `text` | string | no | no max in DTO |
| `media_url` | string | no | max 2000 |
| `send_media_as_file` | boolean | no | transformed from string/bool |
| `enabled` | boolean | no | transformed |
| `order` | number | no | transformed |
| `wa_speed_factor` | number | no | transformed |
| `tg_speed_factor` | number | no | transformed |
| `wa_between_groups_sec_min` | number | no | transformed |
| `wa_between_groups_sec_max` | number | no | transformed |
| `tg_between_groups_sec_min` | number | no | transformed |
| `tg_between_groups_sec_max` | number | no | transformed |
| `wa_default_send_time` | string | no | max 100 |
| `tg_default_send_time` | string | no | max 100 |

### 19.4 `/templates/update`

То же, что create, плюс:

| Field | Type | Required | Constraints |
|---|---|---:|---|
| `templateId` | string | yes | non-empty string expected |

### 19.5 `/campaigns/start-multi`

| Field | Type | Required | Constraints |
|---|---|---:|---|
| `channel` | enum | no | `wa` or `tg` |
| `timeFrom` | string | no | plain string, frontend sends `HH:mm` |
| `timeTo` | string | no | plain string, frontend sends `HH:mm` |
| `betweenGroupsSecMin` | number | no | transformed |
| `betweenGroupsSecMax` | number | no | transformed |
| `betweenTemplatesMinMin` | number | no | transformed |
| `betweenTemplatesMinMax` | number | no | transformed |
| `repeatEnabled` | boolean | no | transformed |
| `repeatMinMin` | number | no | transformed |
| `repeatMinMax` | number | no | transformed |
| `repeatScheduleKind` | enum | no | `minutes`, `next_day`, `clock_time` |
| `repeatClockTime` | string | no | plain string |
| `betweenGroupsScaleTemplate` | boolean | no | transformed |

### 19.6 `/leads`

| Field | Type | Required | Constraints |
|---|---|---:|---|
| `full_name` | string | yes | not empty |
| `phone` | string | yes | not empty |
| `birth_date` | string | no | optional |
| `city` | string | yes | not empty |
| `telegram` | string | no | optional |
| `consent_personal` | boolean | yes | must be true in controller |
| `consent_marketing` | boolean | yes | must be boolean |

---

## 20. Header, cookie and content-type requirements by endpoint

### 20.1 Bearer endpoints

Все user endpoints должны принимать:

```http
Authorization: Bearer <token>
```

Причем:
- схема `Bearer` case-insensitive;
- отсутствие токена для `/auth/me` и `/auth/update-profile` сейчас возвращает JSON ошибку;
- для guard-protected routes фреймворк может отдавать `401/403`.

### 20.2 Multipart endpoints

Endpoints:
- `POST /templates/upload-media`
- `POST /templates/import` при file mode

Field names:
- upload media: `file`
- import CSV: `file`

Если другой разработчик назовет поле иначе, frontend не загрузит файл.

### 20.3 Payment webhook headers

Endpoint:
- `POST /payments/prodamus/webhook`

Допустимые заголовки подписи:
- `sign`
- `Sign`

Нельзя принимать только одну форму заголовка.

### 20.4 Internal metrics header

Endpoint:
- `GET /health/campaign-queues`

Header:

```http
x-internal-metrics-key: <secret>
```

### 20.5 Cookie after verify-code

После `/auth/verify-code` должен выставляться:

```http
Set-Cookie: token=<jwt>; Path=/; SameSite=Lax; ...
```

---

## 21. Side effects by endpoint

Здесь перечислено не "что возвращает", а что еще меняет endpoint помимо ответа.

### Auth

`POST /auth/send-code`
- нормализует номер;
- создает/обновляет запись OTP;
- обновляет `last_sent_at`;
- пишет OTP в лог при dev-fallback.

`POST /auth/verify-code`
- увеличивает attempts при неверном коде;
- удаляет OTP при успешной верификации;
- может создать `users` row;
- обновляет `last_login`;
- может заполнить профиль;
- ставит cookie token.

### WhatsApp

`POST /whatsapp/start`
- создает/активирует in-memory session;
- запускает connection flow.

`POST /whatsapp/sync-groups`
- обновляет `whatsapp_groups`;
- не должен терять `is_selected`, `send_time`, `last_send_error`.

`POST /whatsapp/groups/select`
- обновляет `is_selected`.

`POST /whatsapp/groups/time`
- обновляет `send_time`.

`POST /whatsapp/disconnect`
- отключает session;
- логирует `source`, user-agent, IP.

`POST /whatsapp/reset`
- очищает session caches/state.

### Telegram

`POST /telegram/qr/start`
- создает auth attempt / QR flow.

`POST /telegram/sync-groups`
- обновляет `telegram_groups`;
- может обновить `tg_phone`, статистику и stale-state.

`POST /telegram/groups/time`
- сохраняет `send_time`.

`POST /telegram/send-test`
- реально выполняет отправку по production send path;
- может записывать/очищать `last_send_error`.

### Templates

`POST /templates/create`
- создает template row.

`POST /templates/upload-media`
- сохраняет media в storage;
- возвращает публичный URL, который затем сохраняется в template.

`POST /templates/targets/set`
- заменяет набор target groups для шаблона по каналу;
- сохраняет per-group overrides.

### Campaigns

`POST /campaigns/start-multi`
- создает campaign row;
- создает campaign jobs;
- запускает постановку в очередь;
- проверяет subscriptions/paywall.

`POST /campaigns/set-pause`
- меняет pause state;
- может enqueuить продолжение jobs после resume.

`POST /campaigns/:campaignId/requeue`
- повторно ставит jobs в очередь.

`POST /campaigns/:campaignId/resync-schedule-from-templates`
- пересчитывает `scheduled_at` для pending jobs.

`POST /campaigns/:campaignId/stop`
- массово обновляет jobs/campaign status.

### Payments

`POST /payments/prodamus/create`
- создает payment row;
- пишет `order_id`;
- строит payment URL.

`POST /payments/prodamus/webhook`
- меняет payment status;
- продлевает subscription;
- может возобновлять паузы кампаний;
- может выдавать referral reward.

### Leads

`POST /leads`
- вставляет строку в `lead_requests`;
- пишет `user_agent`, `ip`.

### Sheets

`POST /sheets/create`
- создает sheet/связанные ресурсы для пользователя.

### Admin

Admin endpoints реально модифицируют продовые user/subscription rows и поэтому должны быть строго совместимы.

---

## 22. Error/message catalog

Ниже не исчерпывающий абсолютный список всех возможных строк из сервисов, а тот набор, который уже важен для фронта, интеграций или операторской диагностики.

### 22.1 Auth / profile

- `No token provided`
- `Invalid token`
- `Invalid token payload`
- `User not found`
- `phone is required`
- `phone_too_short`
- `code_too_short`
- `too_many_requests`
- `invalid_code`
- `code_expired`
- `too_many_attempts`
- `user_not_found`
- `forbidden`
- `missing_secret`
- `invalid_secret`
- `code_not_found_or_expired`

### 22.2 Guards / ownership

- `no_user`
- `user_id_mismatch`
- `template_owner_mismatch`

### 22.3 WhatsApp

- `whatsapp_not_connected`
- `wa_group_id is required`
- `wa_group_ids array is required`

### 22.4 Telegram

- `telegram_not_connected`
- `tg_chat_id is required`
- `password is required`
- `code is required`
- `already_connected`
- `PEER_ID_INVALID`
- `CHANNEL_INVALID`
- `CHAT_WRITE_FORBIDDEN`
- `USER_BANNED_IN_CHANNEL`
- `CHANNEL_PRIVATE`

### 22.5 Templates

- `templateId is required`
- `groupJids must be array`
- `file is required`
- `supabase_targets_insert_error`

### 22.6 Campaigns

- `campaignId is required`
- `no_groups`
- `no_templates`
- `tg_preflight_blocked`
- `campaign_not_running`
- `no_pending_jobs`
- `campaign_stopped`
- `pause_not_supported_by_schema`

### 22.7 Subscription / payment

- `subscription_expired`
- `trial_expired`
- `no_subscription`
- `plan_not_allowed`
- `payment_config_error`
- `supabase_users_error`
- `invalid_plan_code`
- `supabase_payments_insert_error`
- `payment_provider_error`
- `invalid_signature`
- `customer_contact_missing`
- `prodamus_set_activity_failed`
- `subscription_not_found`
- `already_active`
- `trial_already_running`
- `user_blocked`

### 22.8 Leads / infra

- `invalid_phone`
- `consent_personal_required`
- `supabase_insert_error`
- `supabase_select_error`
- `supabase_update_error`
- `supabase_upsert_error`

---

## 23. Frontend page to API dependency map

Это особенно полезно второму разработчику: видно, что нельзя "потом доделать", потому что без этого конкретные страницы просто не откроются.

### `/auth/phone` and login flow

Depends on:
- `POST /auth/send-code`
- `POST /auth/verify-code`
- `GET /auth/me`

### `/cabinet`

Depends on:
- `GET /auth/me`
- `POST /auth/update-profile`
- `GET /subscriptions/me`
- `POST /subscriptions/start-trial`
- `POST /payments/prodamus/create`
- `POST /whatsapp/start`
- `GET /whatsapp/status/:userId`
- `POST /telegram/qr/start`
- `GET /telegram/qr/status/:userId`

### `/dashboard/groups`

Depends on:
- `GET /whatsapp/groups/:userId`
- `GET /whatsapp/groups/:userId/count`
- `GET /whatsapp/groups/:userId/phones`
- `POST /whatsapp/groups/select`
- `POST /whatsapp/groups/select-batch`
- `POST /whatsapp/groups/time`
- `POST /whatsapp/sync-groups`
- avatar endpoints

### `/dashboard/groups/telegram`

Depends on:
- `GET /telegram/groups/:userId`
- `GET /telegram/groups/:userId/count`
- `GET /telegram/groups/:userId/phones`
- `POST /telegram/groups/select`
- `POST /telegram/groups/select-all`
- `POST /telegram/groups/time`
- `POST /telegram/sync-groups`
- `GET /telegram/qr/status/:userId`
- `GET /telegram/status/:userId`

### `/dashboard/templates`

Depends on:
- `GET /templates/list/:userId`
- `POST /templates/update`
- `POST /templates/delete`
- `GET /templates/targets/summary/:userId/:channel`

### `/dashboard/templates/new`

Depends on:
- `GET /auth/me`
- `GET /whatsapp/groups/:userId`
- `GET /telegram/groups/:userId`
- `GET /telegram/groups/:userId/count`
- `GET /telegram/groups/:userId/phones`
- `POST /templates/upload-media`
- `POST /templates/create`
- `POST /templates/targets/set`
- `GET /telegram/premium-status/:userId`

### `/dashboard/templates/[templateId]`

Depends on:
- `GET /templates/get/:templateId`
- `GET /templates/targets/:userId/:templateId/:channel`
- `POST /templates/targets/set`
- `POST /templates/update`
- `POST /templates/upload-media`
- `GET /whatsapp/groups/:userId`
- `GET /telegram/groups/:userId`

### `/dashboard/campaigns`

Depends on:
- `GET /campaigns/active`
- `GET /campaigns/pause-state/:channel`
- `POST /campaigns/set-pause`
- `POST /campaigns/start-multi`
- `GET /campaigns/preflight/tg`

### `/dashboard/campaign`

Depends on:
- `GET /campaigns/:campaignId/progress`
- `POST /campaigns/:campaignId/stop`
- `GET /whatsapp/groups/:userId`
- `GET /telegram/groups/:userId`
- `GET /templates/list/:userId`

### `/dashboard/campaigns/timing`

Depends on:
- `GET /auth/me`
- `GET /whatsapp/groups/:userId`
- `GET /telegram/groups/:userId`
- `GET /campaigns/active`
- `GET /campaigns/:campaignId/progress`

### `/dashboard/analytics`

Depends on:
- `GET /campaigns/list`

### Admin UI

Depends on:
- `GET /admin/users`
- `POST /admin/users/:id/block`
- `POST /admin/users/:id/grant-trial`
- `POST /admin/users/:id/grant-access`
- `POST /admin/users/:id/reduce-trial`
- `POST /admin/users/:id/reduce-access`
- `GET /admin/campaigns/diagnostics`

---

## 24. Practical implementation notes for the Go developer

Это уже не "контракт", а то, что почти наверняка сэкономит время при переписывании.

### 24.1 Не начинать с redesign API

Самый безопасный путь:
1. Повторить routes 1:1.
2. Повторить JSON shape 1:1.
3. Повторить `message` codes 1:1.
4. Потом уже улучшать внутреннюю архитектуру.

### 24.2 Нельзя "улучшить" naming на лету

Не переименовывать:
- `payment_url` -> `url`
- `wa_group_id` -> `groupId`
- `tg_chat_id` -> `chatId`
- `is_selected` -> `selected`
- `send_time` -> `sendTime`
- `full_name` -> `fullName`

Это сломает frontend немедленно.

### 24.3 TG and WA stateful subsystems

Это не просто CRUD backend.

Нужно сохранить semantics:
- долгоживущие session objects;
- sync групп отдельно от send flow;
- last error markers по группам;
- возможность reconnect/retry;
- clear stale errors after successful send.

### 24.4 Сначала поднять thin compatibility layer

Если Go backend будет развиваться параллельно, можно сделать:
- тот же внешний контракт;
- внутри заглушки или proxy на старый backend;
- постепенно заменять модули по одному.

Это сильно безопаснее, чем переписать все сразу и потом ловить несовместимости с frontend.

### 24.5 Что тестировать в первую очередь

Если проверять не все подряд, а только самые опасные сценарии:

1. login по OTP;
2. `/auth/me`;
3. WA connect + group list;
4. TG connect + group list;
5. template create/update/upload-media/targets;
6. campaign start/progress/stop;
7. trial start;
8. payment create;
9. webhook payment;
10. admin users.
