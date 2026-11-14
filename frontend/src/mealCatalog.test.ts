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
