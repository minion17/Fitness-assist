import { describe, expect, it } from 'vitest'
import { INGREDIENTS } from './mealCatalog'
import { createMealPlan } from './mealPrototype'

describe('ограничения мяса и птицы', () => {
  it('помечает курицу и индейку обеими общими категориями', () => {
    for (const id of ['chicken', 'turkey']) expect(INGREDIENTS[id].tags).toEqual(expect.arrayContaining(['meat', 'poultry']))
  })
  it.each(['мясо', 'птица', 'курица', 'индейка', 'рыба', 'рис'])('исключает %s из всех блюд', restriction => {
    const plan = createMealPlan({ days: 14, calories: 2000, allergies: '', disliked: restriction, liked: '' })
    const excluded: Record<string, string[]> = { мясо: ['chicken', 'turkey'], птица: ['chicken', 'turkey'], курица: ['chicken'], индейка: ['turkey'], рыба: ['fish', 'cod'], рис: ['rice'] }
    expect(plan.days.flatMap(day => day.meals).flatMap(meal => meal.ingredients).some(item => excluded[restriction].includes(item.productId))).toBe(false)
  })
})


it.each(['vegan', 'vegetarian', 'pescatarian'] as const)('составляет рацион %s из трёх приёмов на 14 дней', dietary => {
  const forbidden = dietary === 'vegan' ? ['meat', 'fish', 'dairy', 'egg'] : dietary === 'vegetarian' ? ['meat', 'fish'] : ['meat']
  const plan = createMealPlan({ days: 14, calories: 2000, allergies: '', disliked: '', liked: '', dietary })
  expect(plan.days.every(d => d.meals.length === 3 && d.meals.every(m => !m.tags.some(t => forbidden.includes(t))))).toBe(true)
  expect(plan.basketCostRub).toBeNull()
})

it('содержит разнообразные блюда с однозначными продуктами и весом', async () => {
  const { RECIPES } = await import('./mealCatalog')
  expect(RECIPES.length).toBeGreaterThanOrEqual(27)
  expect(new Set(RECIPES.map(r => r.id)).size).toBe(RECIPES.length)
  for (const recipe of RECIPES) {
    expect(recipe.instructions.length).toBeGreaterThan(50)
    for (const item of recipe.ingredients) {
      expect(INGREDIENTS[item.product]).toBeDefined()
      expect(item.grams).toBeGreaterThan(0)
    }
  }
  expect(INGREDIENTS.peanut.tags).toEqual(expect.arrayContaining(['nuts', 'legumes']))
  expect(INGREDIENTS.buckwheat.tags).toContain('buckwheat')
})

it.each([7, 14])('в разнообразном меню на %i дней чередует блюда и считает КБЖУ порций', days => {
  const plan = createMealPlan({ days, calories: 2200, cookingMode: 'varied', allergies: '', disliked: '', liked: '' })
  const meals = plan.days.flatMap(d => d.meals)
  expect(new Set(meals.map(m => m.id)).size).toBeGreaterThanOrEqual(days * 2)
  for (const meal of meals) {
    for (const key of ['kcal', 'protein_g', 'fat_g', 'carbs_g'] as const) {
      const calculated = meal.ingredients.reduce((sum, i) => sum + INGREDIENTS[i.productId][key] * i.grams / 100, 0)
      expect(meal.nutrition[key]).toBe(Math.round(calculated))
      expect(meal.nutrition[key]).toBeGreaterThan(0)
    }
  }
})
