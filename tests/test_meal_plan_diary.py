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
