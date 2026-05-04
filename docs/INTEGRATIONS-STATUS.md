# Статус интеграций ЧатРассылка

Проверка выполнена: 2026-02-16

## ✅ Работающие интеграции

### 1. **Supabase (База данных)**
- **Статус:** ✅ Работает
- **URL:** `https://aomfbzhqxrijkvelyxkc.supabase.co`
- **Проверка:** API отвечает, таблицы доступны
- **Переменные:** `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

### 2. **Redis (Очереди и кэш)**
- **Статус:** ✅ Работает
- **Хост:** `127.0.0.1:6379`
- **Проверка:** Подключение установлено (`[Redis] connected`)
- **Использование:** BullMQ очереди для кампаний

### 3. **SMS.ru (Отправка SMS кодов)**
- **Статус:** ✅ Работает
- **API ID:** `324F00E2-25D9-E3F0-89BE-2C0DC153E814`
- **Проверка:** SMS успешно отправляются (`LOG [SmsService] SMS sent via sms.ru`)
- **Переменные:** `SMSRU_API_ID`, `SMSRU_FROM` (опционально)

### 4. **BullMQ (Очереди задач)**
- **Статус:** ✅ Работает
- **Worker:** `campaign-send` запущен
- **Проверка:** `LOG [CampaignBullWorker] BullMQ worker started`

### 5. **Campaign Repeat Service (Повторяющиеся кампании)**
- **Статус:** ✅ Работает
- **Интервал:** 10 секунд
- **Проверка:** Регулярные тики в логах (`repeat tick`)
- **Переменные:** `CAMPAIGN_REPEAT_ENABLED=true`

### 6. **PM2 (Процессы)**
- **Статус:** ✅ Работает
- **Backend:** online (порт 3000)
- **Frontend:** online (порт 3001)
- **Автозапуск:** настроен (`pm2 startup`)

### 7. **Nginx (Прокси)**
- **Статус:** ✅ Работает
- **Домен:** `chatrassylka.ru`, `www.chatrassylka.ru`
- **SSL:** Let's Encrypt сертификат установлен
- **Прокси:** `/api/` → backend:3000, остальное → frontend:3001

## 🔧 Интеграции, требующие проверки

### 1. **Telegram API**
- **Статус:** ⚠️ Нужна проверка
- **API ID:** `38841476`
- **API Hash:** `f7d028dd897d7c54ed245b7a959bb68c`
- **Переменные:** `TG_API_ID`, `TG_API_HASH`
- **Примечание:** Интеграция настроена, но нужна проверка через реальное подключение пользователя

### 2. **WhatsApp (Baileys)**
- **Статус:** ⚠️ Нужна проверка
- **Библиотека:** `@whiskeysockets/baileys`
- **Примечание:** Интеграция настроена, но нужна проверка через реальное подключение пользователя

### 3. **Google Apps Script**
- **Статус:** ⚠️ Нужна проверка
- **URL:** `https://script.google.com/macros/s/AKfycbxPfuTh2yUrxHj4GUKjTeqt6YV87cPcl6v0bCaq_B7oscr6-ATYm_8d1p56Iz28aH6viw/exec`
- **Secret:** `482913941ADF1331PRNVS1303`
- **Переменные:** `APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET`
- **Примечание:** Используется для работы с Google Sheets

### 4. **Prodamus (Платежи)**
- **Статус:** ⚠️ Нужна проверка
- **Webhook:** `/api/payments/prodamus/webhook`
- **Примечание:** Интеграция настроена, но нужна проверка через реальный платеж

## 📋 Переменные окружения

Все необходимые переменные заданы в `/var/www/.env` и `/var/www/backend/.env`:

```env
# База данных
SUPABASE_URL=...
SUPABASE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# SMS
SMSRU_API_ID=324F00E2-25D9-E3F0-89BE-2C0DC153E814

# Telegram
TG_API_ID=38841476
TG_API_HASH=f7d028dd897d7c54ed245b7a959bb68c

# Google Apps Script
APPS_SCRIPT_URL=...
APPS_SCRIPT_SECRET=...

# Кампании
CAMPAIGN_REPEAT_ENABLED=true

# Время
DEFAULT_TZ=Europe/Moscow
```

## 🔍 Проверка логов

Для проверки статуса интеграций:

```bash
# Общие логи backend
pm2 logs backend --lines 50

# Проверка ошибок
pm2 logs backend --lines 100 | grep -i error

# Проверка конкретной интеграции
pm2 logs backend --lines 200 | grep -i "telegram\|whatsapp\|sms\|redis\|supabase"
```

## ✅ Итог

**Основные интеграции работают нормально:**
- ✅ База данных (Supabase)
- ✅ Очереди (Redis + BullMQ)
- ✅ SMS отправка (SMS.ru)
- ✅ Веб-сервер (Nginx + SSL)
- ✅ Процессы (PM2)

**Интеграции, требующие проверки в реальных условиях:**
- ⚠️ Telegram (нужно подключение пользователя)
- ⚠️ WhatsApp (нужно подключение пользователя)
- ⚠️ Google Apps Script (нужно тестирование)
- ⚠️ Prodamus (нужен реальный платеж)

Все базовые сервисы настроены и работают. Для проверки Telegram/WhatsApp нужно подключить аккаунт через веб-интерфейс.
