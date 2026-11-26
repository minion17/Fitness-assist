from conftest import PROFILE, new_user_headers


def test_plan_meal_confirmation_is_idempotent_and_reversible(client):
    headers = new_user_headers()
    client.post('/api/consent', headers=headers, json={'health': False})
    meal = {'id': 'test', 'name': 'Тестовый обед', 'meal': 'lunch', 'ingredients': [{'grams': 200}], 'nutrition': {'kcal': 300, 'protein_g': 25, 'fat_g': 10, 'carbs_g': 30}}
    body = {'input': {'allergies': ''}, 'plan': {'days': [{'day': 1, 'meals': [meal]}], 'shopping': [], 'warnings': []}}
    assert client.put('/api/meal-plan', headers=headers, json=body).status_code == 200
    assert client.get('/api/meal-plan/today', headers=headers).json()['meals'][0]['completed'] is False
    for _ in range(2):
        assert client.put('/api/meal-plan/today/0', headers=headers, json={'completed': True}).status_code == 200
    diary = client.get('/api/food-logs', headers=headers).json()
    assert len(diary['items']) == 1
    assert diary['totals']['kcal'] == 300
    assert diary['items'][0]['meal_type'] == 'lunch'
    assert client.get('/api/meal-plan/today', headers=headers).json()['meals'][0]['completed'] is True
    assert client.put('/api/meal-plan/today/0', headers=headers, json={'completed': False}).status_code == 200
    assert client.get('/api/food-logs', headers=headers).json()['items'] == []
    assert client.get('/api/meal-plan/today', headers=headers).json()['meals'][0]['completed'] is False


def test_family_plan_tells_about_the_shared_shopping_list_once(client):
    from sqlalchemy import func, select

    from backend.database.db import SessionLocal
    from backend.database.models import Outbox

    headers = new_user_headers()
    client.post('/api/consent', headers=headers, json={'health': False})
    plan = {'days': [], 'shopping': [{'product': 'Гречка', 'grams': 500}], 'warnings': []}

    async def tips():
        async with SessionLocal() as s:
            return await s.scalar(select(func.count()).where(Outbox.kind == 'shoptip'))
    before = client.portal.call(tips)
    client.put('/api/meal-plan', headers=headers, json={'input': {'allergies': '', 'persons': 1}, 'plan': plan})
    assert client.portal.call(tips) == before  # for one: no family chat to share with
    for _ in range(2):
        client.put('/api/meal-plan', headers=headers, json={'input': {'allergies': '', 'persons': 3}, 'plan': plan})
    assert client.portal.call(tips) == before + 1  # a family plan: told once


def test_plan_snack_goes_to_the_diary_and_the_bot_reminds_before_the_plan_ends(client):
    from datetime import datetime, timedelta

    from backend.bot.reminders import collect
    from backend.database.db import SessionLocal

    headers = new_user_headers()
    client.post('/api/consent', headers=headers, json={'health': False})
    assert client.put('/api/profile', headers=headers, json=PROFILE).status_code == 200
    snack = {'id': 'kefir-banana', 'name': 'Кефир с бананом', 'meal': 'snack', 'ingredients': [{'grams': 420}], 'nutrition': {'kcal': 280, 'protein_g': 9, 'fat_g': 8, 'carbs_g': 40}}
    plan = {'days': [{'day': 1, 'meals': [snack]}, {'day': 2, 'meals': [snack]}], 'shopping': [], 'warnings': []}
    assert client.put('/api/meal-plan', headers=headers, json={'input': {'allergies': ''}, 'plan': plan}).status_code == 200
    assert client.put('/api/meal-plan/today/0', headers=headers, json={'completed': True}).status_code == 200
    item = client.get('/api/food-logs', headers=headers).json()['items'][0]
    assert item['meal_type'] == 'snack' and item['snack_slot'] == '16:00'

    me = client.post('/api/auth', headers=headers).json()
    evening = datetime.now().astimezone().replace(hour=18, minute=31, second=0, microsecond=0)

    async def run(at):
        async with SessionLocal() as s:
            return [(t, b) for c, t, _, b in await collect(s, at) if c == me['telegram_id']]
    sent = client.portal.call(run, evening)  # today is day 1 of 2: tomorrow is the last
    ending = [x for x in sent if 'последний день рациона' in x[0]]
    assert ending and ending[0][1] == [('Составить следующий рацион', 'app:open=renew')]
    assert not [x for x in client.portal.call(run, evening + timedelta(minutes=5)) if 'последний день рациона' in x[0]]  # once
