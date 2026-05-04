# E2E (Playwright)

```bash
# один раз: браузеры
npx playwright install chromium

# на Linux без зависимостей графики (ошибка libgbm и т.п.):
# sudo apt-get install -y libgbm1 libnss3 libatk1.0-0 libxkbcommon0
# или: npx playwright install-deps
```

Запуск (поднимет `npm run dev`, если порт 3001 свободен):

```bash
npm run test:e2e
```

Уже запущен dev-сервер:

```bash
PLAYWRIGHT_SKIP_WEBSERVER=1 npm run test:e2e
```

Другой URL:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3001 npm run test:e2e
```
