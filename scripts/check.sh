#!/usr/bin/env bash
# Проверка перед деплоем: тесты backend (unit + e2e), lint frontend.
# Выход: 0 — всё ок, 1 — что-то упало. Для CI.
# Использование: ./scripts/check.sh   или   npm run check

cd "$(dirname "$0")/.."
FAILED=0

echo "=== ЧатРассылка: проверка (тесты + lint) ==="

echo ""
echo "--- Backend: юнит-тесты ---"
if (cd backend && npm run test >/dev/null 2>&1); then
  echo "  OK"
else
  echo "  FAIL"
  (cd backend && npm run test 2>&1) || true
  FAILED=1
fi

echo ""
echo "--- Backend: e2e (нужен Redis) ---"
if (cd backend && npm run test:e2e >/dev/null 2>&1); then
  echo "  OK"
else
  echo "  FAIL (или Redis не запущен)"
  FAILED=1
fi

echo ""
echo "--- Frontend: lint ---"
if (cd frontend && npm run lint >/dev/null 2>&1); then
  echo "  OK"
else
  echo "  FAIL"
  (cd frontend && npm run lint 2>&1) || true
  FAILED=1
fi

echo ""
if [ "$FAILED" = "1" ]; then
  echo "=== Проверка завершилась с ошибками ==="
  exit 1
fi
echo "=== Всё OK ==="
exit 0
