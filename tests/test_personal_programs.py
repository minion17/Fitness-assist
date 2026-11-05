from conftest import new_user_headers


def test_personal_program_creation_editing_and_privacy(client, seeded):
    owner, other = new_user_headers(), new_user_headers()
    exercise = client.get('/api/exercises').json()[0]
    data = {'name': 'Моя программа', 'days': [{'name': 'День 1', 'exercises': [
        {'exercise_id': exercise['id'], 'sets': 3, 'reps': '8–12', 'rest_seconds': 60}
    ]}]}
    created = client.post('/api/programs', json=data, headers=owner)
    assert created.status_code == 200, created.text
    program = created.json()
    assert program['name'] == 'Моя программа'
    assert program['days'][0]['exercises'][0]['exercise_id'] == exercise['id']
    pid = program['id']
    assert pid in [p['id'] for p in client.get('/api/programs', headers=owner).json()]
    assert pid not in [p['id'] for p in client.get('/api/programs', headers=other).json()]
    assert pid not in [p['id'] for p in client.get('/api/programs').json()]
    assert client.put('/api/programs/' + str(pid), json=data, headers=other).status_code == 404
    assert client.put('/api/settings', json={'program_id': pid}, headers=other).status_code == 404
    data['name'] = 'Обновлённая программа'
    data['days'][0]['id'] = program['days'][0]['id']
    updated = client.put('/api/programs/' + str(pid), json=data, headers=owner)
    assert updated.status_code == 200, updated.text
    assert updated.json()['name'] == 'Обновлённая программа'
    assert updated.json()['days'][0]['id'] == program['days'][0]['id']
    assert client.put('/api/settings', json={'program_id': pid}, headers=owner).status_code == 200
    day_id = updated.json()['days'][0]['id']
    assert client.post('/api/workout-logs', json={'program_day_id': day_id}, headers=other).status_code == 404
    workout = client.post('/api/workout-logs', json={'program_day_id': day_id}, headers=owner)
    assert workout.status_code == 200
    log_id = workout.json()['id']
    logged = client.post(f'/api/workout-logs/{log_id}/sets', json={
        'exercise_id': exercise['id'], 'set_number': 1, 'reps': 10, 'weight_kg': 0,
    }, headers=owner)
    assert logged.status_code == 200
    assert client.post(f'/api/workout-logs/{log_id}/complete', headers=owner).status_code == 200


def test_custom_exercise_timed_sets_and_superset(client, seeded):
    owner, other = new_user_headers(), new_user_headers()
    created = client.post('/api/exercises', headers=owner, json={'name': 'Моя планка с гирей'})
    assert created.status_code == 200, created.text
    exercise_id = created.json()['id']
    assert exercise_id in [x['id'] for x in client.get('/api/exercises', headers=owner).json()]
    assert exercise_id not in [x['id'] for x in client.get('/api/exercises', headers=other).json()]
    item = {'exercise_id': exercise_id, 'sets': 3, 'reps': '45', 'rest_seconds': 30, 'unit': 'seconds', 'superset': 1}
    data = {'name': 'Тест суперсета', 'days': [{'name': 'День 1', 'exercises': [item, item]}]}
    assert client.post('/api/programs', headers=other, json=data).status_code == 422
    created = client.post('/api/programs', headers=owner, json=data)
    assert created.status_code == 200, created.text
    day = created.json()['days'][0]
    assert [x['superset'] for x in day['exercises']] == [1, 1]
    assert day['exercises'][0]['unit'] == 'seconds'
    log = client.post('/api/workout-logs', headers=owner, json={'program_day_id': day['id']}).json()['id']
    result = client.post(f'/api/workout-logs/{log}/sets', headers=owner, json={'exercise_id': exercise_id, 'set_number': 1, 'duration_seconds': 45, 'weight_kg': 0})
    assert result.status_code == 200, result.text
