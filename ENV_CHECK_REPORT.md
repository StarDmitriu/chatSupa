# Проверка .env файлов

**Дата:** 07.02.2026  
Секретные значения в отчёт не копируются.

---

## 1. backend/.env (используется в Docker Compose)

| Переменная | Статус | Комментарий |
|------------|--------|--------------|
| PORT, REDIS_HOST, REDIS_PORT, REDIS_URL | ✅ | Для Docker REDIS_URL=redis://redis:6379 ок; в compose заданы REDIS_HOST/PORT, очередь их подхватит |
| SUPABASE_URL, SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY | ✅ | Есть; бэкенд стартует |
| JWT_SECRET | ⚠️ | Задан, но значение предсказуемое (русская фраза). Для прода лучше длинная случайная строка (32+ символов) |
| SMSRU_API_ID | ⚠️ | Закомментирован — SMS с кодами входа не отправляются, только запись в лог |
| PRODAMUS_FORM_URL, PRODAMUS_SECRET_KEY, PRODAMUS_SYS | ✅ | Заданы — оплата будет работать |
| APPS_SCRIPT_URL, APPS_SCRIPT_SECRET | ✅ | Заданы — интеграция с Google Sheets работает |
| TG_API_ID, TG_API_HASH, TELEGRAM_AUTOCONNECT, DEFAULT_TZ, CAMPAIGN_REPEAT_ENABLED | ✅ | Заданы |

**Итог:** для текущего продакшена (Docker) backend/.env достаточен. Рекомендации: раскомментировать SMSRU_API_ID, если нужна отправка SMS; сменить JWT_SECRET на сильный случайный секрет.

---

## 2. .env (корень проекта)

Похож на локальную разработку: REDIS_HOST=127.0.0.1, нет PRODAMUS и APPS_SCRIPT.  
Если backend запускается из корня с этим файлом — нужны те же переменные, что и в backend/.env (JWT, SUPABASE, при необходимости PRODAMUS, APPS_SCRIPT, SMSRU).  
Сейчас в корне нет env_file в compose — бэкенд берёт только backend/.env. Файл .env в корне может использоваться для локального `npm run start` в backend — тогда для оплаты и Sheets переменные надо добавить в этот .env или запускать с backend/.env.

---

## 3. .env.prod

| Проблема | Детали |
|----------|--------|
| Нет PRODAMUS_* | В продакшене через этот файл оплата не заработает, если он подставляется в backend |
| Нет APPS_SCRIPT_* | Интеграция с Google Sheets не будет работать |
| Нет SMSRU_API_ID | SMS не отправляются |
| JWT_SECRET | Значение типа `super_secret_change_me` — слабое, нужно заменить на случайный секрет |
| NEXT_PUBLIC_BACKEND_URL=https://api.chatrassylka.ru | Для текущего Docker-деплоя фронт получает `NEXT_PUBLIC_BACKEND_URL=/api` из compose; если .env.prod используется для фронта на другом хосте — ок. Если подставляется во фронт в Docker — будет конфликт с /api |

**Итог:** .env.prod выглядит как неполный шаблон. Для продакшена на Docker основным является backend/.env; .env.prod лучше привести в соответствие (добавить PRODAMUS, APPS_SCRIPT, SMSRU при необходимости) или явно пометить, для какого сценария он предназначен.

---

## 4. Расхождение Telegram API

- **backend/.env:** TG_API_ID=38793584, свой TG_API_HASH  
- **.env и .env.prod:** TG_API_ID=38841476, другой TG_API_HASH  

В Docker используется только backend/.env, значит в контейнере бэкенда — 38793584. Если продакшен должен работать с приложением 38841476, в backend/.env нужно подставить значения из .env.prod. Если два приложения (dev/prod) — убедиться, что в backend/.env именно то, которое нужно для прода.

---

## 5. Безопасность (без вывода значений)

- Все три файла содержат ключи и секреты; они не должны попадать в git. Проверь, что .env, backend/.env и .env.prod в .gitignore (обычно так и есть).
- JWT_SECRET и PRODAMUS_SECRET_KEY — критичные; хранить только в env, не логировать. В коде есть `console.log('SECRET:', ...)` для Prodamus — его нужно убрать.
- SUPABASE_SERVICE_ROLE_KEY обходит RLS; утечка даёт полный доступ к БД. Доступ только из backend, не отдавать на фронт.

---

## 6. Краткий чек-лист

| Вопрос | Ответ |
|--------|--------|
| Бэкенд в Docker стартует с backend/.env? | Да, если SUPABASE_* и JWT_SECRET заданы — да |
| Оплата (Prodamus) в текущем продакшене? | Да, переменные есть в backend/.env |
| SMS с кодами входа? | Нет, пока SMSRU_API_ID закомментирован |
| Telegram (QR, группы)? | Да, TG_* заданы в backend/.env |
| Один источник правды для прода? | backend/.env при деплое через docker-compose |
| .env.prod актуален? | Нет, неполный; выровнять с backend/.env или явно описать сценарий использования |
