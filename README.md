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

**Запуск — двойной щелчок по `start.bat`** в папке проекта. Он сам поднимает базу, сервер, туннель (с автопереподключением; новый адрес пишется в `.env`) и бота — каждый в своём окне (`FA сервер`, `FA туннель`, `FA бот`). Уже запущенное повторно не стартует. Через ~10 секунд отправьте боту `/start`.

**Обновление — двойной щелчок по `update.bat`**: `git pull`, зависимости Python и npm, сборка интерфейса. После обновления закройте окна FA и снова запустите `start.bat`.

Остановить — закрыть окна FA. Удобно вынести ярлык `start.bat` на рабочий стол (ПКМ → Отправить → Рабочий стол).

Cloudflare-туннель в этой сети не работает (заблокирован порт 7844), поэтому localhost.run. Запасной вариант: `ssh -p 443 -R0:localhost:8000 a.pinggy.io`.


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
| POST | `/api/auth` | Заголовок `Authorization: tma <initData>`. Проверяет подпись, создаёт/обновляет пользователя, возвращает уровень и анкету |
| GET | `/api/profile` | Анкета пользователя и дневная норма КБЖУ (`null`, если не заполнена) |
| PUT | `/api/profile` | Сохранить анкету: `sex`, `birth_year`, `height_cm`, `weight_kg`, `activity`, `goal`. Неверные значения → 422 |

## Анкета

При первом входе из Telegram Mini App показывает анкету: пол, год рождения, рост, вес, цель, уровень активности. Ответы хранятся в таблице `profiles`. По ним `backend/core/nutrition.py` считает дневную норму (формула Миффлина — Сан Жеора × коэффициент активности; −15 % при снижении веса, +10 % при наборе; белок 1,6–2 г/кг, жиры 0,9 г/кг, остальное — углеводы). Норма подставляется в карточки КБЖУ; съеденное пока демо — появится вместе с дневником питания.

## Геймификация (заготовка)

- `users.xp`, `users.level` — общий опыт и уровень.
- `backend/core/gamification.py` — правила наград (`RULES`: событие → XP) и расчёт уровня: до 2-го уровня 100 XP, каждый следующий шаг +50.
- `backend/database/rewards.py` — `award_xp(session, user_id, event_type, event_key)`. Таблица `xp_events` с уникальным ключом `(user_id, event_key)` не даёт начислить XP дважды за одно событие, даже при повторах и параллельных запросах. `event_key` — идентификатор источника, например `meal:123`.
- `/api/auth` возвращает `progress`, профиль показывает уровень и прогресс-бар.

Начисление пока нигде не вызывается — подключим после сохранения питания и тренировок.

## Дальше

Дневник питания → тренировочные программы → AI-интеграции.
