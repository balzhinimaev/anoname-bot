# ANONAMEBOT

Telegram бот с автоматическим CI/CD деплоем на VPS.

Минимальный, продакшен-готовый телеграм-бот на TypeScript с Telegraf, работает только через webhook (без long polling). Включает Express, dotenv, healthcheck и graceful shutdown.

## Быстрый старт

1. Установка зависимостей:

```bash
npm i
```

2. Создайте `.env` по примеру `.env.example` и заполните значения:

```env
BOT_TOKEN=123:ABC
BOT_WEBHOOK_URL=https://your-domain.com
TELEGRAM_WEBHOOK_PATH=/telegram/webhook/your-random-secret-path
TELEGRAM_WEBHOOK_SECRET=your-strong-secret
WEB_APP_URL=https://your-mini-app-url
PORT=7777
AUTO_SET_WEBHOOK=true
API_BASE_URL=https://anoname.ru
BOT_BACKEND_SECRET=your-backend-secret
AB_SPLIT_A=50
ENABLE_ANALYTICS=true
ENABLE_LEAD_TRACKING=true
PRELAUNCH_STATS_PATH=/api/telegram/prelaunch/stats
LEADS_ADD_PATH=/api/leads/add
LEADS_TMA_OPEN_PATH=/api/leads/tma-open
```

3. Локальный запуск (dev):

```bash
npm run dev
```

Сервер поднимется на `http://localhost:7777`. Для prod:

```bash
npm run build && npm start
```

## Webhook

- При `AUTO_SET_WEBHOOK=true` вебхук установится автоматически, если заполнены переменные: `BOT_TOKEN`, `BOT_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_PATH`, `TELEGRAM_WEBHOOK_SECRET`.
- Если переменных не хватает — в лог выводится готовая команда `curl`.

Пример ручной установки (замените токен и URL):

```bash
curl -sS -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-domain.com/telegram/webhook/your-random-secret-path",
    "secret_token": "your-strong-secret",
    "drop_pending_updates": true,
    "allowed_updates": ["message","callback_query","chat_member","chat_join_request"]
  }'
```

## Проверка

- Healthcheck: `GET /healthz` → `{"status":"ok"}`
- Команда `/start` отправляет приветствие и кнопку открытия Mini App (если указан `WEB_APP_URL`).
- Команда `/help` показывает краткую справку.
- Аналитика: при `/start` отправляется событие `bot_start_shown` с A/B вариантом и payload.
- Лиды: при `/start` бот вызывает `/api/leads/add`, а при наличии payload формата `lead_*` дополнительно вызывает `/api/leads/tma-open`.

## Монетизация: Telegram Stars

- Эндпоинт создания инвойса (защищён `BOT_BACKEND_SECRET`):

```http
POST /monetization/stars/invoice
X-API-Key: <BOT_BACKEND_SECRET>
Content-Type: application/json

{ "itemKey": "premium", "starCount": 100 }
```

Ответ:

```json
{ "url": "https://t.me/.../invoice?..." }
```

- Бот обрабатывает `pre_checkout_query` и события успешной оплаты. В payload инвойса передаются поля `{ itemKey, starCount }`. После успешной оплаты отправляется уведомление в ваш бэкенд `POST {API_BASE_URL}/api/monetization/stars/success` с заголовком `X-API-Key: BOT_BACKEND_SECRET`.

## BotFather (опционально)

- Чтобы кнопка Mini App была в меню чата, в BotFather настройте: Menu Button → Web App → укажите тот же `WEB_APP_URL`.


## Интеграция с anoname2

По умолчанию бот ожидает backend на `API_BASE_URL` и вызывает:
- `GET /api/telegram/prelaunch/stats`
- `POST /api/analytics/bot-event`
- `POST /api/monetization/stars/success`
- `POST /api/leads/add`
- `POST /api/leads/tma-open`

Для всех защищённых endpoint используется `BOT_BACKEND_SECRET` (`X-API-Key` и `X-Bot-Secret`).

## 🚀 CI/CD Деплой

### Автоматический деплой на VPS

При пуше в `master` (и `main`) ветку автоматически:
1. Собирается Docker образ и пушится в GitHub Container Registry (GHCR)
2. Подключается к VPS по SSH
3. Создаётся папка `/opt/mvp-anoname-bot`
4. Записывается `.env` файл из GitHub Secrets
5. Скачивается и запускается Docker контейнер из GHCR

### Настройка GitHub Secrets

Настройте секреты в GitHub Settings → Secrets and variables → Actions:

**VPS подключение (ОБЯЗАТЕЛЬНО):**
- `VPS_HOST` - IP/домен VPS
- `VPS_USER` - пользователь SSH  
- `VPS_SSH_KEY` - приватный SSH ключ

**Переменные бота (ОБЯЗАТЕЛЬНО):**
- `BOT_TOKEN` - токен Telegram бота
- `TELEGRAM_WEBHOOK_PATH` - путь webhook
- `TELEGRAM_WEBHOOK_SECRET` - секрет webhook
- `BOT_WEBHOOK_URL` - полный URL webhook
- `AUTO_SET_WEBHOOK` - автоустановка webhook

**Опциональные переменные:**
- `WEB_APP_URL` - URL мини-приложения
- `API_BASE_URL` - URL API бэкенда
- `BOT_BACKEND_SECRET` - секрет для API
- `AB_SPLIT_A` - процент A/B тестов
- `ENABLE_ANALYTICS` - включить/выключить отправку bot analytics
- `ENABLE_LEAD_TRACKING` - включить/выключить интеграцию `/api/leads/*`
- `PRELAUNCH_STATS_PATH` - путь stats endpoint (по умолчанию `/api/telegram/prelaunch/stats`)
- `LEADS_ADD_PATH` - путь добавления лида (по умолчанию `/api/leads/add`)
- `LEADS_TMA_OPEN_PATH` - путь фиксации открытия TMA (по умолчанию `/api/leads/tma-open`)
- `APP_PORT` - порт приложения (по умолчанию 7777)

### Мониторинг

```bash
# Health check
curl http://localhost:7777/healthz

# Логи контейнера
docker-compose logs -f anonamebot

# Комплексная проверка
./scripts/health-check.sh
```

## Примечания

- Никакого polling, не используем `bot.launch()` — только `bot.webhookCallback()` в Express.
- Вебхук проверяет заголовок `X-Telegram-Bot-Api-Secret-Token` и сравнивает с `TELEGRAM_WEBHOOK_SECRET`.
- Лимит `express.json()` установлен на 256kb.
- Грейсфул-шатдаун: корректно закрывает HTTP сервер по SIGINT/SIGTERM.


