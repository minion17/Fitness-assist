import { describe, expect, it } from 'vitest'
import { ABSENT, createMealPlan, rebuildDay, replaceMeal, replacementOptions, SNACK_FROM, type MealPlan } from './mealPrototype'
import { INGREDIENTS, toBuy } from './mealCatalog'

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
    // a food none of our dishes has is not a reason to refuse: the plan says it's not there
    const berry = createMealPlan({ days: 1, calories: 2000, allergies: 'молоко и клубника', disliked: '', liked: '' })
    expect(berry.warnings).toContain('«клубника» нет ни в одном нашем блюде, так что в рационе этого нет.')
    expect(() => createMealPlan({ days: 1, calories: 2000, allergies: 'казеин', disliked: '', liked: '' })).toThrow(/не удалось распознать/i)
  })
  it('не включает исключённый пользователем продукт', () => {
    const result = createMealPlan({ days: 1, calories: 2000, allergies: '', disliked: 'курица', liked: '' })
    expect(result.days.flatMap(day => day.meals).every(meal => !meal.tags.includes('chicken'))).toBe(true)
  })
  it('распознаёт несколько продуктов через пробел и не скрывает неизвестные', () => {
    expect(() => createMealPlan({ days: 1, calories: 2000, allergies: '', disliked: 'греча макароны', liked: '' })).not.toThrow()
    expect(() => createMealPlan({ days: 1, calories: 2000, allergies: 'греча казеин', disliked: '', liked: '' })).toThrow(/не удалось распознать/i)
    expect(() => createMealPlan({ days: 1, calories: 2000, allergies: '', disliked: 'греча казеин', liked: '' })).not.toThrow() // a dislike is no danger
  })
})

