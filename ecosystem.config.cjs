/**
 * PM2: запуск бэкенда и фронтенда
 *
 * Подробно: см. DEPLOY_PM2.md (Redis, nginx для PM2, переменные окружения).
 *
 * Установка: npm install -g pm2
 * Сборка:    cd backend && npm run build && cd ../frontend && npm run build
 * Старт:     из корня проекта: pm2 start ecosystem.config.cjs
 * Статус:    pm2 status
 * Логи:      pm2 logs
 * Стоп:      pm2 stop all
 * Рестарт:   pm2 restart all
 *
 * Перед первым стартом: backend/.env (в т.ч. REDIS_HOST=127.0.0.1 при PM2 без Docker).
 */

module.exports = {
  apps: [
    {
      name: 'backend',
      cwd: './backend',
      script: 'node',
      args: 'dist/main.js',
      instances: 1,
      autorestart: true,
      watch: false,
      // Nest + Baileys + GramJS + Bull при активной рассылке часто >500MiB RSS — иначе PM2 убивает процесс «тихим» рестартом.
      max_memory_restart: '1024M',
      // Даём воркеру завершить in-flight задачи и закрыть очередь без stale_processing.
      kill_timeout: 65000,
      env: { NODE_ENV: 'production', PORT: '3000', BIND_HOST: '127.0.0.1' },
    },
    {
      name: 'frontend',
      cwd: './frontend',
      script: 'node',
      args: '.next/standalone/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        HOSTNAME: '127.0.0.1',
        PORT: '3001',
        // Фиксированный ключ шифрования Server Actions — убирает ошибку
        // "Failed to find Server Action" после деплоя (старый кэш браузера vs новый билд).
        // Можно переопределить через: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=... pm2 restart frontend
        NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:
          process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY ||
          'fcT08DDZBnFoG6WCUV6bE37LCCw4YbsOymHXBsHZE4o=',
      },
    },
  ],
};
