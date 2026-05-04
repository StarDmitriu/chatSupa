#!/usr/bin/env bash
# Разрешить контейнерам Docker достучаться до PM2 на хосте (порты 3000, 3001).
# Без этого nginx в Docker при конфиге PM2 получает таймаут при proxy_pass на host.docker.internal.
# Запуск: sudo ./scripts/allow-docker-to-host-pm2.sh

set -e

if [[ $EUID -ne 0 ]]; then
  echo "Запустите с sudo: sudo $0"
  exit 1
fi

# Диапазон Docker bridge: 172.17.0.0/12 (172.17–172.31)
# Разрешаем входящий TCP на порты 3000 и 3001 с контейнеров
if ! iptables -C INPUT -s 172.17.0.0/12 -p tcp -m multiport --dports 3000,3001 -j ACCEPT 2>/dev/null; then
  iptables -I INPUT 1 -s 172.17.0.0/12 -p tcp -m multiport --dports 3000,3001 -j ACCEPT
  echo "Добавлено правило: INPUT -s 172.17.0.0/12 -p tcp --dports 3000,3001 -j ACCEPT"
else
  echo "Правило уже есть."
fi

echo ""
echo "Готово. Контейнеры могут подключаться к хосту на портах 3000 и 3001."
echo "Чтобы правила сохранялись после перезагрузки, используйте iptables-persistent (Debian/Ubuntu):"
echo "  sudo apt install iptables-persistent"
echo "  sudo netfilter-persistent save"
