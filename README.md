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

## Запуск на Windows (PowerShell, без Docker)

Разовая подготовка уже описана выше; PostgreSQL — из zip-архива в `C:\pgsql`, база `fitness`, вход без пароля (`DATABASE_URL=postgresql+asyncpg://postgres@localhost:5432/fitness`).

Каждый раз после перезагрузки компьютера — 4 окна PowerShell:

```powershell
# 1. База
C:\pgsql\bin\pg_ctl.exe -D C:\pgsql\data -l C:\pgsql\log.txt start

# 2. Сервер (окно не закрывать)
cd $HOME\Fitness-assist
.venv\Scripts\python -m uvicorn backend.api.main:app --port 8000

# 3. Туннель (окно не закрывать) → скопировать https://….lhr.life в WEBAPP_URL в .env
ssh -R 80:localhost:8000 nokey@localhost.run

# 4. Бот (окно не закрывать; запускать после правки WEBAPP_URL)
cd $HOME\Fitness-assist
.venv\Scripts\python -m backend.bot.main
```

Cloudflare-туннель в этой сети не работает (заблокирован порт 7844), поэтому localhost.run. Запасной вариант: `ssh -p 443 -R0:localhost:8000 a.pinggy.io`.

Если изменился код интерфейса: `cd frontend; npm.cmd run build; cd ..` и перезапустить сервер.

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

## Геймификация (заготовка)

- `users.xp`, `users.level` — общий опыт и уровень.
- `backend/core/gamification.py` — правила наград (`RULES`: событие → XP) и расчёт уровня: до 2-го уровня 100 XP, каждый следующий шаг +50.
- `backend/database/rewards.py` — `award_xp(session, user_id, event_type, event_key)`. Таблица `xp_events` с уникальным ключом `(user_id, event_key)` не даёт начислить XP дважды за одно событие, даже при повторах и параллельных запросах. `event_key` — идентификатор источника, например `meal:123`.
- `/api/auth` возвращает `progress`, профиль показывает уровень и прогресс-бар.

Начисление пока нигде не вызывается — подключим после сохранения питания и тренировок.

## Дальше

Анкета пользователя → дневник питания → тренировочные программы → AI-интеграции.
