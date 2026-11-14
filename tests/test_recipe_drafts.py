import json
from pathlib import Path


def test_drafts_reference_existing_products_and_are_not_marked_safe():
    root = Path(__file__).resolve().parents[1] / 'content'
    products = {p['name'] for p in json.loads((root / 'products/basics_ru.json').read_text())}
    data = json.loads((root / 'recipes/drafts.json').read_text())
    assert data['status'] == 'draft_not_for_recommendations'
    assert len({r['id'] for r in data['recipes']}) == len(data['recipes']) >= 3
    for recipe in data['recipes']:
        assert recipe['allergens_verified'] is False
        assert recipe['instructions']
        assert all(i['product'] in products and i['grams'] > 0 for i in recipe['ingredients'])
