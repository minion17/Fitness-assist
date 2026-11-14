import { describe, expect, it } from 'vitest'
import { createMealPlan, replaceMeal } from './mealPrototype'

describe('подбор блюд', () => {
  it('создаёт выбранное количество дней и суммирует покупки', () => {
    const result = createMealPlan({ days: 3, calories: 2000, allergies: '', disliked: '', liked: '' })
    expect(result.days).toHaveLength(3)
    expect(result.days.every(day => day.meals.length === 3 && day.totals.kcal > 1200)).toBe(true)
    expect(result.shopping.length).toBeGreaterThan(0)
    expect(result.shopping.every(item => item.grams > 0)).toBe(true)
  })
  it('исключает молочные продукты и не принимает неизвестную аллергию', () => {
    const result = createMealPlan({ days: 1, calories: 2000, allergies: 'молоко', disliked: '', liked: '' })
    expect(result.days.flatMap(day => day.meals).every(meal => !meal.tags.includes('dairy'))).toBe(true)
    expect(() => createMealPlan({ days: 1, calories: 2000, allergies: 'редкий аллерген', disliked: '', liked: '' })).toThrow(/не удалось распознать/i)
    expect(() => createMealPlan({ days: 1, calories: 2000, allergies: 'молоко и клубника', disliked: '', liked: '' })).toThrow(/не удалось распознать/i)
  })
  it('не включает исключённый пользователем продукт', () => {
    const result = createMealPlan({ days: 1, calories: 2000, allergies: '', disliked: 'курица', liked: '' })
    expect(result.days.flatMap(day => day.meals).every(meal => !meal.tags.includes('chicken'))).toBe(true)
  })
  it('распознаёт несколько продуктов через пробел и не скрывает неизвестные', () => {
    expect(() => createMealPlan({ days: 1, calories: 2000, allergies: '', disliked: 'греча макароны', liked: '' })).not.toThrow()
    expect(() => createMealPlan({ days: 1, calories: 2000, allergies: 'греча клубника', disliked: '', liked: '' })).toThrow(/не удалось распознать/i)
  })
})

it('учитывает выбранные приёмы и общие порции', () => {
  for (const days of [1, 7, 14]) {
    const input = { days, calories: 2000, allergies: '', disliked: '', liked: '', selectedMeals: ['breakfast'] as const, sharedMeals: ['breakfast'] as const, persons: 3 }
    const plan = createMealPlan(input)
    expect(plan.days.every(d => d.meals.length === 1 && d.meals[0].portions === 3)).toBe(true)
    const amount = plan.days.flatMap(d => d.meals).flatMap(m => m.ingredients).filter(i => i.productId === plan.shopping[0].productId).reduce((n, i) => n + i.grams, 0)
    expect(plan.shopping[0].grams).toBe(amount * 3)
  }
})
it('соблюдает тип питания и исключённые рецепты', () => {
  const base = { days: 1, calories: 2000, allergies: '', disliked: '', liked: '' }
  const plan = createMealPlan({ ...base, dietary: 'pescatarian', dislikedRecipeIds: ['fish-rice'] })
  expect(plan.days[0].meals.every(m => !m.tags.includes('meat') && m.id !== 'fish-rice')).toBe(true)
  const vegan = createMealPlan({ ...base, dietary: 'vegan' })
  expect(vegan.days[0].meals).toHaveLength(3)
  expect(vegan.days[0].meals.every(m => !m.tags.some(t => ['meat', 'fish', 'dairy', 'egg'].includes(t)))).toBe(true)
})

it('заменяет выбранный приём с учётом ограничений и общих порций', () => {
  const input = { days: 1, calories: 2000, allergies: '', disliked: '', liked: '', selectedMeals: ['dinner'] as const, sharedMeals: ['dinner'] as const, persons: 2, dietary: 'vegetarian' as const }
  const original = createMealPlan(input)
  const changed = replaceMeal(input, original, 0, 0)
  expect(changed.days[0].meals[0].id).not.toBe(original.days[0].meals[0].id)
  expect(changed.days[0].meals[0].portions).toBe(2)
  expect(changed.days[0].meals[0].tags).not.toContain('meat')
  expect(changed.days[0].meals[0].tags).not.toContain('fish')
})

it('сохраняет долю дневной цели для выбранных приёмов без ложного предупреждения', () => {
  const base = { days: 1, calories: 2000, allergies: '', disliked: '', liked: '' }
  const onlyDinner = createMealPlan({ ...base, selectedMeals: ['dinner'] })
  const two = createMealPlan({ ...base, selectedMeals: ['breakfast', 'dinner'] })
  expect(onlyDinner.days[0].totals.kcal).toBeLessThan(1000)
  expect(two.days[0].totals.kcal).toBeLessThan(1600)
  expect(onlyDinner.warnings.some(w => w.includes('калорийность'))).toBe(false)
})

it('планирует одно мясо или рыбу в день при ежедневной готовке', () => {
  for (const days of [1, 7, 14]) {
    const plan = createMealPlan({ days, calories: 2000, allergies: '', disliked: '', liked: '', cookingMode: 'daily' })
    for (const day of plan.days) {
      const sources = new Set(day.meals.flatMap(m => m.ingredients.filter(i => ['chicken', 'turkey', 'fish', 'cod'].includes(i.productId)).map(i => i.productId)))
      expect(sources.size).toBeLessThanOrEqual(1)
    }
  }
})

