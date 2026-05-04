# ✅ Чеклист развертывания в продакшене

## Выполненные изменения

### 1. ✅ Оптимизация производительности
- [x] Кэширование количества групп (TTL 30 секунд)
- [x] Оптимизация SELECT запросов (конкретные поля вместо *)
- [x] Улучшенное логирование производительности
- [x] SQL миграция для индексов (`add_groups_indexes.sql`)

### 2. ✅ Плавная анимация счетчика загрузки
- [x] Анимированный счетчик групп на всех страницах
- [x] Плавное увеличение счетчика при загрузке
- [x] Синхронизация с реальной загрузкой групп

### 3. ✅ Улучшенный UI выбора групп
- [x] Клик по всей строке для выбора группы
- [x] Улучшенная кастомная галочка с анимацией
- [x] Выделение строки при выборе
- [x] Плавные анимации переходов

### 4. ✅ Исправление дубликатов
- [x] Улучшенное логирование дубликатов
- [x] SQL скрипт для удаления дубликатов (`fix_duplicate_groups.sql`)
- [x] Тестовый скрипт для проверки (`test_duplicates.js`)

## Статус сервисов

- ✅ Backend: пересобран и перезапущен
- ✅ Frontend: пересобран и перезапущен
- ✅ PM2: оба сервиса online

## Требуется выполнить вручную

### Деплой frontend (Next.js standalone, чанки + PM2)

Полный выкат: перед сборкой удаляется `frontend/.next`, затем сборка (postbuild → `.next/standalone`) и `pm2 restart`:

```bash
cd /var/www && ./scripts/deploy-frontend-vps.sh
```

Документация: [`docs/FRONTEND-CHUNKS-DEPLOY.md`](docs/FRONTEND-CHUNKS-DEPLOY.md). Пример nginx: `deploy/nginx-frontend-next.example.conf`.

### ⚠️ КРИТИЧНО: Выполнить SQL миграции

1. **Исправление дубликатов:**
   ```bash
   # Откройте Supabase Dashboard → SQL Editor
   # Скопируйте и выполните:
   cat /var/www/backend/migrations/fix_duplicate_groups.sql
   ```

2. **Создание индексов для производительности:**
   ```bash
   # Откройте Supabase Dashboard → SQL Editor
   # Скопируйте и выполните:
   cat /var/www/backend/migrations/add_groups_indexes.sql
   ```

## Тестирование

### Проверка дубликатов:
```bash
cd /var/www/backend
node migrations/test_duplicates.js
```

### Проверка логов:
```bash
# Проверка логов бэкенда на дубликаты
pm2 logs backend --lines 50 | grep -i "дубликат\|duplicate"

# Проверка производительности
pm2 logs backend --lines 100 | grep -i "getGroupsFromDb\|SLOW QUERY"
```

### Проверка работы сервисов:
```bash
# Backend
curl http://localhost:3000/api/auth/me

# Frontend
curl http://localhost:3001/
```

## Файлы миграций

- `/var/www/backend/migrations/fix_duplicate_groups.sql` - исправление дубликатов
- `/var/www/backend/migrations/add_groups_indexes.sql` - создание индексов
- `/var/www/backend/migrations/test_duplicates.js` - тест дубликатов
- `/var/www/backend/migrations/EXECUTE_INSTRUCTIONS.md` - инструкции

## Следующие шаги

1. ✅ Выполнить SQL скрипты в Supabase Dashboard
2. ✅ Проверить работу через тестовый скрипт
3. ✅ Протестировать UI на страницах групп
4. ✅ Проверить логи на наличие предупреждений
