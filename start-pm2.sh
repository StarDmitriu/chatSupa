#!/usr/bin/env bash
# Текущий режим продакшена: PM2. Nginx и redis в Docker; backend и frontend на хосте.
# Запуск приложения через PM2: останавливает старые процессы, освобождает порты, собирает при необходимости, запускает.
# Использование: ./start-pm2.sh   или   bash start-pm2.sh
# Требуется: Node.js, Redis, backend/.env, pm2 (npm i -g pm2).

set -e
cd "$(dirname "$0")"

echo "=== Чат-рассылка: запуск через PM2 ==="

# PM2
if ! command -v pm2 >/dev/null 2>&1; then
  echo "Ошибка: PM2 не найден. Установите: npm install -g pm2"
  exit 1
fi

# Останавливаем старый экземпляр в PM2 (если был)
pm2 delete ecosystem.config.cjs 2>/dev/null || true

# Освобождаем порты 3000 и 3001 (старые node/next не из PM2)
free_port() {
  local port=$1
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti:"${port}" 2>/dev/null); [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  fi
}
free_port 3000
free_port 3001
sleep 1

# Redis (хост или контейнер chatrassylka_redis)
REDIS_OK=
if command -v redis-cli >/dev/null 2>&1 && redis-cli ping >/dev/null 2>&1; then
  REDIS_OK=1
elif command -v docker >/dev/null 2>&1 && docker exec chatrassylka_redis redis-cli ping >/dev/null 2>&1; then
  REDIS_OK=1
fi
if [ -n "$REDIS_OK" ]; then
  echo "Redis: OK"
else
  echo "Предупреждение: Redis не отвечает. Запустите Redis (порт 6379), например: docker compose up -d redis"
fi

# .env
if [ ! -f backend/.env ]; then
  echo "Ошибка: backend/.env не найден."
  exit 1
fi

# Сборка при необходимости
if [ ! -f backend/dist/main.js ]; then
  echo "Сборка backend..."
  (cd backend && npm ci && npm run build)
fi
if [ ! -f frontend/.next/BUILD_ID ]; then
  echo "Frontend не собран — запускаю только backend."
  echo "Чтобы собрать frontend: cd frontend && npm run build:webpack (нужно ~4–6 ГБ RAM)."
fi

# Запуск: оба приложения или только backend, если frontend не собран
if [ -f frontend/.next/BUILD_ID ]; then
  echo "Запуск PM2 (backend + frontend)..."
  pm2 start ecosystem.config.cjs
  echo ""
  echo "Готово. Backend: :3000  Frontend: :3001"
else
  echo "Запуск PM2 (только backend)..."
  pm2 start ecosystem.config.cjs --only backend
  echo ""
  echo "Готово. Backend: :3000  (frontend не запущен — нет сборки)"
fi
echo "Команды:  npm run status   npm run logs   npm run restart   npm run stop"
exit 0
