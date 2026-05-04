# Установка PM2 и запуск приложения

## Если PM2 не найден

### 1. Установить Node.js (если ещё не установлен)

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Или через nvm: <https://github.com/nvm-sh/nvm>

### 2. Установить PM2 глобально

```bash
sudo npm install -g pm2
```

### 3. Собрать и запустить приложение

Из корня проекта (`/var/www`):

```bash
cd /var/www

# Сборка бэкенда и фронтенда
cd backend && npm install && npm run build && cd ..
cd frontend && npm install && npm run build && cd ..
# postbuild автоматически копирует static и public в standalone

# Запуск через скрипт (проверяет Redis, порты, подхватывает .env)
./start-pm2.sh
```

Или вручную после сборки:

```bash
cd /var/www
pm2 start ecosystem.config.cjs
```

### 4. Рестарт после смены JWT_SECRET или .env

```bash
cd /var/www
pm2 restart all
```

Проверка: `pm2 status` и `pm2 logs`.

---

**Важно:** Бэкенд при запуске из `backend/` ищет `.env` в каталоге `backend/`. Если у вас `.env` в корне (`/var/www/.env`), скопируйте или сделайте симлинк:

```bash
cp /var/www/.env /var/www/backend/.env
# или: ln -sf /var/www/.env /var/www/backend/.env
```

После смены JWT_SECRET в `/var/www/.env` обновите и `backend/.env` (или используйте симлинк).
