#!/bin/bash
# Быстрый аудит сервера на признаки заражения (криптомайнер, подмена бинарников, крон).
# Запуск: sudo ./security-audit.sh

set -e
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== Аудит безопасности $(date) ==="
ISSUES=0

# 1. Подозрительные процессы (высокая загрузка CPU, nohup, бинарники из /etc с длинными именами)
echo ""
echo "--- Процессы с высокой загрузкой CPU ---"
if ps aux --sort=-%cpu | head -15 | grep -v '^USER.*COMMAND' | grep -v '\[.*\]'; then
  if ps aux | grep -E 'nohup.*/dev/null|/etc/[a-zA-Z]{10,}' | grep -v grep; then
    echo -e "${RED}[!] Найден подозрительный процесс (nohup или бинарник из /etc).${NC}"
    ISSUES=$((ISSUES+1))
  fi
fi

# 2. Файлы в /etc с "случайными" длинными именами (типично для данного майнера)
echo ""
echo "--- Подозрительные файлы в /etc (бинарники с длинным именем) ---"
FAKE=$(find /etc -maxdepth 1 -type f -executable 2>/dev/null | while read -r f; do
  name="$(basename "$f")"
  if echo "$name" | grep -qE '^[a-z]{10,}$'; then
    echo "$f"
  fi
done)
if [ -n "$FAKE" ]; then
  echo "$FAKE"
  echo -e "${RED}[!] Обнаружены исполняемые файлы в /etc с подозрительными именами.${NC}"
  ISSUES=$((ISSUES+1))
else
  echo -e "${GREEN}Не найдено.${NC}"
fi

# 3. Крон: задачи, запускающие nohup или скрипты из /etc с длинными именами
echo ""
echo "--- Подозрительные записи в cron ---"
CRON_BAD=$(grep -rE 'nohup|/etc/[a-zA-Z]{10,}' /etc/cron.d /etc/cron.daily /etc/crontab /var/spool/cron 2>/dev/null || true)
if [ -n "$CRON_BAD" ]; then
  echo "$CRON_BAD"
  echo -e "${RED}[!] Обнаружены подозрительные cron-задачи.${NC}"
  ISSUES=$((ISSUES+1))
else
  echo -e "${GREEN}Не найдено.${NC}"
fi

# 4. Наличие критичных системных утилит
echo ""
echo "--- Проверка системных утилит ---"
for cmd in ls python3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo -e "${RED}[!] Отсутствует или повреждена утилита: $cmd${NC}"
    ISSUES=$((ISSUES+1))
  else
    echo -e "${GREEN}$cmd: $(command -v $cmd)${NC}"
  fi
done

# 5. Слушающие порты (кратко)
echo ""
echo "--- Слушающие порты (TCP) ---"
if command -v ss &>/dev/null; then
  ss -tlnp 2>/dev/null | head -20
elif command -v netstat &>/dev/null; then
  netstat -tlnp 2>/dev/null | head -20
fi

echo ""
if [ $ISSUES -gt 0 ]; then
  echo -e "${RED}Итого: обнаружено признаков заражения: $ISSUES. Рекомендуется проверка и устранение точки входа.${NC}"
  exit 1
else
  echo -e "${GREEN}Явных признаков заражения не обнаружено. Рекомендуется также обновлять ОС и зависимости приложений.${NC}"
  exit 0
fi
