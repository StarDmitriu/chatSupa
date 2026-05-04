#!/usr/bin/env bash
# Вариант B: перевести backend и frontend на PM2 (без Docker app).
# Останавливает Docker frontend+backend, при необходимости собирает frontend на хосте,
# поднимает backend и frontend под PM2. Redis можно оставить в Docker.
# Использование: ./scripts/switch-to-pm2.sh   или   npm run switch-to-pm2

set -e
cd "$(dirname "$0")/.."

echo "=== ЧатРассылка: переход на PM2 (backend + frontend на хосте) ==="

# 1. Остановить Docker frontend и backend (освободить память)
if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
  echo "Останавливаю Docker frontend и backend..."
  docker compose stop frontend backend 2>/dev/null || true
  echo "  Готово. Память освобождена."
fi

# 2. Собрать frontend на хосте, если ещё не собран
if [ ! -f frontend/.next/BUILD_ID ]; then
  echo ""
  echo "Сборка frontend на хосте (нужно ~4–6 ГБ RAM)..."
  (cd frontend && npm ci && NODE_OPTIONS=--max-old-space-size=6144 npm run build:webpack) || {
    echo "Ошибка: сборка frontend не удалась."
    echo "Можно поднять только backend: ./start-pm2.sh (frontend не запустится)."
    exit 1
  }
  echo "  Frontend собран."
else
  echo "Frontend уже собран (frontend/.next/BUILD_ID)."
fi

# 3. Остановить старый PM2 и освободить порты
echo ""
echo "Останавливаю старый PM2 и освобождаю порты 3000, 3001..."
./stop-pm2.sh 2>/dev/null || true

# 4. Запустить backend и frontend под PM2
echo ""
./start-pm2.sh

echo ""
echo "=============================================="
echo "  Backend и frontend запущены под PM2."
echo "  Backend:  http://127.0.0.1:3000"
echo "  Frontend: http://127.0.0.1:3001"
echo "=============================================="
echo ""
echo "Чтобы сайт по домену (HTTPS) не отдавал 502, переключите nginx на проксирование на хост (PM2):"
echo "  npm run nginx:pm2-docker   (nginx остаётся в Docker, проксирует на host.docker.internal:3000, :3001)"
echo "Либо nginx на хосте: deploy/nginx/default.pm2.conf и sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "Redis можно оставить в Docker: docker compose up -d redis"
echo "  (backend под PM2 подключается к 127.0.0.1:6379 — порт проброшен из контейнера)"
echo ""
