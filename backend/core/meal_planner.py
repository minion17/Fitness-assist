"""Experimental meal planning primitives; recipe data must be reviewed before use."""
from itertools import product
from math import isfinite

from backend.core.recipe_calculations import calculate_recipe, eligible_recipes, shopping_list

MEALS = ('breakfast', 'lunch', 'dinner')


class MealPlanUnavailable(ValueError):
    pass


def build_plan(recipes, products, *, days, calorie_target, exclusions, excluded_products=None):
    """Build a draft from reviewed recipes; this does not establish medical or allergen safety."""
    if isinstance(days, bool) or not isinstance(days, int) or days not in (1, 3, 7, 14):
        raise MealPlanUnavailable('Неподдерживаемый срок')
    if isinstance(calorie_target, bool) or not isinstance(calorie_target, (int, float)) or not isfinite(calorie_target) or calorie_target <= 0:
        raise MealPlanUnavailable('Не указан дневной ориентир калорий')
    if exclusions is None:
        raise MealPlanUnavailable('Не подтверждены ограничения по продуктам')
    excluded_products = {s.casefold().replace('ё', 'е') for s in (excluded_products or set())}
    choices = {meal: [] for meal in MEALS}
    for recipe in eligible_recipes(recipes, exclusions):
        meal = recipe.get('meal')
        if meal not in choices or not recipe.get('id') or not recipe.get('name') or not recipe.get('instructions'):
            continue
        ingredients = recipe.get('ingredients')
        if not isinstance(ingredients, list) or any(not isinstance(i, dict) or i.get('product', '').casefold().replace('ё', 'е') in excluded_products for i in ingredients):
            continue
        try:
            nutrition = calculate_recipe(recipe, products)
        except (TypeError, ValueError):
            continue
        choices[meal].append((recipe, nutrition))
    if any(not choices[meal] for meal in MEALS):
        raise MealPlanUnavailable('Недостаточно проверенных блюд с учётом ограничений')
    # Keep the search bounded when a large recipe catalog becomes available.
    combinations = []
    for group in product(*(choices[meal][:30] for meal in MEALS)):
        calories = sum(item[1]['kcal'] for item in group)
        if abs(calories - calorie_target) <= calorie_target * 0.1:
            combinations.append((abs(calories - calorie_target), group))
    if not combinations:
        raise MealPlanUnavailable('Не удалось приблизиться к дневному ориентиру с доступными блюдами')
    combinations.sort(key=lambda item: item[0])
    daily, selected = [], []
    for index in range(days):
        group = combinations[index % len(combinations)][1]
        meals = []
        for meal, (recipe, nutrition) in zip(MEALS, group):
            selected.append(recipe)
            meals.append({'meal': meal, 'id': recipe['id'], 'name': recipe['name'], 'instructions': recipe['instructions'],
                          'ingredients': recipe['ingredients'], 'nutrition': nutrition})
        totals = {field: round(sum(item['nutrition'][field] for item in meals), 1)
                  for field in ('kcal', 'protein_g', 'fat_g', 'carbs_g')}
        daily.append({'day': index + 1, 'meals': meals, 'totals': totals})
    return {'days': daily, 'shopping': shopping_list(selected)}