it('учитывает выбранные приёмы и общие порции', () => {
  for (const days of [1, 7, 14]) {
    const input = { days, calories: 2000, allergies: '', disliked: '', liked: '', selectedMeals: ['breakfast'] as const, sharedMeals: ['breakfast'] as const, persons: 3 }
    const plan = createMealPlan(input)
    expect(plan.days.every(d => d.meals.length === 1 && d.meals[0].portions === 3)).toBe(true)
    for (const item of plan.shopping) expect(item.grams).toBe(bought(plan, item.productId))
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

const mains = (day: MealPlan['days'][number], slot: string) => day.meals.filter(m => m.meal === slot).map(m => m.id)
/** What the shopping list should say for a product: every portion's grams, turned into what's bought. */
const bought = (plan: MealPlan, id: string) => Math.round(plan.days.flatMap(d => d.meals).reduce((sum, m) => sum + m.ingredients.reduce((n, i) => {
  const [to, grams] = toBuy(i.productId, i.grams * m.portions)
  return n + (to === id ? grams : 0)
}, 0), 0))

it('при готовке каждый день ужин готовится на две порции: вторая — обед на завтра', () => {
  for (const days of [3, 7, 14]) {
    const plan = createMealPlan({ days, calories: 2000, allergies: '', disliked: '', liked: '', cookingMode: 'daily' })
    for (let d = 1; d < days; d++) {
      const lunch = plan.days[d].meals.find(m => m.meal === 'lunch')!
      expect(lunch.id).toBe(mains(plan.days[d - 1], 'dinner')[0])
      expect(lunch.repeat).toBe(true)
      expect(mains(plan.days[d], 'dinner')[0]).not.toBe(lunch.id)
    }
    expect(plan.days[0].meals.some(m => m.repeat)).toBe(false)
    expect(new Set(plan.days.map(d => d.meals[0].id)).size).toBeLessThanOrEqual(3) // breakfasts take turns
  }
})

it('при готовке на несколько дней одно блюдо на обеды и другое на ужины, покупки по порциям', () => {
  for (const days of [1, 7, 14]) {
    const plan = createMealPlan({ days, calories: 2000, allergies: 'молоко', disliked: 'курица', liked: '', cookingMode: 'batch', persons: 2, sharedMeals: ['dinner'] })
    for (let d = 0; d < days; d += 2) {
      const batch = plan.days.slice(d, d + 2)
      expect(new Set(batch.flatMap(day => mains(day, 'lunch'))).size).toBe(1)
      expect(new Set(batch.flatMap(day => mains(day, 'dinner'))).size).toBe(1)
      expect(mains(batch[0], 'lunch')[0]).not.toBe(mains(batch[0], 'dinner')[0])
      expect(batch.flatMap(day => day.meals).every(m => !m.tags.includes('dairy') && !m.tags.includes('chicken'))).toBe(true)
    }
    for (const item of plan.shopping) expect(item.grams).toBe(bought(plan, item.productId))
  }
})

it('в списке покупок сырые продукты, а не варёные', () => {
  const plan = createMealPlan({ days: 7, calories: 2200, allergies: '', disliked: '', liked: '', likedRecipeIds: ['chicken-rice', 'chicken-broccoli', 'fish-potato'] })
  expect(plan.shopping.some(i => /отварн|запеч|варён|на пару|в мундире/i.test(i.product))).toBe(false)
  const cooked = plan.days.flatMap(d => d.meals).flatMap(m => m.ingredients).filter(i => i.productId === 'chicken').reduce((n, i) => n + i.grams, 0)
  if (cooked) expect(plan.shopping.find(i => i.productId === 'rawChicken')!.grams).toBeGreaterThan(cooked * 1.3)
})

it('порция растёт и уменьшается за счёт крупы, масла и белка, а не овощей', () => {
  const small = createMealPlan({ days: 1, calories: 1400, allergies: '', disliked: '', liked: '', selectedMeals: ['dinner'], likedRecipeIds: ['chicken-broccoli'] })
  const big = createMealPlan({ days: 1, calories: 3600, allergies: '', disliked: '', liked: '', selectedMeals: ['dinner'], likedRecipeIds: ['chicken-broccoli'] })
  const broccoli = (p: MealPlan) => p.days[0].meals[0].ingredients.find(i => i.productId === 'broccoli')?.grams
  if (small.days[0].meals[0].id === big.days[0].meals[0].id && broccoli(small)) expect(broccoli(big)).toBe(broccoli(small))
  for (const p of [small, big]) for (const m of p.days[0].meals) for (const i of m.ingredients) if (['tomato', 'cucumber', 'broccoli'].includes(i.productId)) expect(i.grams).toBeLessThanOrEqual(250)
})

it('соблюдает веганские ограничения и исключения рецептов при готовке на несколько дней', () => {
  const input = { days: 7, calories: 2000, allergies: '', disliked: '', liked: '', dietary: 'vegan' as const, cookingMode: 'batch' as const, dislikedRecipeIds: ['lentil-rice'] }
  const plan = createMealPlan(input)
  expect(plan.days.flatMap(d => d.meals).every(m => m.id !== 'lentil-rice' && !m.tags.some(t => ['meat', 'fish', 'dairy', 'egg'].includes(t)))).toBe(true)
})

it('замена меняет блюдо там, где оно приготовлено заранее, и не трогает остальное', () => {
  const base = { days: 7, calories: 2000, allergies: '', disliked: '', liked: '' }
  const daily = { ...base, cookingMode: 'daily' as const }
  const before = createMealPlan(daily)
  const dinner = before.days[2].meals.findIndex(m => m.meal === 'dinner')
  const after = replaceMeal(daily, before, 2, dinner)
  const newDish = after.days[2].meals[dinner].id
  expect(newDish).not.toBe(before.days[2].meals[dinner].id)
  expect(mains(after.days[3], 'lunch')[0]).toBe(newDish) // tomorrow's lunch is the same pot
  expect(after.days.slice(0, 2)).toEqual(before.days.slice(0, 2))
  expect(after.days.slice(4)).toEqual(before.days.slice(4))
  const batch = { ...base, cookingMode: 'batch' as const }
  const batchPlan = createMealPlan(batch)
  const batchChanged = replaceMeal(batch, batchPlan, 0, 1)
  expect(batchChanged.days.slice(2)).toEqual(batchPlan.days.slice(2))
  expect(new Set(batchChanged.days.slice(0, 2).flatMap(d => mains(d, 'lunch'))).size).toBe(1)
  expect(mains(batchChanged.days[0], 'lunch')[0]).not.toBe(mains(batchPlan.days[0], 'lunch')[0])
  expect(batchChanged.days.slice(0, 2).map(d => mains(d, 'dinner'))).toEqual(batchPlan.days.slice(0, 2).map(d => mains(d, 'dinner')))
})

it('пересобирает день целиком', () => {
  const input = { days: 3, calories: 2000, allergies: '', disliked: '', liked: '', cookingMode: 'varied' as const }
  const plan = createMealPlan(input)
  const next = rebuildDay(input, plan, 1)
  expect(next.days[1].meals.map(m => m.id).every((id, i) => id !== plan.days[1].meals[i].id)).toBe(true)
  expect(next.days[0]).toEqual(plan.days[0])
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
          for (let d = 0; d < first.days.length; d += 2) for (const slot of ['lunch', 'dinner']) {
            expect(new Set(first.days.slice(d, d + 2).flatMap(day => mains(day, slot))).size).toBeLessThanOrEqual(1)
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
    for (let start = 0; start < days; start += 7) for (const slot of ['lunch', 'dinner']) {
      expect(new Set(plan.days.slice(start, start + 7).flatMap(d => mains(d, slot))).size).toBe(1)
    }
    const changed = replaceMeal(input, plan, 3, 1)
    expect(changed.days.slice(7)).toEqual(plan.days.slice(7))
    const lunches = changed.days.slice(0, 7).flatMap(d => mains(d, 'lunch'))
    expect(new Set(lunches).size).toBe(1)
    expect(lunches[0]).not.toBe(plan.days[3].meals[1].id)
    for (let d = 0; d < 7; d++) {
      expect(changed.days[d].meals[0]).toEqual(plan.days[d].meals[0])
      expect(changed.days[d].meals.find(m => m.meal === 'dinner')?.portions).toBe(3)
      expect(changed.days[d].totals.kcal).toBe(changed.days[d].meals.reduce((sum, m) => sum + m.nutrition.kcal, 0))
    }
    for (const item of changed.shopping) expect(item.grams).toBe(bought(changed, item.productId))
  }
})

it('добирает большую калорийность перекусом', () => {
  for (const calories of [SNACK_FROM, 3200, 3800]) {
    const plan = createMealPlan({ days: 14, calories, allergies: '', disliked: '', liked: '' })
    expect(plan.days.every(d => d.meals.map(m => m.meal).join() === 'breakfast,lunch,snack,dinner')).toBe(true)
    const avg = plan.days.reduce((n, d) => n + d.totals.kcal, 0) / plan.days.length
    expect(Math.abs(avg - calories) / calories).toBeLessThan(.05)
  }
  expect(createMealPlan({ days: 1, calories: 2000, allergies: '', disliked: '', liked: '' }).days[0].meals).toHaveLength(3)
  // every snack excluded: three meals, no error
  const vegan = createMealPlan({ days: 3, calories: 3000, allergies: '', disliked: '', liked: '', dietary: 'vegan', dislikedRecipeIds: ['apple-peanut', 'hummus-crispbread', 'peanut-crispbread', 'edamame', 'soy-banana'] })
  expect(vegan.days[0].meals.every(m => m.meal !== 'snack')).toBe(true)
})

it('предлагает несколько замен на выбор', () => {
  const input = { days: 7, calories: 2000, allergies: '', disliked: '', liked: '' }
  const plan = createMealPlan(input)
  const options = replacementOptions(input, plan, 2, 1)
  expect(options.length).toBeGreaterThanOrEqual(3)
  expect(new Set(options.map(o => o.meal.id)).size).toBe(options.length)
  expect(options.every(o => o.meal.id !== plan.days[2].meals[1].id && o.plan.days[2].meals[1].id === o.meal.id)).toBe(true)
  expect(replaceMeal(input, plan, 2, 1)).toEqual(options[0].plan)
})

it('следующий рацион с теми же ответами начинает с других блюд', () => {
  const input = { days: 7, calories: 2000, allergies: '', disliked: '', liked: '' }
  const first = createMealPlan(input)
  const ids = first.days.flatMap(d => d.meals.map(m => m.id))
  const next = createMealPlan(input, ids)
  expect(next.days[0].meals.map(m => m.id)).not.toEqual(first.days[0].meals.map(m => m.id))
})

it('считает стоимость корзины по примерным ценам', () => {
  const plan = createMealPlan({ days: 7, calories: 2000, allergies: '', disliked: '', liked: '' })
  expect(plan.basketCostRub).toBeGreaterThan(1500)
  expect(plan.basketCostRub).toBeLessThan(8000)
  expect(Object.values(INGREDIENTS).every(i => i.packRub > 0 && i.packGrams > 0)).toBe(true)
  const tight = createMealPlan({ days: 7, calories: 2000, allergies: '', disliked: '', liked: '', budget: 500 })
  expect(tight.warnings.some(w => w.startsWith('Подобранная корзина превышает бюджет'))).toBe(true)
})

it('«нет в наших блюдах» — правда: ни одно слово из этого списка не встречается в продуктах', () => {
  const words = Object.values(INGREDIENTS).flatMap(i => i.name.toLowerCase().replaceAll('ё', 'е').split(/[^a-zа-я]+/).filter(Boolean))
  expect(words.filter(w => ABSENT.exec(w)?.[0] === w)).toEqual([])
})
