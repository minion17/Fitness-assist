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
const slots = ['breakfast', 'lunch', 'snack', 'dinner'] as const // the order of a day
const MAIN = ['breakfast', 'lunch', 'dinner'] as const
/** From this many calories three meals would need oversized plates: a snack takes a share. */
export const SNACK_FROM = 2400
const isMain = (slot: string) => slot === 'lunch' || slot === 'dinner'
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
  legumes: /бобов(ые|ых|ая|ый)/, honey: /мед[ау]?|медов(ый|ая|ое)/, rye: /рж(аной|аные|аная|ь)/,
  tofu: /тофу/, hummus: /хумус[ау]?/, walnutAny: /грецк(ий|ие)/,
}
/** Foods people often name that none of our dishes has: «клубника» is no reason to refuse a plan. A word that is in
 * neither list (say «казеин», which hides in milk) still stops the plan: guessing is not safe with allergies. */
export const ABSENT = /клубник[аиу]?|земляник[аиу]?|малин[аыу]|черник[аиу]|голубик[аиу]|ежевик[аиу]|киви|ананас(ы|ов)?|манго|персик(и|ов)?|абрикос(ы|ов)?|слив[аыу]|хурм[аыу]|гранат(ы|ов)?|дын[яиюь]|арбуз(ы|ов|а)?|шоколад[ау]?|какао|кофе|чай|горчиц[аыу]|сельдере[йя]|кальмар(ы|ов)?|краб(ы|ов)?|мидии|мидий|устриц[аы]?|моллюск(и|ов)?|свинин[аыу]|баранин[аыу]|утк[аиу]|кролик[а]?|авокадо|кукуруз[аыу]|баклажан(ы|ов)?|кабач(ок|ки|ков)|шпинат[а]?|алкогол[ья]|вино|пиво|желатин[а]?|ваниль|корица|имбир[ья]|мак[а]?|лен|льна|кедров(ые|ых)|фисташк(и|ек)|пекан|кокос[а]?|авокадо/

/** Tags of what's written. Words for foods we never use go to `absent`; for allergies (strict) any other unknown word
 * is an error, for dislikes it's just left out. */
function readTags(text: string, strict: boolean, absent: string[] = []) {
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
    if (matches.length === 0) {
      if (ABSENT.exec(word)?.[0] === word) absent.push(word)
      else unknown.push(word)
    }
    for (const match of matches) tags.add(match)
  }
  if (strict && unknown.length) throw new Error(`Не удалось распознать ограничение «${unknown.join(' ')}». Напиши продукт проще, например «молоко» или «орехи».`)
  return tags
}

