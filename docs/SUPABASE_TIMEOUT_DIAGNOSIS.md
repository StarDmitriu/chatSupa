# Диагностика: «База данных не ответила вовремя» (Supabase timeout)

## Статус билда и сервисов

- **PM2**: backend и frontend в статусе `online`, перезапусков по падениям нет.
- **Билд**: сборки backend и frontend проходят успешно.

## Что проверено

1. **Доступность Supabase с сервера (VPS)**  
   - Запрос к `https://aomfbzhqxrijkvelyxkc.supabase.co/rest/v1/otp_codes?...` с сервера (curl, таймаут 10 сек): **ответ не пришёл** (HTTP_CODE:000, таймаут ~10 с).
   - TCP до `aomfbzhqxrijkvelyxkc.supabase.co:443` открывается (порт доступен).

2. **Логи backend**  
   - В логах есть **Supabase timeout in sendCode** и тело ответа — **страница Cloudflare 522** (Connection timed out).  
   - То есть до Supabase запрос доходит через Cloudflare, но ответ от origin не успевает — срабатывает таймаут (у Cloudflare до ~15–90 сек в зависимости от фазы).

3. **Логи Supabase (mgmt-api)**  
   - В логах Supabase по проекту `aomfbzhqxrijkvelyxkc` видно запросы к `/tenants/.../health` от `@supabase-infra/mgmt-api`.  
   - **Большинство запросов в статусе ABORTED REQ** — health-check не успевает завершиться. Лишь единичные ответы 200.  
   - Это подтверждает: инстанс нестабилен на стороне Supabase; проблема не в нашем коде и не в сети VPS.

## Вывод

- Сообщение пользователю **корректно**: база (Supabase) реально не отвечает вовремя с этого сервера.
- Проблема не в коде и не в билде, а в **доступности Supabase с данного VPS** (сеть/Cloudflare/origin).

## Типичные причины 522 до Supabase

- Проект Supabase **приостановлен** (free tier после неактивности) или перегружен.
- **Сеть/файрвол** между Cloudflare и origin Supabase (или между VPS и Cloudflare) режет/задерживает трафик.
- **Троттлинг или блокировка** по IP (в т.ч. со стороны хостера VPS).

## Что сделать

1. **Supabase Dashboard**  
   - Проект `aomfbzhqxrijkvelyxkc`: статус (Active/Paused), регион, инциденты.  
   - При необходимости — Resume project.

2. **Проверка с другой сети**  
   - Открыть в браузере с другого интернета (например, с телефона):  
     `https://aomfbzhqxrijkvelyxkc.supabase.co/rest/v1/` (с заголовком `apikey: <SUPABASE_KEY>`).  
   - Если там ответ приходит, а с VPS — нет, причина в сети/доступе с VPS.

3. **Долгосрочно**  
   - Уточнить у хостера VPS, не блокируют ли они трафик до Cloudflare/Supabase.  
   - Рассмотреть **Supabase Connection Pooler** (если используете прямой Postgres) или смену региона проекта, если доступ к текущему региону с VPS нестабилен.
