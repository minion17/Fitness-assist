from conftest import new_user_headers


def saved(client, headers):
    r = client.get('/api/meal-plan', headers=headers).json()
    return r and {k: r[k] for k in ('input', 'plan')}


def test_saved_plan_is_private_and_requires_consent(client):
    first, second = new_user_headers(), new_user_headers()
    body = {'input': {'days': 1, 'calories': 2000, 'allergies': '', 'liked': '', 'disliked': ''},
            'plan': {'days': [], 'shopping': [], 'warnings': [], 'persons': 1, 'sharedMeals': [], 'basketCostRub': None, 'portionCostRub': None, 'budgetRub': None}}
    assert client.get('/api/meal-plan', headers=first).json() is None
    assert client.put('/api/meal-plan', headers=first, json=body).status_code == 403
    client.post('/api/consent', headers=first, json={'health': False})
    assert client.put('/api/meal-plan', headers=first, json=body).json() == body
    assert saved(client, first) == body
    assert client.get('/api/meal-plan', headers=second).json() is None
    with_allergy = {**body, 'input': {**body['input'], 'allergies': 'орехи'}}
    assert client.put('/api/meal-plan', headers=first, json=with_allergy).status_code == 403
    assert saved(client, first) == body
    client.post('/api/consent', headers=first, json={'health': True})
    assert client.put('/api/meal-plan', headers=first, json=with_allergy).status_code == 200
    client.post('/api/consent', headers=first, json={'health': False})
    assert client.get('/api/meal-plan', headers=first).json() is None


def test_saved_plan_rejects_invalid_and_oversized_payload_atomically(client):
    headers = new_user_headers()
    client.post('/api/consent', headers=headers, json={'health': True})
    body = {'input': {'days': 1, 'calories': 2000, 'allergies': '', 'liked': '', 'disliked': ''},
            'plan': {'days': [], 'shopping': [], 'warnings': [], 'persons': 1, 'sharedMeals': [], 'basketCostRub': None, 'portionCostRub': None, 'budgetRub': None}}
    assert client.put('/api/meal-plan', headers=headers, json=body).status_code == 200
    assert client.put('/api/meal-plan', headers=headers, json={'input': [], 'plan': {}}).status_code == 422
    assert client.put('/api/meal-plan', headers=headers, json={**body, 'plan': {**body['plan'], 'days': 'invalid'}}).status_code == 422
    assert client.put('/api/meal-plan', headers=headers, json={**body, 'plan': {**body['plan'], 'warnings': ['x' * 300000]}}).status_code == 422
    assert saved(client, headers) == body