const macroKeys = ['protein_g', 'fat_g', 'carbs_g'] as const
const nutrientKeys = ['kcal', ...macroKeys] as const
const emptyTotals = (): Nutrients => ({ kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 })
const rub = (amount: number) => Math.round(amount * 100) / 100
/** Each slot's share of the day; with a snack the three meals give it 12 %. */
function fractions(withSnack: boolean) {
  const k = withSnack ? .88 : 1
  return slots.map(s => s === 'snack' ? (withSnack ? .12 : 0) : ({ breakfast: .30, lunch: .38, dinner: .32 })[s] * k)
}
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
  const scale = Math.min(2.3, Math.max(.60, calories / base)) // a double plate is what a 3 500 kcal day takes
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
  if (![1, 3, 7, 14].includes(input.days)) throw new Error('Выбери срок 1, 3, 7 или 14 дней.')
  if (!Number.isFinite(input.calories) || input.calories < 1200 || input.calories > 6000) throw new Error('Укажи ориентир от 1200 до 6000 ккал.')
  if (input.budget != null && (!Number.isFinite(input.budget) || input.budget < 0)) throw new Error('Проверь недельный бюджет.')
  if (input.macros && macroKeys.some(k => !(Number.isFinite(input.macros![k]) && input.macros![k] > 0))) throw new Error('Проверь ориентиры БЖУ.')
  if (input.persons !== undefined && (!Number.isInteger(input.persons) || input.persons < 1)) throw new Error('Укажи число человек не меньше одного.')
  const chosen = input.selectedMeals ?? MAIN
  if (!chosen.length || chosen.some(s => !slots.includes(s)) || new Set(chosen).size !== chosen.length) throw new Error('Выбери хотя бы один приём пищи.')
  if (input.sharedMeals?.some(s => !slots.includes(s))) throw new Error('Проверь общие приёмы пищи.')
  if (input.cookingMode && !['daily', 'batch', 'varied'].includes(input.cookingMode)) throw new Error('Проверь частоту готовки.')
  if (input.batchDays !== undefined && input.batchDays !== 2 && input.batchDays !== 7) throw new Error('Проверь срок партии.')
  const dietaryTags: Record<Dietary, string[]> = { omnivore: [], pescatarian: ['meat'], vegetarian: ['meat', 'fish'], vegan: ['meat', 'fish', 'dairy', 'egg'] }
  if (input.dietary && !dietaryTags[input.dietary]) throw new Error('Проверь тип питания.')
  const absent: string[] = []
  const excluded = new Set([...readTags(input.allergies, true, absent), ...readTags(input.disliked, false, absent), ...dietaryTags[input.dietary ?? 'omnivore']])
  const liked = readTags(input.liked, false)
  const pick = (withSnack: boolean) => {
    const fr = fractions(withSnack)
    return slots.map((slot, index) => RECIPES.flatMap(r => {
      if (input.dislikedRecipeIds?.includes(r.id)) return []
      if (slot === 'snack' ? r.meal !== 'snack' : r.meal === 'snack') return []
      const batchMain = input.cookingMode === 'batch' && isMain(slot) && r.meal !== 'breakfast'
      if (r.meal !== slot && !(isMain(slot) && r.meal === 'main') && !batchMain) return []
      const tags = [...new Set(r.ingredients.flatMap(i => [i.product, ...INGREDIENTS[i.product].tags]))]
      return tags.some(tag => excluded.has(tag)) ? [] : [portion(r, index, input.calories * fr[index], tags)]
    }))
  }
  let withSnack = input.calories >= SNACK_FROM && !chosen.includes('snack')
  let choices = pick(withSnack)
  if (withSnack && !choices[slots.indexOf('snack')].length) { withSnack = false; choices = pick(false) } // every snack excluded
  const selected: Slot[] = slots.filter(s => chosen.includes(s) || (s === 'snack' && withSnack))
  if (choices.some((group, i) => selected.includes(slots[i]) && !group.length)) throw new Error('Не хватает блюд с учётом ограничений. Для каждого дня нужны завтрак, обед и ужин.')
  const fr = fractions(withSnack || chosen.includes('snack'))
  const notes = [...new Set(absent)].map(w => `«${w}» нет ни в одном нашем блюде, так что в рационе этого нет.`)
  return { choices, liked, selected, excluded, fr, notes }
}
function quality(meal: Meal, target: Nutrients, liked: Set<string>, uses: Map<string, number>) {
  const kcalError = Math.abs(meal.nutrition.kcal - target.kcal) / Math.max(1, target.kcal)
  let macroError = 0
  for (const key of macroKeys) macroError += Math.abs(meal.nutrition[key] - target[key]) / Math.max(5, target[key])
  return kcalError * 4 + macroError * .45 + (uses.get(meal.id) ?? 0) * .8 - meal.tags.filter(t => liked.has(t)).length * .55
}
type Ctx = { selected: readonly Slot[]; fr: number[]; notes: string[] }
const selectedShare = (ctx: Ctx) => slots.reduce((sum, s, i) => sum + (ctx.selected.includes(s) ? ctx.fr[i] : 0), 0)
function targetFor(input: PlanInput, ctx: Ctx, previous: Meal[], share: number) {
  const total = totals(previous)
  // The defaults are selection weights when no profile targets are available.
  const goal = { kcal: input.calories, ...(input.macros ?? {
    protein_g: input.calories * .20 / 4, fat_g: input.calories * .30 / 9, carbs_g: input.calories * .50 / 4 }) }
  for (const key of nutrientKeys) goal[key] = Math.max(1, (goal[key] * selectedShare(ctx) - total[key]) * share)
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
function compile(input: PlanInput, ctx: Ctx, days: Day[]): MealPlan {
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
  const warnings: string[] = [...ctx.notes]
  if (basketCostRub === null) warnings.push('Для части продуктов цена неизвестна. Стоимость корзины и соответствие бюджету не определены.')
  else if (budgetRub !== null && basketCostRub > budgetRub) warnings.push(`Подобранная корзина превышает бюджет на ${rub(basketCostRub - budgetRub)} ₽. Учтены целые упаковки на выбранный срок.`)
  const share = selectedShare(ctx)
  if (days.some(d => Math.abs(d.totals.kcal - input.calories * share) > input.calories * share * .10)) warnings.push('В отдельные дни калорийность отличается от твоего ориентира более чем на 10%.')
  if (input.macros && days.some(d => macroKeys.some(k => Math.abs(d.totals[k] - input.macros![k] * share) > input.macros![k] * share * .20))) warnings.push('В отдельные дни количество белков, жиров или углеводов отличается от ориентира более чем на 20%.')
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
/** `avoid`: dishes of the previous plan, so the next one (the same answers) brings new ones first. */
export function createMealPlan(input: PlanInput, avoid: readonly string[] = []): MealPlan {
  const { choices, liked, selected, fr, notes } = setup(input)
  const ctx: Ctx = { selected, fr, notes }
  // First try the preferred menu. If over budget, increase the influence of package
  // purchases. Return the least expensive attempt with a warning if none fits.
  let best: MealPlan | undefined
  for (const priceWeight of [0, .6, 3, 12]) {
    const weights: Weights = new Map()
    const uses = new Map<string, number>(avoid.map(id => [id, 1]))
    const days: Day[] = []
    let batchId: string | undefined
    for (let day = 1; day <= input.days; day++) {
      const meals: Meal[] = []
      if ((day - 1) % (input.batchDays ?? 2) === 0) batchId = undefined
      for (let s = 0; s < slots.length; s++) {
        if (!selected.includes(slots[s])) continue
        const target = targetFor(input, ctx, meals, fr[s] / fr.slice(s).reduce((a, b, i) => a + (selected.includes(slots[s + i]) ? b : 0), 0))
        let pool = choices[s]
        if (input.cookingMode === 'batch' && isMain(slots[s]) && batchId) pool = pool.filter(m => m.id === batchId)
        if (input.cookingMode === 'daily') {
          pool = pool.filter(m => fitsDaily([...meals, m]) && slots.slice(s + 1).every((slot, i) =>
            !selected.includes(slot) || choices[s + i + 1].some(next => fitsDaily([...meals, m, next]))))
        }
        if (input.cookingMode !== 'batch' || !isMain(slots[s])) pool = distinct(pool, meals)
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
        if (input.cookingMode === 'batch' && isMain(slots[s])) batchId = bestMeal.id
        uses.set(bestMeal.id, (uses.get(bestMeal.id) ?? 0) + 1)
        addMeal(weights, bestMeal)
      }
      days.push({ day, meals, totals: totals(meals) })
    }
    const plan = compile(input, ctx, days)
    if (plan.budgetRub === null || (plan.basketCostRub !== null && plan.basketCostRub <= plan.budgetRub)) return plan
    if (!best || (plan.basketCostRub ?? Infinity) < (best.basketCostRub ?? Infinity)) best = plan
  }
  return best!
}
/** Other dishes for one meal of the plan, best first, each with the plan it would make (a batch dish changes in all
 * its days). */
export function replacementOptions(input: PlanInput, plan: MealPlan, dayIndex: number, mealIndex: number): { meal: Meal; plan: MealPlan }[] {
  const { choices, liked, selected, excluded, fr, notes } = setup(input)
  const ctx: Ctx = { selected, fr, notes }
  const allowedSavedMeal = (meal: Meal) => selected.includes(meal.meal)
    && !input.dislikedRecipeIds?.includes(meal.id)
    && meal.ingredients.every(i => {
      const ingredient = INGREDIENTS[i.productId]
      return ingredient && ![i.productId, ...ingredient.tags].some(tag => excluded.has(tag))
    })
  const day = plan.days[dayIndex]
  if (plan.days.length !== input.days || !day?.meals[mealIndex]) throw new Error('Выбранное блюдо не найдено.')
  const otherMeals = day.meals.filter((_, i) => i !== mealIndex)
  const slot = day.meals[mealIndex].meal
  const slotIndex = slots.indexOf(slot)
  if (!selected.includes(slot)) throw new Error('Приёмы пищи изменились. Составь рацион заново.')
  const budget = input.budget == null ? Infinity : rub(input.budget * input.days / 7)
  if (input.cookingMode === 'batch' && isMain(slot)) {
    const batchLength = input.batchDays ?? 2
    const batchStart = Math.floor(dayIndex / batchLength) * batchLength
    const batchEnd = Math.min(plan.days.length, batchStart + batchLength)
    const weights: Weights = new Map()
    const uses = new Map<string, number>()
    for (const [d, current] of plan.days.entries()) for (const meal of current.meals) {
      if (!allowedSavedMeal(meal)) throw new Error('Ограничения изменились. Составь рацион заново.')
      if (d >= batchStart && d < batchEnd && isMain(meal.meal)) continue
      addMeal(weights, meal)
      uses.set(meal.id, (uses.get(meal.id) ?? 0) + 1)
    }
    const pool = choices[slotIndex].filter(m => m.id !== day.meals[mealIndex].id)
    if (!pool.length) throw new Error('С учётом ограничений другой вариант для этого приёма пищи не найден.')
    const baseCost = sumKnown(Array.from(weights, ([id, g]) => packCost(id, g, true)))
    return pool.flatMap(candidate => {
      const candidateWeights = new Map(weights)
      let score = 0
      let ok = true
      const days = plan.days.map((current, d) => {
        if (d < batchStart || d >= batchEnd) return current
        const meals = current.meals.map(old => {
          if (!isMain(old.meal)) return old
          const replacement = choices[slots.indexOf(old.meal)].find(m => m.id === candidate.id)
          if (!replacement) { ok = false; return old }
          const meal = { ...replacement, portions: input.sharedMeals?.includes(old.meal) ? input.persons ?? 1 : 1 }
          addMeal(candidateWeights, meal)
          score += quality(meal, targetFor(input, ctx, current.meals.filter(m => !isMain(m.meal)), 1), liked, uses)
          return meal
        })
        return { ...current, meals, totals: totals(meals) }
      })
      if (!ok) return []
      const cost = sumKnown(Array.from(candidateWeights, ([id, g]) => packCost(id, g, true)))
      const excess = baseCost === null || cost === null ? Infinity : Math.max(0, cost - budget)
      const next = compile(input, ctx, days)
      return [{ meal: next.days[dayIndex].meals[mealIndex], plan: next, excess, score: score - (input.likedRecipeIds?.includes(candidate.id) ? 1 : 0) }]
    }).sort((a, b) => a.excess - b.excess || a.score - b.score).map(({ meal, plan }) => ({ meal, plan }))
  }
  let pool = choices[slotIndex].filter(m => m.id !== day.meals[mealIndex].id)
  if (input.cookingMode === 'daily') pool = pool.filter(m => fitsDaily([...otherMeals, m]))
  pool = distinct(pool, otherMeals)
  if (!pool.length) throw new Error('С учётом ограничений другой вариант для этого приёма пищи не найден.')
  const weights: Weights = new Map()
  const uses = new Map<string, number>()
  for (const [d, current] of plan.days.entries()) for (const [s, meal] of current.meals.entries()) {
    if (d === dayIndex && s === mealIndex) continue
    if (!allowedSavedMeal(meal)) throw new Error('Ограничения изменились. Составь рацион заново.')
    addMeal(weights, meal)
    uses.set(meal.id, (uses.get(meal.id) ?? 0) + 1)
  }
  const baseCost = sumKnown(Array.from(weights, ([id, g]) => packCost(id, g, true)))
  const target = targetFor(input, ctx, otherMeals, 1)
  return pool.map(m => {
    const meal = { ...m, portions: input.sharedMeals?.includes(m.meal) ? input.persons ?? 1 : 1 }
    const delta = addedCost(weights, meal)
    const excess = baseCost === null || delta === null ? Infinity : Math.max(0, baseCost + delta - budget)
    return { meal, excess, score: quality(m, target, liked, uses) - (input.likedRecipeIds?.includes(m.id) ? 1 : 0) }
  }).sort((a, b) => a.excess - b.excess || a.score - b.score).map(({ meal }) => {
    const meals = day.meals.map((m, s) => s === mealIndex ? meal : m)
    return { meal, plan: compile(input, ctx, plan.days.map((d, i) => i === dayIndex ? { ...d, meals, totals: totals(meals) } : d)) }
  })
}

/** The best other dish for one meal. */
export const replaceMeal = (input: PlanInput, plan: MealPlan, dayIndex: number, mealIndex: number): MealPlan =>
  replacementOptions(input, plan, dayIndex, mealIndex)[0].plan
