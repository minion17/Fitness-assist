import pytest

from backend.core.meal_planner import MealPlanUnavailable, build_plan


PRODUCTS = {'крупа': {'kcal': 300, 'protein_g': 10, 'fat_g': 4, 'carbs_g': 50}}


def recipe(name, meal, allergens=None, verified=True):
    return {'id': name, 'name': name, 'meal': meal, 'allergens_verified': verified,
            'allergens': allergens or [], 'instructions': 'Приготовить.',
            'ingredients': [{'product': 'крупа', 'grams': 200}]}


def test_generates_days_totals_and_shopping_without_losing_grams():
    recipes = [recipe('завтрак', 'breakfast'), recipe('обед', 'lunch'), recipe('ужин', 'dinner')]
    plan = build_plan(recipes, PRODUCTS, days=3, calorie_target=1800, exclusions=set())
    assert len(plan['days']) == 3
    assert plan['days'][0]['totals']['kcal'] == 1800
    assert plan['shopping'] == [{'product': 'крупа', 'grams': 1800}]
    assert len(plan['days'][0]['meals']) == 3


def test_cannot_generate_with_unknown_allergies_unverified_recipes_or_inadequate_calories():
    recipes = [recipe('завтрак', 'breakfast'), recipe('обед', 'lunch'), recipe('ужин', 'dinner', verified=False)]
    with pytest.raises(MealPlanUnavailable):
        build_plan(recipes, PRODUCTS, days=1, calorie_target=1800, exclusions=None)
    with pytest.raises(MealPlanUnavailable):
        build_plan(recipes, PRODUCTS, days=1, calorie_target=1800, exclusions=set())
    recipes[-1]['allergens_verified'] = True
    with pytest.raises(MealPlanUnavailable):
        build_plan(recipes, PRODUCTS, days=1, calorie_target=3000, exclusions=set())


def test_excludes_allergens_and_unwanted_ingredients():
    recipes = [recipe('завтрак', 'breakfast'), recipe('обед', 'lunch', allergens=['milk']), recipe('ужин', 'dinner')]
    with pytest.raises(MealPlanUnavailable):
        build_plan(recipes, PRODUCTS, days=1, calorie_target=1800, exclusions={'milk'})
    with pytest.raises(MealPlanUnavailable):
        build_plan(recipes, PRODUCTS, days=1, calorie_target=1800, exclusions=set(), excluded_products={'крупа'})
