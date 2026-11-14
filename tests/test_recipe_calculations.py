import pytest

from backend.core.recipe_calculations import calculate_recipe, shopping_list, eligible_recipes


PRODUCTS = {
    'яблоко': {'kcal': 50, 'protein_g': 1, 'fat_g': 0.5, 'carbs_g': 10},
    'творог': {'kcal': 100, 'protein_g': 18, 'fat_g': 2, 'carbs_g': 3},
}


def test_calculates_per_ingredient_and_sums_shopping():
    recipe = {'ingredients': [{'product': 'яблоко', 'grams': 200}, {'product': 'творог', 'grams': 150}]}
    assert calculate_recipe(recipe, PRODUCTS) == {'kcal': 250, 'protein_g': 29, 'fat_g': 4, 'carbs_g': 24.5}
    assert shopping_list([recipe, recipe]) == [{'product': 'творог', 'grams': 300}, {'product': 'яблоко', 'grams': 400}]


def test_missing_product_invalid_grams_and_incomplete_nutrition_fail_closed():
    with pytest.raises(ValueError):
        calculate_recipe({'ingredients': [{'product': 'неизвестно', 'grams': 100}]}, PRODUCTS)
    with pytest.raises(ValueError):
        calculate_recipe({'ingredients': [{'product': 'яблоко', 'grams': -1}]}, PRODUCTS)
    with pytest.raises(ValueError):
        calculate_recipe({'ingredients': [{'product': 'яблоко', 'grams': 100}]}, {'яблоко': {'kcal': 50}})


def test_only_verified_recipes_can_be_selected_and_allergies_block_them():
    recipes = [
        {'id': 'draft', 'allergens_verified': False, 'allergens': [], 'ingredients': []},
        {'id': 'dairy', 'allergens_verified': True, 'allergens': ['dairy'], 'ingredients': []},
        {'id': 'plain', 'allergens_verified': True, 'allergens': [], 'ingredients': []},
        {'id': 'missing', 'allergens_verified': True, 'ingredients': []},
    ]
    assert [r['id'] for r in eligible_recipes(recipes, {'dairy'})] == ['plain']
    assert eligible_recipes(recipes, None) == []