it('использует одно основное блюдо на два дня и учитывает порции в покупках', () => {
  for (const days of [1, 7, 14]) {
    const plan = createMealPlan({ days, calories: 2000, allergies: 'молоко', disliked: 'курица', liked: '', cookingMode: 'batch', persons: 2, sharedMeals: ['dinner'] })
    for (let d = 0; d < days; d += 2) {
      const mains = plan.days.slice(d, d + 2).flatMap(day => day.meals.filter(m => m.meal !== 'breakfast'))
      expect(new Set(mains.map(m => m.id)).size).toBe(1)
      expect(mains.every(m => !m.tags.includes('dairy') && !m.tags.includes('chicken'))).toBe(true)
    }
    for (const item of plan.shopping) {
      const expected = plan.days.flatMap(d => d.meals).reduce((sum, m) => sum + (m.ingredients.find(i => i.productId === item.productId)?.grams ?? 0) * m.portions, 0)
      expect(item.grams).toBe(expected)
    }
  }
})

it('соблюдает веганские ограничения и исключения рецептов при готовке на несколько дней', () => {
  const input = { days: 7, calories: 2000, allergies: '', disliked: '', liked: '', dietary: 'vegan' as const, cookingMode: 'batch' as const, dislikedRecipeIds: ['lentil-rice'] }
  const plan = createMealPlan(input)
  expect(plan.days.flatMap(d => d.meals).every(m => m.id !== 'lentil-rice' && !m.tags.some(t => ['meat', 'fish', 'dairy', 'egg'].includes(t)))).toBe(true)
})

it('сохраняет частоту готовки при замене без изменения остальных дней', () => {
  const base = { days: 7, calories: 2000, allergies: '', disliked: '', liked: '' }
  const daily = { ...base, cookingMode: 'daily' as const }
  const before = createMealPlan(daily)
  const after = replaceMeal(daily, before, 0, 1)
  expect(after.days.slice(1)).toEqual(before.days.slice(1))
  expect(new Set(after.days[0].meals.flatMap(m => m.ingredients.filter(i => ['chicken', 'turkey', 'fish', 'cod'].includes(i.productId)).map(i => i.productId))).size).toBeLessThanOrEqual(1)
  const batch = { ...base, cookingMode: 'batch' as const }
  const batchPlan = createMealPlan(batch)
  const batchChanged = replaceMeal(batch, batchPlan, 0, 1)
  expect(batchChanged.days.slice(2)).toEqual(batchPlan.days.slice(2))
  expect(new Set(batchChanged.days.slice(0, 2).flatMap(d => d.meals.filter(m => m.meal !== 'breakfast').map(m => m.id))).size).toBe(1)
  expect(batchChanged.days[0].meals[1].id).not.toBe(batchPlan.days[0].meals[1].id)
})


it('стабильно составляет неполные дни для разных ограничений', () => {
  for (const cookingMode of ['daily', 'batch', 'varied'] as const) {
    for (const dietary of ['omnivore', 'vegetarian', 'vegan', 'pescatarian'] as const) {
      for (const selectedMeals of [['lunch'], ['dinner'], ['breakfast', 'dinner'], ['lunch', 'dinner']] as const) {
        const input = { days: 7, calories: 2000, allergies: '', disliked: '', liked: '', cookingMode, dietary, selectedMeals }
        const first = createMealPlan(input)
        expect(createMealPlan(input)).toEqual(first)
        expect(first.days.every(d => d.meals.length === selectedMeals.length)).toBe(true)
        if (cookingMode === 'batch') {
          for (let d = 0; d < first.days.length; d += 2) {
            const ids = first.days.slice(d, d + 2).flatMap(day => day.meals.filter(m => m.meal !== 'breakfast').map(m => m.id))
            expect(new Set(ids).size).toBe(1)
          }
        }
      }
    }
  }
})

it('планирует одну партию на семь дней, включая двухнедельный рацион', () => {
  for (const days of [7, 14]) {
    const input = { days, calories: 2000, allergies: '', disliked: 'курица', liked: '', cookingMode: 'batch' as const, batchDays: 7 as const, persons: 3, sharedMeals: ['dinner'] as const, dietary: 'vegan' as const }
    const plan = createMealPlan(input)
    for (let start = 0; start < days; start += 7) {
      const mains = plan.days.slice(start, start + 7).flatMap(d => d.meals.filter(m => m.meal !== 'breakfast'))
      expect(new Set(mains.map(m => m.id)).size).toBe(1)
    }
    const changed = replaceMeal(input, plan, 3, 1)
    expect(changed.days.slice(7)).toEqual(plan.days.slice(7))
    const mains = changed.days.slice(0, 7).flatMap(d => d.meals.filter(m => m.meal !== 'breakfast'))
    expect(new Set(mains.map(m => m.id)).size).toBe(1)
    expect(mains[0].id).not.toBe(plan.days[3].meals[1].id)
    expect(mains.every(m => !m.tags.some(t => ['meat', 'fish', 'dairy', 'egg'].includes(t)))).toBe(true)
    for (let d = 0; d < 7; d++) {
      expect(changed.days[d].meals[0]).toEqual(plan.days[d].meals[0])
      expect(changed.days[d].meals.find(m => m.meal === 'dinner')?.portions).toBe(3)
      expect(changed.days[d].totals.kcal).toBe(changed.days[d].meals.reduce((sum, m) => sum + m.nutrition.kcal, 0))
    }
    for (const item of changed.shopping) {
      const amount = changed.days.flatMap(d => d.meals).reduce((sum, m) => sum + (m.ingredients.find(i => i.productId === item.productId)?.grams ?? 0) * m.portions, 0)
      expect(item.grams).toBe(amount)
    }
  }
})
