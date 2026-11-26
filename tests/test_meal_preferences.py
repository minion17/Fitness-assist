from conftest import new_user_headers


def test_preferences_are_private_and_health_consent_is_respected(client):
    first, second = new_user_headers(), new_user_headers()
    body = {"days": 7, "goal": "maintenance", "allergies": "орехи", "liked": "гречка", "disliked": "грибы", "budget": 5000, "current_spend": None}
    assert client.put('/api/meal-preferences', headers=first, json=body).status_code == 403
    client.post('/api/consent', headers=first, json={"health": False})
    assert client.put('/api/meal-preferences', headers=first, json=body).status_code == 403
    client.post('/api/consent', headers=first, json={"health": True})
    assert client.put('/api/meal-preferences', headers=first, json=body).status_code == 200
    assert client.get('/api/meal-preferences', headers=first).json()['allergies'] == 'орехи'
    client.post('/api/consent', headers=second, json={"health": True})
    assert client.get('/api/meal-preferences', headers=second).json() is None
    client.post('/api/consent', headers=first, json={"health": False})
    assert client.get('/api/meal-preferences', headers=first).json()['allergies'] == ''


def test_questionnaire_preferences_round_trip_and_old_client_update(client):
    headers = new_user_headers()
    client.post('/api/consent', headers=headers, json={'health': False})
    body = {'days': 7, 'goal': 'maintenance', 'persons': 3,
            'selected_meals': ['breakfast', 'dinner'], 'shared_meals': ['dinner'],
            'dietary_type': 'vegetarian', 'liked_recipe_ids': ['recipe-1'],
            'disliked_recipe_ids': ['recipe-2'], 'sex': 'female'}
    assert client.put('/api/meal-preferences', headers=headers, json=body).status_code == 200
    saved = client.get('/api/meal-preferences', headers=headers).json()
    for key in ('persons', 'selected_meals', 'shared_meals', 'dietary_type', 'liked_recipe_ids', 'disliked_recipe_ids', 'sex'):
        assert saved[key] == body[key]
    assert client.put('/api/meal-preferences', headers=headers, json={'days': 3, 'goal': 'maintenance'}).status_code == 200
    assert client.get('/api/meal-preferences', headers=headers).json()['persons'] == 3


def test_questionnaire_preferences_reject_invalid_combinations(client):
    headers = new_user_headers()
    client.post('/api/consent', headers=headers, json={'health': False})
    base = {'days': 7, 'goal': 'maintenance'}
    for invalid in ({'persons': 0}, {'persons': 11}, {'persons': 1.5},
                    {'selected_meals': ['snack']}, {'dietary_type': 'other'},
                    {'sex': 'other'}, {'selected_meals': ['breakfast'], 'shared_meals': ['dinner']}):
        assert client.put('/api/meal-preferences', headers=headers, json={**base, **invalid}).status_code == 422


def test_cooking_mode_defaults_round_trips_and_survives_old_client(client):
    headers = new_user_headers()
    client.post('/api/consent', headers=headers, json={'health': False})
    base = {'days': 7, 'goal': 'maintenance'}
    assert client.put('/api/meal-preferences', headers=headers, json=base).json()['cooking_mode'] == 'daily'
    for mode in ('daily', 'batch', 'varied'):
        assert client.put('/api/meal-preferences', headers=headers, json={**base, 'cooking_mode': mode}).json()['cooking_mode'] == mode
        assert client.get('/api/meal-preferences', headers=headers).json()['cooking_mode'] == mode
    assert client.put('/api/meal-preferences', headers=headers, json=base).json()['cooking_mode'] == 'varied'
    assert client.put('/api/meal-preferences', headers=headers, json={**base, 'cooking_mode': 'invalid'}).status_code == 422


def test_batch_days_defaults_round_trips_and_survives_old_client(client):
    headers = new_user_headers()
    client.post('/api/consent', headers=headers, json={'health': False})
    base = {'days': 7, 'goal': 'maintenance'}
    assert client.put('/api/meal-preferences', headers=headers, json=base).json()['batch_days'] == 2
    for days in (2, 7):
        assert client.put('/api/meal-preferences', headers=headers, json={**base, 'batch_days': days}).json()['batch_days'] == days
        assert client.get('/api/meal-preferences', headers=headers).json()['batch_days'] == days
    assert client.put('/api/meal-preferences', headers=headers, json=base).json()['batch_days'] == 7
    assert client.put('/api/meal-preferences', headers=headers, json={**base, 'batch_days': 3}).status_code == 422


def test_quick_dishes_round_trip_and_survive_old_client(client):
    headers = new_user_headers()
    client.post('/api/consent', headers=headers, json={'health': False})
    base = {'days': 7, 'goal': 'maintenance'}
    assert client.put('/api/meal-preferences', headers=headers, json=base).json()['quick'] is False
    assert client.put('/api/meal-preferences', headers=headers, json={**base, 'quick': True}).json()['quick'] is True
    assert client.get('/api/meal-preferences', headers=headers).json()['quick'] is True
    assert client.put('/api/meal-preferences', headers=headers, json=base).json()['quick'] is True  # an old app doesn't reset it
