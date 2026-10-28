# Как отправлять изменения в Fitness Assistant

Главная ветка — `main`: с неё запускается бот. Напрямую в неё не пишем.
Любое изменение идёт через **Pull Request (PR)**: GitHub сам прогоняет тесты, затем изменения проверяются и вливаются.

## 0. Один раз: доступ

1. Заведите аккаунт на https://github.com (если его нет) и сообщите логин владельцу репозитория.
2. Владелец: https://github.com/minion17/Fitness-assist/settings/access → **Add people** → логин → права **Write**.
3. Примите приглашение — придёт письмо или уведомление на https://github.com/notifications.

## Способ А. Данные (продукты, упражнения, программы) — прямо в браузере

Подходит для JSON-файлов в `content/`. Ничего устанавливать не нужно.

1. Откройте нужную папку, например https://github.com/minion17/Fitness-assist/tree/main/content/products
2. **Add file → Upload files**, перетащите файл (например `products.json`).
   Чтобы изменить уже существующий файл: откройте его → значок карандаша ✏️ → правка.
3. Внизу в **Commit changes**:
   - коротко опишите, что сделали: «Добавил 120 продуктов»;
   - выберите **Create a new branch for this commit and start a pull request**;
   - нажмите **Propose changes**, затем **Create pull request**.
4. Подождите 1–2 минуты: внизу PR появятся проверки (**Checks**).
   - Зелёная галочка ✅ — всё хорошо, сообщите владельцу.
   - Красный крестик ❌ — нажмите **Details**: там написано, что не так (например, упражнение из программы не найдено в `exercises.json`). Исправьте файл в той же ветке — проверки запустятся снова.

## Способ Б. Код — через GitHub Desktop (без командной строки)

1. Установите https://desktop.github.com и войдите в свой GitHub-аккаунт.
2. **File → Clone repository** → `minion17/Fitness-assist` → Clone.
3. Перед работой: **Fetch origin**, затем **Pull** — чтобы взять свежую версию.
4. **Current branch → New branch** → имя по смыслу (`products-list`, `fix-search`).
5. Меняйте файлы в любом редакторе. Слева в GitHub Desktop появится список изменений.
6. Внизу слева: короткое описание → **Commit to …** → **Publish branch**.
7. **Create Pull Request** → на сайте **Create pull request**. Дальше — как в шаге 4 способа А.

<details>
<summary>То же самое в командной строке</summary>

```bash
git checkout main && git pull
git checkout -b имя-задачи
# ...изменения...
git add -A
git commit -m "Что сделано"
git push -u origin имя-задачи
# затем откройте ссылку на PR, которую выведет git push
```
</details>

## Форматы данных (`content/`)

Достаточно изменить JSON: при следующем запуске `start.bat` новые записи сами попадут в базу. Записи, которые уже есть (по названию), не дублируются.

**`content/products/products.json`** — список продуктов, значения **на 100 г**:

```json
[
  {"name": "Творог 5%", "brand": "Простоквашино", "category": "Молочные продукты",
   "kcal": 121, "protein_g": 17.2, "fat_g": 5, "carbs_g": 1.8, "barcode": "4607053474426"},
  {"name": "Гречка отварная", "category": "Крупы", "kcal": 110, "protein_g": 4.2, "fat_g": 1.1, "carbs_g": 21.3}
]
```
Обязательные поля: `name`, `kcal`. Остальные — по возможности; `brand` и `barcode` можно не указывать.

**`content/exercises/exercises.json`** — `name`, `muscle_groups[]`, `equipment[]`, `difficulty` (`beginner` / `intermediate` / `advanced`), `description`, `is_bodyweight`.

**`content/programs/programs.json`** — `name`, `goal`, `level`, `days_per_week`, `description`, `days[]`: `day_name`, `day_order`, `exercises[]`: `name`, `sets`, `reps`, `rest_seconds`, `notes`.
Название упражнения в программе должно **точно** совпадать с названием в `exercises.json`.

## Правила для кода

- Модели — `backend/database/models.py`, API — `backend/api/main.py`. Не дописывать код в файлы скриптами-установщиками.
- XP начислять только через `award_xp(...)` с событием из `RULES` в `backend/core/gamification.py`.
- Новая логика — с тестом в `tests/` (бэкенд) или рядом с компонентом (`*.test.tsx`). Тесты запускаются автоматически в каждом PR.
