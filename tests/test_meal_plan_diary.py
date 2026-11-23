from conftest import new_user_headers


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
