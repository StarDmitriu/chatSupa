#!/usr/bin/env bash
# Остановка приложения: PM2 + освобождение портов 3000, 3001.
# Использование: ./stop-pm2.sh

set -e
cd "$(dirname "$0")"

if command -v pm2 >/dev/null 2>&1; then
  pm2 delete ecosystem.config.cjs 2>/dev/null || true
fi

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

echo "Остановлено. Порты 3000 и 3001 освобождены."
