#!/bin/bash
# Безопасная установка зависимостей только из официальных источников.
# Использование: ./safe-install-deps.sh /путь/к/распакованному/проекту
#
# Официальные реестры:
#   npm:  https://registry.npmjs.org/
#   PyPI: https://pypi.org/simple/
#   Packagist: https://packagist.org

set -e
OFFICIAL_NPM_REGISTRY="https://registry.npmjs.org/"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
  echo "Использование: $0 /путь/к/распакованному/проекту"
  echo "Скрипт определяет тип проекта (npm/Python/Composer) и устанавливает зависимости только из официальных источников."
  exit 1
}

[ -n "$1" ] && [ -d "$1" ] || usage
PROJECT_DIR="$(realpath "$1")"
cd "$PROJECT_DIR"
echo "Каталог проекта: $PROJECT_DIR"
echo ""

# --- npm / Node.js ---
if [ -f "package.json" ]; then
  echo "--- Обнаружен Node.js проект (package.json) ---"
  REG=$(npm config get registry 2>/dev/null || echo "none")
  REG_NORMALIZED="${REG%/}/"
  OFF_NORMALIZED="${OFFICIAL_NPM_REGISTRY%/}/"
  if [ "$REG_NORMALIZED" != "$OFF_NORMALIZED" ]; then
    echo -e "${YELLOW}Текущий реестр npm: $REG${NC}"
    echo "Устанавливаю официальный реестр: $OFFICIAL_NPM_REGISTRY"
    npm config set registry "$OFFICIAL_NPM_REGISTRY"
  fi
  echo -e "${GREEN}Реестр npm: $(npm config get registry)${NC}"
  echo "Запуск: npm install (только официальный registry.npmjs.org)..."
  npm install
  if grep -q '"next"' package.json 2>/dev/null; then
    echo ""
    echo "Обнаружен Next.js. Рекомендуется обновить до безопасной версии (React2Shell):"
    echo "  npx fix-react2shell-next"
    read -p "Запустить npx fix-react2shell-next сейчас? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[yY] ]]; then
      npx fix-react2shell-next
    fi
  fi
  echo -e "${GREEN}Готово (Node.js).${NC}"
  exit 0
fi

# --- Python (pip) ---
if [ -f "requirements.txt" ]; then
  echo "--- Обнаружен Python проект (requirements.txt) ---"
  echo "Официальный индекс: https://pypi.org"
  echo "Запуск: pip install -r requirements.txt (только PyPI)..."
  if command -v pip3 &>/dev/null; then
    pip3 install --requirement requirements.txt
  elif command -v pip &>/dev/null; then
    pip install --requirement requirements.txt
  else
    echo -e "${RED}pip не найден. Установите: apt install python3-pip${NC}"
    exit 1
  fi
  echo -e "${GREEN}Готово (Python).${NC}"
  exit 0
fi

if [ -f "pyproject.toml" ]; then
  echo "--- Обнаружен Python проект (pyproject.toml) ---"
  echo "Официальный индекс: https://pypi.org"
  if command -v uv &>/dev/null; then
    uv sync
  elif command -v pip3 &>/dev/null; then
    pip3 install -e .
  else
    echo -e "${YELLOW}Рекомендуется: pip3 install -e . (из каталога с pyproject.toml)${NC}"
    pip3 install -e . 2>/dev/null || true
  fi
  echo -e "${GREEN}Готово (Python).${NC}"
  exit 0
fi

# --- PHP Composer ---
if [ -f "composer.json" ]; then
  echo "--- Обнаружен PHP проект (composer.json) ---"
  echo "Официальный Packagist: https://packagist.org"
  if command -v composer &>/dev/null; then
    composer install --no-dev
  else
    echo -e "${RED}Composer не найден. Установите с https://getcomposer.org/${NC}"
    exit 1
  fi
  echo -e "${GREEN}Готово (PHP).${NC}"
  exit 0
fi

echo -e "${YELLOW}Не обнаружены package.json, requirements.txt, pyproject.toml или composer.json.${NC}"
echo "Установите зависимости вручную по инструкции в SAFE-INSTALL-FROM-ARCHIVE.md"
exit 1
