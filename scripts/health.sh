#!/usr/bin/env bash
# Проверка здоровья: Docker — все контейнеры healthy; иначе PM2 — backend online; Redis — ping.
# Выход: 0 — всё ок, 1 — что-то не так. Для cron/мониторинга.
# Использование: ./scripts/health.sh   или   npm run health

set -e
cd "$(dirname "$0")/.."

FAILED=0

# Redis
if command -v redis-cli >/dev/null 2>&1; then
  if ! redis-cli ping >/dev/null 2>&1; then
    echo "health: Redis не отвечает"
    FAILED=1
  fi
fi

# Docker: если контейнеры запущены — проверяем healthy
if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
  running=$(docker compose ps --services --status running 2>/dev/null | wc -l)
  if [ "${running}" -gt 0 ]; then
    unhealthy=$(docker compose ps --format json 2>/dev/null | grep -c '"Health":"unhealthy"' || true)
    if [ "${unhealthy}" -gt 0 ]; then
      echo "health: Docker — есть unhealthy контейнеры"
      docker compose ps --format "table {{.Name}}\t{{.Status}}"
      FAILED=1
    fi
  fi
fi

# PM2: если есть процессы — backend должен быть online
if command -v pm2 >/dev/null 2>&1; then
  if pm2 list 2>/dev/null | grep -q backend; then
    if ! pm2 list --no-color 2>/dev/null | grep backend | grep -q online; then
      echo "health: PM2 backend не online"
      FAILED=1
    fi
  fi
fi

if [ "$FAILED" = "1" ]; then
  exit 1
fi
exit 0
