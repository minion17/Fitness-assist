import { INGREDIENTS, RECIPES } from './mealCatalog'

type Nutrients = { kcal: number; protein_g: number; fat_g: number; carbs_g: number }
type Macros = Omit<Nutrients, 'kcal'>
export type PlanInput = {
  days: number
  calories: number
  allergies: string
  disliked: string
  liked: string
  budget?: number | null // Weekly budget in rubles
  macros?: Macros
  dietary?: Dietary
  persons?: number
  sharedMeals?: readonly Slot[]
  selectedMeals?: readonly Slot[]
  likedRecipeIds?: string[]
  dislikedRecipeIds?: string[]
  cookingMode?: CookingFrequency
  batchDays?: 2 | 7
  goalLabel?: string
}
const slots = ['breakfast', 'lunch', 'dinner'] as const
export type Slot = typeof slots[number]
export type CookingFrequency = 'daily' | 'batch' | 'varied'
export type Dietary = 'omnivore' | 'pescatarian' | 'vegetarian' | 'vegan'
export type Meal = {
  id: string; name: string; meal: Slot; instructions: string; tags: string[]
  ingredients: { product: string; productId: string; grams: number }[]
  nutrition: Nutrients; costRub: number | null; portions: number
}
type Day = { day: number; meals: Meal[]; totals: Nutrients }
type ShoppingItem = { product: string; productId: string; grams: number; packs: number; packGrams: number; costRub: number | null }
export type MealPlan = {
  days: Day[]; shopping: ShoppingItem[]; warnings: string[]
  persons: number; sharedMeals: readonly Slot[]
  basketCostRub: number | null; portionCostRub: number | null; budgetRub: number | null
}

const normalize = (s: string) => s.toLowerCase().replaceAll('ё', 'е').trim()
// Each expression must match a whole token. A recognized word must never hide an unknown restriction.
const terms: Record<string, RegExp> = {
  dairy: /молок[оауе]|молочн(ое|ые|ый|ая|ых|ого|ую)|лактоз[аыуе]?|кефир[ау]?|сыр[аыу]?/,
  curd: /творог[ау]?|творожн(ый|ое|ые)/, butter: /сливочн(ый|ое|ые|ого)/,
  egg: /яйц(а|о|у|ам|ами)?|яиц|яичн(ый|ые|ое)/,
  gluten: /глютен[ау]?/, wheat: /пшениц[аыуе]?|пшеничн(ый|ая|ое|ые)/,
  oats: /овес|овса|овсян(ка|ку|ки|ая|ые|ую)|геркулес[а]?/,
  nuts: /орех(и|ов|а|ам)?|миндал[ьяю]?|кешью|фундук[а]?|арахис[ау]?/,
  walnut: /грецк(ий|ие|их|ого)/, fish: /рыб[аыуе]?|рыбн(ый|ое|ая|ые)|минта[йя]|треск[аиу]|лосос[ья]/,
  chicken: /куриц[аыуе]?|курин(ая|ое|ый|ые|ого|ую)|кур(у|ы|а)/,
  turkey: /индейк[аиуе]|индюш(ка|ку|ки)/, poultry: /птиц[аыуе]/, meat: /мяс[оауе]|мясн(ое|ые|ого)/,
  rice: /рис[ауе]?|рисов(ый|ая|ое|ые)/, millet: /пшено|пшена|пшенн(ая|ые|ое|ую)/,
  potato: /картоф(ель|еля|елю)|картошк[ауи]/, broccoli: /брокколи/,
  cucumber: /огур(ец|цы|цов|ца)/, tomato: /помидор(ы|ов|а)?|томат(ы|ов|а)?/,
  carrot: /морков[ьи]|морковк[ауи]/, pumpkin: /тыкв[аыуе]/,
  apple: /яблок(о|и|а|у)?|яблочн(ый|ые|ая)/, banana: /банан(ы|ов|а)?/,
  cherry: /вишн(я|ю|и)/, sunflowerSeeds: /семеч(ки|ек)|подсолнечник[а]?|подсолнечн(ое|ые|ый)/,
  soy: /соя|сою|сои|соев(ые|ый|ое|ая)/, mushroom: /гриб(ы|ов|а)?/, sesame: /кунжут[ау]?/,
  shellfish: /кревет(ка|ки|ок)|ракообразные|морепродукт(ы|ов)?/, citrus: /цитрус(ы|овых)?|апельсин(ы|ов)?/,
  buckwheat: /греч(а|ка|ку|ки|и|у)|гречнев(ая|ую|ые|ый)/,
  pasta: /макарон(ы|ов)?|спагетти|лапш[аиу]|паст[ау]/, lentils: /чечевиц[аыуе]/,
  peas: /горох[ау]?|горошек|горошка/, greenBeans: /фасол[ьи]|стручков(ая|ую|ой)/,
  beef: /говядин[аыуе]?|говяж(ий|ье|ья|ьи)/, chickpeas: /нут[ау]?/,
  onion: /лук[ау]?/, garlic: /чеснок[ау]?/, pepper: /перец|перца|перцы|перцев/,
  cabbage: /капуст[аыуе]/, berries: /ягод[аыу]?/, currant: /смородин[аыуе]/,
  grape: /изюм[ау]?|виноград[ау]?/, flour: /мук[аиу]/, bread: /хлеб[ау]?/,
  semolina: /манк[аиу]|манн(ая|ую|ой)/, yogurt: /йогурт[ау]?/, sourCream: /сметан[аыуе]/,
  tuna: /тунец|тунца/, dill: /укроп[ау]?/,
  legumes: /бобов(ые|ых|ая|ый)/,
}

