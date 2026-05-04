#!/usr/bin/env bash
# Полный отчёт по состоянию: сборка, Docker, PM2, Redis, диск, порты.
# Использование: ./scripts/status-full.sh   или   npm run report

set -e
cd "$(dirname "$0")/.."

echo "=============================================="
echo "  ЧатРассылка — полный статус"
echo "  $(date -Iseconds 2>/dev/null || date)"
echo "=============================================="
echo ""

# Сборка на хосте
echo "--- Сборка на хосте ---"
if [ -f backend/dist/main.js ]; then
  echo "  backend:  собран (backend/dist/main.js)"
else
  echo "  backend:  не собран"
fi
if [ -f frontend/.next/BUILD_ID ]; then
  echo "  frontend: собран (frontend/.next/BUILD_ID)"
else
  echo "  frontend: не собран"
fi
echo ""

# Redis
echo "--- Redis (порт 6379) ---"
if command -v redis-cli >/dev/null 2>&1; then
  if redis-cli ping >/dev/null 2>&1; then
    echo "  redis-cli ping: PONG"
  else
    echo "  redis-cli ping: не отвечает"
  fi
else
  echo "  redis-cli не установлен"
fi
echo ""

# Docker
echo "--- Docker ---"
if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
  docker compose ps 2>/dev/null || true
else
  echo "  Docker не используется или docker-compose.yml отсутствует"
fi
echo ""

# PM2
echo "--- PM2 ---"
if command -v pm2 >/dev/null 2>&1; then
  pm2 list 2>/dev/null || true
else
  echo "  PM2 не установлен"
fi
echo ""

# Порты 3000, 3001
echo "--- Порты 3000, 3001 ---"
for port in 3000 3001; do
  if (command -v lsof >/dev/null 2>&1 && lsof -ti:"${port}" >/dev/null 2>&1) || (command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ":${port} "); then
    echo "  порт ${port}: занят"
  else
    echo "  порт ${port}: свободен"
  fi
done
echo ""

# Диск
echo "--- Диск ---"
df -h / 2>/dev/null | tail -1 | awk '{ printf "  /: %s использовано, %s свободно\n", $3, $4 }'
echo ""

# .env
echo "--- Backend .env ---"
if [ -f backend/.env ]; then
  echo "  файл backend/.env: есть"
else
  echo "  файл backend/.env: отсутствует (критично для запуска)"
fi
echo "=============================================="
