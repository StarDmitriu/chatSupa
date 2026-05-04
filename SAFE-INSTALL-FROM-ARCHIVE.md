# Безопасная установка зависимостей из архива

**Правило:** все библиотеки — только из **официальных** источников. Никаких сторонних репозиториев и зеркал без проверки.

---

## Официальные источники (только они)

| Экосистема | Официальный реестр / сайт | Установка |
|------------|---------------------------|-----------|
| **Node.js / npm** | https://registry.npmjs.org (официальный реестр npm) | `npm install` в каталоге с `package.json` |
| **Python (pip)** | https://pypi.org (официальный PyPI) | `pip install -r requirements.txt` |
| **PHP (Composer)** | https://packagist.org (официальный Packagist) | `composer install` в каталоге с `composer.json` |
| **Ruby (Bundler)** | https://rubygems.org | `bundle install` |
| **Системные пакеты (Ubuntu/Debian)** | репозитории Ubuntu (archive.ubuntu.com и т.д.) | `apt install` после `apt update` |

---

## Порядок действий после получения архива

### 1. Распаковать архив в отдельную папку

```bash
mkdir -p /var/www/incoming
# когда архив пришлют:
# tar -xvf архив.tar.gz -C /var/www/incoming/
# или unzip архив.zip -d /var/www/incoming/
```

### 2. Определить тип проекта

- Есть **package.json** → Node.js / npm
- Есть **requirements.txt** или **pyproject.toml** → Python
- Есть **composer.json** → PHP (Composer)

### 3. Проверить, что используются только официальные реестры

- **npm:** реестр должен быть `https://registry.npmjs.org/` (проверка: `npm config get registry`)
- **pip:** по умолчанию использует PyPI (https://pypi.org). Не добавлять `--index-url` со сторонних сайтов.
- **composer:** по умолчанию Packagist. В `composer.json` не должно быть подозрительных `repositories`.

### 4. Установить зависимости только официальными командами

Команды ниже используют **только** официальные реестры по умолчанию.

---

## Node.js / npm

**Официальный сайт Node:** https://nodejs.org/  
**Официальный реестр npm:** https://registry.npmjs.org/

```bash
cd /путь/к/распакованному/проекту

# Проверить реестр (должно быть registry.npmjs.org)
npm config get registry

# Если не так — задать официальный:
npm config set registry https://registry.npmjs.org/

# Установить зависимости (скачивание только с registry.npmjs.org)
npm install

# Для Next.js — сразу обновить до безопасной версии:
npx fix-react2shell-next
```

Не использовать: `npm install --registry <другой_url>`, если URL не официальный.

---

## Python (pip)

**Официальный индекс:** https://pypi.org/

```bash
cd /путь/к/распакованному/проекту

# Установить из requirements.txt (пакеты только с PyPI)
pip install --requirement requirements.txt

# или с виртуальным окружением (рекомендуется):
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Не использовать: `pip install --index-url` или `--extra-index-url` с неизвестных доменов.

---

## PHP (Composer)

**Официальный Packagist:** https://packagist.org

```bash
cd /путь/к/распакованному/проекту

composer install --no-dev
```

Проверить в `composer.json` секцию `repositories` — не должно быть сторонних URL без доверия.

---

## Системные пакеты (Ubuntu/Debian)

Только из репозиториев дистрибутива (после `apt update`):

```bash
sudo apt update
sudo apt install -y пакет1 пакет2 ...
```

Не добавлять сторонние PPA и репозитории без проверки.

---

## Автоматическая проверка и установка

После распаковки архива можно запустить скрипт:

```bash
sudo /var/www/safe-install-deps.sh /путь/к/распакованному/проекту
```

Скрипт определит тип проекта, проверит реестр (npm) и предложит/выполнит только официальные команды установки.

---

*Используйте только официальные источники — так вы избегаете подмены пакетов и вредоносного кода.*
