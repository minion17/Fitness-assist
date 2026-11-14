"""Calculations for recipe drafts; no medical or allergen safety guarantee."""
from math import isfinite

NUTRIENTS = ('kcal', 'protein_g', 'fat_g', 'carbs_g')


def _ingredients(recipe):
    ingredients = recipe.get('ingredients')
    if not isinstance(ingredients, list) or not ingredients:
        raise ValueError('Recipe must contain ingredients')
    for ingredient in ingredients:
        name, grams = ingredient.get('product'), ingredient.get('grams')
        if not isinstance(name, str) or not name or isinstance(grams, bool) or not isinstance(grams, (int, float)) or not isfinite(grams) or grams <= 0:
            raise ValueError('Invalid ingredient')
        yield name, grams


def calculate_recipe(recipe, products):
    """Calculate the whole recipe from nutrition per 100 g in the product's stated form."""
    totals = dict.fromkeys(NUTRIENTS, 0.0)
    for name, grams in _ingredients(recipe):
        product = products.get(name)
        if not isinstance(product, dict):
            raise ValueError(f'Unknown product: {name}')
        for field in NUTRIENTS:
            value = product.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or value < 0:
                raise ValueError(f'Missing nutrition: {name}, {field}')
            totals[field] += value * grams / 100
    return {key: round(value, 1) for key, value in totals.items()}


def shopping_list(recipes):
    """Aggregate ingredient weights; raw and cooked product names remain separate."""
    totals = {}
    for recipe in recipes:
        for name, grams in _ingredients(recipe):
            totals[name] = totals.get(name, 0) + grams
    return [{'product': name, 'grams': round(grams, 1)} for name, grams in sorted(totals.items())]


def eligible_recipes(recipes, exclusions):
    """Reject unverified labels and missing exclusions; callers must not infer clinical safety."""
    if exclusions is None:
        return []
    return [r for r in recipes if r.get('allergens_verified') is True
            and isinstance(r.get('allergens'), list)
            and all(isinstance(a, str) and a for a in r['allergens'])
            and not exclusions.intersection(r['allergens'])]