function readTags(text: string, strict: boolean) {
  const tags = new Set<string>()
  const value = normalize(text)
  if (!value || /^(нет|нет аллергии|нет аллергий|нет ограничений|ничего|отсутствует|отсутствуют)$/.test(value)) return tags
  const unknown: string[] = []
  for (const word of value.split(/[\s,;.():/!—-]+/u).filter(Boolean)) {
    if (/^(на|и|или|не|ем|без|аллергия|аллергии|продукты|продуктов|филе|сушеное|замороженная|хлопья)$/.test(word)) continue
    const matches = Object.entries(terms).filter(([, pattern]) => pattern.exec(word)?.[0] === word).map(([tag]) => tag)
    // Also accept exact catalog names and tags, including future additions.
    for (const [id, p] of Object.entries(INGREDIENTS)) {
      if (normalize(id) === word || normalize(p.name) === word) matches.push(id)
      for (const tag of p.tags) if (normalize(tag) === word) matches.push(tag)
    }
    if (matches.length === 0) unknown.push(word)
    for (const match of matches) tags.add(match)
  }
  if (strict && (unknown.length || !tags.size)) throw new Error(`Не удалось распознать ограничение «${unknown.join(' ') || value}». Уточните название продукта.`)
  return tags
}

const macroKeys = ['protein_g', 'fat_g', 'carbs_g'] as const
const nutrientKeys = ['kcal', ...macroKeys] as const
const emptyTotals = (): Nutrients => ({ kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 })
const rub = (amount: number) => Math.round(amount * 100) / 100
const fraction = [0.30, 0.38, 0.32]
type Recipe = typeof RECIPES[number]
type Weights = Map<string, number>
function packCost(id: string, grams: number, whole: boolean) {
  const { packRub, packGrams } = INGREDIENTS[id]
  if (!(packGrams > 0 && packRub > 0 && Number.isFinite(packRub) && Number.isFinite(packGrams))) return null
  return (whole ? Math.ceil(grams / packGrams) : grams / packGrams) * packRub
}
function sumKnown(items: (number | null)[]) {
  let sum = 0
  for (const item of items) {
    if (item === null) return null
    sum += item
  }
  return rub(sum)
}
function portion(r: Recipe, slot: number, calories: number, tags: string[]): Meal {
  const base = r.ingredients.reduce((sum, i) => sum + INGREDIENTS[i.product].kcal * i.grams / 100, 0)
  const scale = Math.min(1.75, Math.max(.60, calories / base))
  const nutrition = emptyTotals()
  const ingredients = r.ingredients.map(({ product: productId, grams: initial }) => {
    const p = INGREDIENTS[productId]
    const grams = Math.max(1, Math.round(initial * scale))
    for (const key of nutrientKeys) nutrition[key] += p[key] * grams / 100
    return { product: p.name, productId, grams }
  })
  for (const key of nutrientKeys) nutrition[key] = Math.round(nutrition[key])
  return { id: r.id, name: r.name, instructions: r.instructions, meal: slots[slot], tags, ingredients, nutrition,
    portions: 1, costRub: sumKnown(ingredients.map(i => packCost(i.productId, i.grams, false))) }
}
function addMeal(weights: Weights, meal: Meal) {
  for (const i of meal.ingredients) weights.set(i.productId, (weights.get(i.productId) ?? 0) + i.grams * meal.portions)
}
function totals(meals: Meal[]) {
  const sum = emptyTotals()
  for (const m of meals) for (const key of nutrientKeys) sum[key] += m.nutrition[key]
  return sum
}
function setup(input: PlanInput) {
  if (![1, 3, 7, 14].includes(input.days)) throw new Error('Выберите срок 1, 3, 7 или 14 дней.')
  if (!Number.isFinite(input.calories) || input.calories < 1200 || input.calories > 6000) throw new Error('Укажите ориентир от 1200 до 6000 ккал.')
  if (input.budget != null && (!Number.isFinite(input.budget) || input.budget < 0)) throw new Error('Проверьте недельный бюджет.')
  if (input.macros && macroKeys.some(k => !(Number.isFinite(input.macros![k]) && input.macros![k] > 0))) throw new Error('Проверьте ориентиры БЖУ.')
  if (input.persons !== undefined && (!Number.isInteger(input.persons) || input.persons < 1)) throw new Error('Укажите число человек не меньше одного.')
  const selected = input.selectedMeals ?? slots
  if (!selected.length || selected.some(s => !slots.includes(s)) || new Set(selected).size !== selected.length) throw new Error('Выберите хотя бы один приём пищи.')
  if (input.sharedMeals?.some(s => !slots.includes(s))) throw new Error('Проверьте общие приёмы пищи.')
  if (input.cookingMode && !['daily', 'batch', 'varied'].includes(input.cookingMode)) throw new Error('Проверьте частоту готовки.')
  if (input.batchDays !== undefined && input.batchDays !== 2 && input.batchDays !== 7) throw new Error('Проверьте срок партии.')
  const dietaryTags: Record<Dietary, string[]> = { omnivore: [], pescatarian: ['meat'], vegetarian: ['meat', 'fish'], vegan: ['meat', 'fish', 'dairy', 'egg'] }
  if (input.dietary && !dietaryTags[input.dietary]) throw new Error('Проверьте тип питания.')
  const excluded = new Set([...readTags(input.allergies, true), ...readTags(input.disliked, true), ...dietaryTags[input.dietary ?? 'omnivore']])
  const liked = readTags(input.liked, false)
  const choices = slots.map((slot, index) => RECIPES.flatMap(r => {
    if (input.dislikedRecipeIds?.includes(r.id)) return []
    const batchMain = input.cookingMode === 'batch' && slot !== 'breakfast' && r.meal !== 'breakfast'
    if (r.meal !== slot && !(slot !== 'breakfast' && r.meal === 'main') && !batchMain) return []
    const tags = [...new Set(r.ingredients.flatMap(i => [i.product, ...INGREDIENTS[i.product].tags]))]
    return tags.some(tag => excluded.has(tag)) ? [] : [portion(r, index, input.calories * fraction[index], tags)]
  }))
  if (choices.some((group, i) => selected.includes(slots[i]) && !group.length)) throw new Error('Не хватает блюд с учётом ограничений. Для каждого дня нужны завтрак, обед и ужин.')
  return { choices, liked, selected, excluded }
}
function quality(meal: Meal, target: Nutrients, liked: Set<string>, uses: Map<string, number>) {
  const kcalError = Math.abs(meal.nutrition.kcal - target.kcal) / Math.max(1, target.kcal)
  let macroError = 0
  for (const key of macroKeys) macroError += Math.abs(meal.nutrition[key] - target[key]) / Math.max(5, target[key])
  return kcalError * 4 + macroError * .45 + (uses.get(meal.id) ?? 0) * .8 - meal.tags.filter(t => liked.has(t)).length * .55
}
function targetFor(input: PlanInput, previous: Meal[], share: number) {
  const total = totals(previous)
  // The defaults are selection weights when no profile targets are available.
  const goal = { kcal: input.calories, ...(input.macros ?? {
    protein_g: input.calories * .20 / 4, fat_g: input.calories * .30 / 9, carbs_g: input.calories * .50 / 4 }) }
  const selectedShare = fraction.reduce((sum, f, i) => sum + ((input.selectedMeals ?? slots).includes(slots[i]) ? f : 0), 0)
  for (const key of nutrientKeys) goal[key] = Math.max(1, (goal[key] * selectedShare - total[key]) * share)
  return goal
}
function addedCost(weights: Weights, meal: Meal) {
  let delta = 0
  for (const i of meal.ingredients) {
    const old = weights.get(i.productId) ?? 0
    const after = packCost(i.productId, old + i.grams * meal.portions, true)
    const before = packCost(i.productId, old, true)
    if (after === null || before === null) return null
    delta += after - before
  }
  return rub(delta)
}
function compile(input: PlanInput, days: Day[]): MealPlan {
  const weights: Weights = new Map()
  const meals = days.flatMap(d => d.meals)
  meals.forEach(m => addMeal(weights, m))
  const shopping = Array.from(weights, ([productId, grams]) => {
    const { name: product, packGrams } = INGREDIENTS[productId]
    return { productId, product, grams, packGrams, packs: Math.ceil(grams / packGrams), costRub: packCost(productId, grams, true) }
  }).sort((a, b) => a.product.localeCompare(b.product, 'ru'))
  const basketCostRub = sumKnown(shopping.map(i => i.costRub))
  const portionCostRub = sumKnown(meals.map(m => m.costRub))
  const budgetRub = input.budget == null ? null : rub(input.budget * input.days / 7)
  const warnings: string[] = []
  if (basketCostRub === null) warnings.push('Для части продуктов цена неизвестна. Стоимость корзины и соответствие бюджету не определены.')
  else if (budgetRub !== null && basketCostRub > budgetRub) warnings.push(`Подобранная корзина превышает бюджет на ${rub(basketCostRub - budgetRub)} ₽. Учтены целые упаковки на выбранный срок.`)
  const selectedShare = fraction.reduce((sum, f, i) => sum + ((input.selectedMeals ?? slots).includes(slots[i]) ? f : 0), 0)
  if (days.some(d => Math.abs(d.totals.kcal - input.calories * selectedShare) > input.calories * selectedShare * .10)) warnings.push('В отдельные дни калорийность отличается от вашего ориентира более чем на 10%.')
  if (input.macros && days.some(d => macroKeys.some(k => Math.abs(d.totals[k] - input.macros![k] * selectedShare) > input.macros![k] * selectedShare * .20))) warnings.push('В отдельные дни количество белков, жиров или углеводов отличается от ориентира более чем на 20%.')
  return { days, shopping, warnings, budgetRub, basketCostRub, portionCostRub, persons: input.persons ?? 1, sharedMeals: input.sharedMeals ?? [] }
}
function distinct(pool: Meal[], others: Meal[]) {
  const alternatives = pool.filter(m => others.every(other => m.id !== other.id))
  return alternatives.length ? alternatives : pool
}
function animalSources(meal: Meal) {
  // The same meat can appear raw in one recipe and already cooked in another.
  const sources: Record<string, string> = { rawChicken: 'chicken', mince: 'beef', pollock: 'fish' }
  return meal.ingredients
    .filter(i => INGREDIENTS[i.productId].tags.some(t => t === 'meat' || t === 'fish'))
    .map(i => sources[i.productId] ?? i.productId)
}
function fitsDaily(meals: Meal[]) {
  return new Set(meals.flatMap(animalSources)).size <= 1
}
export function createMealPlan(input: PlanInput): MealPlan {
  const { choices, liked, selected } = setup(input)
  // First try the preferred menu. If over budget, increase the influence of package
  // purchases. Return the least expensive attempt with a warning if none fits.
  let best: MealPlan | undefined
  for (const priceWeight of [0, .6, 3, 12]) {
    const weights: Weights = new Map()
    const uses = new Map<string, number>()
    const days: Day[] = []
    let batchId: string | undefined
    for (let day = 1; day <= input.days; day++) {
      const meals: Meal[] = []
      if ((day - 1) % (input.batchDays ?? 2) === 0) batchId = undefined
      for (let s = 0; s < slots.length; s++) {
        if (!selected.includes(slots[s])) continue
        const target = targetFor(input, meals, fraction[s] / fraction.slice(s).reduce((a, b, i) => a + (selected.includes(slots[s + i]) ? b : 0), 0))
        let pool = choices[s]
        if (input.cookingMode === 'batch' && s > 0 && batchId) pool = pool.filter(m => m.id === batchId)
        if (input.cookingMode === 'daily') {
          pool = pool.filter(m => fitsDaily([...meals, m]) && slots.slice(s + 1).every((slot, i) =>
            !selected.includes(slot) || choices[s + i + 1].some(next => fitsDaily([...meals, m, next]))))
        }
        if (input.cookingMode !== 'batch' || s === 0) pool = distinct(pool, meals)
        if (!pool.length) throw new Error('Не удалось подобрать блюда для выбранной частоты готовки с учётом ограничений.')
        let bestMeal = pool[0]
        let bestScore = Infinity
        for (const m of pool) {
          const candidate = { ...m, portions: input.sharedMeals?.includes(slots[s]) ? input.persons ?? 1 : 1 }
          const delta = addedCost(weights, candidate)
          const costScore = delta === null || m.costRub === null ? 10000 : (delta + m.costRub * .6) / 100
          const previousDay = days.at(-1)?.meals.some(previous => previous.id === m.id)
          const score = quality(m, target, liked, uses) - (input.likedRecipeIds?.includes(m.id) ? 1 : 0) + (previousDay ? .65 : 0) + priceWeight * costScore
          if (score < bestScore) { bestScore = score; bestMeal = m }
        }
        bestMeal = { ...bestMeal, portions: input.sharedMeals?.includes(slots[s]) ? input.persons ?? 1 : 1 }
        meals.push(bestMeal)
        if (input.cookingMode === 'batch' && s > 0) batchId = bestMeal.id
        uses.set(bestMeal.id, (uses.get(bestMeal.id) ?? 0) + 1)
        addMeal(weights, bestMeal)
      }
      days.push({ day, meals, totals: totals(meals) })
    }
    const plan = compile(input, days)
    if (plan.budgetRub === null || (plan.basketCostRub !== null && plan.basketCostRub <= plan.budgetRub)) return plan
    if (!best || (plan.basketCostRub ?? Infinity) < (best.basketCostRub ?? Infinity)) best = plan
  }
  return best!
}
export function replaceMeal(input: PlanInput, plan: MealPlan, dayIndex: number, mealIndex: number): MealPlan {
  const { choices, liked, selected, excluded } = setup(input)
  const allowedSavedMeal = (meal: Meal) => selected.includes(meal.meal)
    && !input.dislikedRecipeIds?.includes(meal.id)
    && meal.ingredients.every(i => {
      const ingredient = INGREDIENTS[i.productId]
      return ingredient && ![i.productId, ...ingredient.tags].some(tag => excluded.has(tag))
    })
  const day = plan.days[dayIndex]
  if (plan.days.length !== input.days || !day?.meals[mealIndex]) throw new Error('Выбранное блюдо не найдено.')
  const otherMeals = day.meals.filter((_, i) => i !== mealIndex)
  const slotIndex = slots.indexOf(day.meals[mealIndex].meal)
  if (!selected.includes(day.meals[mealIndex].meal)) throw new Error('Приёмы пищи изменились. Составьте рацион заново.')
  if (input.cookingMode === 'batch' && slotIndex > 0) {
    const batchLength = input.batchDays ?? 2
    const batchStart = Math.floor(dayIndex / batchLength) * batchLength
    const batchEnd = Math.min(plan.days.length, batchStart + batchLength)
    const weights: Weights = new Map()
    const uses = new Map<string, number>()
    for (const [d, current] of plan.days.entries()) for (const meal of current.meals) {
      if (!allowedSavedMeal(meal)) throw new Error('Ограничения изменились. Составьте рацион заново.')
      if (d >= batchStart && d < batchEnd && meal.meal !== 'breakfast') continue
      addMeal(weights, meal)
      uses.set(meal.id, (uses.get(meal.id) ?? 0) + 1)
    }
    const pool = choices[slotIndex].filter(m => m.id !== day.meals[mealIndex].id)
    if (!pool.length) throw new Error('С учётом ограничений другой вариант для этого приёма пищи не найден.')
    const baseCost = sumKnown(Array.from(weights, ([id, g]) => packCost(id, g, true)))
    const budget = input.budget == null ? Infinity : rub(input.budget * input.days / 7)
    const ranked = pool.map(candidate => {
      const candidateWeights = new Map(weights)
      let score = 0
      const days = plan.days.map((current, d) => {
        if (d < batchStart || d >= batchEnd) return current
        const meals = current.meals.map(old => {
          if (old.meal === 'breakfast') return old
          const replacement = choices[slots.indexOf(old.meal)].find(m => m.id === candidate.id)
          if (!replacement) throw new Error('Не удалось подобрать блюдо для всех приёмов партии.')
          const meal = { ...replacement, portions: input.sharedMeals?.includes(old.meal) ? input.persons ?? 1 : 1 }
          addMeal(candidateWeights, meal)
          score += quality(meal, targetFor(input, current.meals.filter(m => m.meal === 'breakfast'), 1), liked, uses)
          return meal
        })
        return { ...current, meals, totals: totals(meals) }
      })
      const cost = sumKnown(Array.from(candidateWeights, ([id, g]) => packCost(id, g, true)))
      const excess = baseCost === null || cost === null ? Infinity : Math.max(0, cost - budget)
      return { days, excess, score: score - (input.likedRecipeIds?.includes(candidate.id) ? 1 : 0) }
    }).sort((a, b) => a.excess - b.excess || a.score - b.score)
    return compile(input, ranked[0].days)
  }
  let pool = choices[slotIndex].filter(m => m.id !== day.meals[mealIndex].id)
  if (input.cookingMode === 'daily') pool = pool.filter(m => fitsDaily([...otherMeals, m]))
  pool = distinct(pool, otherMeals)
  if (!pool.length) throw new Error('С учётом ограничений другой вариант для этого приёма пищи не найден.')
  const weights: Weights = new Map()
  const uses = new Map<string, number>()
  for (const [d, current] of plan.days.entries()) for (const [s, meal] of current.meals.entries()) {
    if (d === dayIndex && s === mealIndex) continue
    if (!allowedSavedMeal(meal)) throw new Error('Ограничения изменились. Составьте рацион заново.')
    addMeal(weights, meal)
    uses.set(meal.id, (uses.get(meal.id) ?? 0) + 1)
  }
  const baseCost = sumKnown(Array.from(weights, ([id, g]) => packCost(id, g, true)))
  const budget = input.budget == null ? Infinity : rub(input.budget * input.days / 7)
  const target = targetFor(input, otherMeals, 1)
  const ranked = pool.map(m => {
    const candidate = { ...m, portions: input.sharedMeals?.includes(m.meal) ? input.persons ?? 1 : 1 }
    const delta = addedCost(weights, candidate)
    const excess = baseCost === null || delta === null ? Infinity : Math.max(0, baseCost + delta - budget)
    return { meal: m, excess, score: quality(m, target, liked, uses) - (input.likedRecipeIds?.includes(m.id) ? 1 : 0) }
  }).sort((a, b) => a.excess - b.excess || a.score - b.score)
  const meals = day.meals.map((m, s) => s === mealIndex ? { ...ranked[0].meal, portions: input.sharedMeals?.includes(m.meal) ? input.persons ?? 1 : 1 } : m)
  return compile(input, plan.days.map((d, i) => i === dayIndex ? { ...d, meals, totals: totals(meals) } : d))
}
