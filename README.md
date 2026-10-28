# Fitness Assistant

Telegram-бот с Mini App для дневника питания, тренировок и отслеживания прогресса.

**Этап 1 — технический фундамент:** бот с `/start` и кнопкой запуска Mini App, интерфейс из 4 разделов на демо-данных, FastAPI + PostgreSQL, проверка подписи Telegram initData, `/health`.

## Стек

- Backend: Python 3.11+, FastAPI, aiogram 3, SQLAlchemy 2 (async) + PostgreSQL
- Frontend: React, TypeScript, Vite

## Структура

```
backend/
  api/       FastAPI: /health, /api/auth; раздаёт собранный Mini App
  bot/       aiogram-бот: /start, кнопка Mini App, обработка ошибок
  core/      настройки (.env), проверка Telegram initData
  database/  подключение к PostgreSQL, модель User
frontend/    Mini App (React + TS + Vite)
content/     products / exercises / programs — данные со второго компьютера
docs/
tests/       тесты backend (pytest)
```

## Запуск локально

Нужны: Python 3.11+, Node.js 20+, Docker (или свой PostgreSQL).

```bash
cp .env.example .env            # впишите BOT_TOKEN и WEBAPP_URL

docker compose up -d db         # PostgreSQL

python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt

cd frontend && npm install && npm run build && cd ..

uvicorn backend.api.main:app --port 8000     # API + Mini App на http://localhost:8000
python -m backend.bot.main                   # бот (во втором терминале)
```

Telegram открывает Mini App только по HTTPS. Самый простой вариант — туннель:

```bash
cloudflared tunnel --url http://localhost:8000
```

Полученный `https://….trycloudflare.com` впишите в `WEBAPP_URL` и перезапустите бота. Адрес меняется при каждом запуске туннеля — для постоянного адреса нужен свой домен или хостинг.

Разработка интерфейса с горячей перезагрузкой: `cd frontend && npm run dev` (порт 5173, `/api` проксируется на 8000).

## Тесты

```bash
createdb fitness_test   # или: docker compose exec db createdb -U fitness fitness_test
DATABASE_URL=postgresql+asyncpg://fitness:fitness@localhost:5432/fitness_test pytest tests
cd frontend && npm test
```

## API

| Метод | Путь | Описание |
|---|---|---|
| GET | `/health` | Статус сервиса и БД |
| POST | `/api/auth` | Заголовок `Authorization: tma <initData>`. Проверяет подпись, создаёт/обновляет пользователя |

## Дальше

Анкета пользователя → дневник питания → тренировочные программы → AI-интеграции.
