import { INGREDIENTS, packOf, RECIPES, SHOP_NAME, toBuy, type Shop } from './mealCatalog'

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
  children?: number // of the persons; a child's portion is CHILD of an adult's
  sharedMeals?: readonly Slot[]
  selectedMeals?: readonly Slot[]
  likedRecipeIds?: string[]
  dislikedRecipeIds?: string[]
  cookingMode?: CookingFrequency
  batchDays?: 2 | 7
  goalLabel?: string
  quick?: boolean // dishes up to QUICK minutes are preferred
  shop?: Shop // whose prices cost the plan; magnit by default
  dayFactors?: number[] // per plan day: how much bigger its portions are (training days), see trainingFactors
}
export const QUICK = 30
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
  minutes?: number
  repeat?: boolean // cooked earlier: last night's dinner for lunch, or a dish from this batch
  children?: number // of the people it's cooked for
  swaps?: { from: string; to: string }[] // ingredients the user swapped, by name: the recipe text still names the old ones
}
/** A child's portion of a shared dish, of an adult's. */
export const CHILD = .6
/** «на 3 чел.» / «на 2 взр. и 1 реб.»; null for a portion for one. */
export const forWhom = (m: Meal) => m.children ? `на ${Math.round(m.portions - m.children * CHILD)} взр. и ${m.children} реб.` : m.portions > 1 ? `на ${m.portions} чел.` : null
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
  tofu: /тофу/, liver: /печен(ь|и|ью)|печенк[аиу]/, hummus: /хумус[ау]?/, walnutAny: /грецк(ий|ие)/,
  proteinPowder: /протеин[ау]?|протеинов(ый|ые|ого)/,
}
/** Foods people often name that none of our dishes has: «клубника» is no reason to refuse a plan. A word that is in
 * neither list (say «казеин», which hides in milk) still stops the plan: guessing is not safe with allergies. */
export const ABSENT = /клубник[аиу]?|земляник[аиу]?|малин[аыу]|черник[аиу]|голубик[аиу]|ежевик[аиу]|киви|ананас(ы|ов)?|манго|персик(и|ов)?|абрикос(ы|ов)?|слив[аыу]|хурм[аыу]|гранат(ы|ов)?|дын[яиюь]|арбуз(ы|ов|а)?|шоколад[ау]?|какао|кофе|чай|горчиц[аыу]|сельдере[йя]|кальмар(ы|ов)?|краб(ы|ов)?|мидии|мидий|устриц[аы]?|моллюск(и|ов)?|свинин[аыу]|баранин[аыу]|утк[аиу]|кролик[а]?|авокадо|кукуруз[аыу]|баклажан(ы|ов)?|кабач(ок|ки|ков)|шпинат[а]?|алкогол[ья]|вино|пиво|желатин[а]?|ваниль|корица|имбир[ья]|мак[а]?|лен|льна|кедров(ые|ых)|фисташк(и|ек)|пекан|кокос[а]?|авокадо/

/** Quick picks for the questionnaire: every word is one the parser knows; every dislike is in some dish. */
export const ALLERGY_CHIPS = ['орехи', 'арахис', 'глютен', 'молочное', 'яйца', 'рыба', 'морепродукты', 'соя', 'кунжут', 'мёд', 'цитрусы']
export const DISLIKE_CHIPS = ['рыба', 'говядина', 'курица', 'индейка', 'творог', 'бобовые', 'тофу', 'гречка', 'лук', 'чеснок', 'капуста', 'тыква', 'перец', 'печень']
/** What a restriction written as text excludes; throws on a word it doesn't know, like an allergy would. */
export const tagsOf = (text: string) => [...readTags(text, true)]

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
type Weights = Map<string, number> // what to buy (raw, by the shop's product) -> grams
/** Vegetables and herbs keep their amount when a portion grows or shrinks: a smaller plate is less rice and oil, not
 * fewer cucumbers; a bigger one is not 600 g of tomatoes. */
const FIXED = new Set(['tomato', 'cucumber', 'broccoli', 'rawBroccoli', 'carrot', 'rawCarrot', 'pumpkin', 'onion', 'pepper', 'cabbage',
  'dill', 'garlic', 'chili', 'lemon', 'tomatoPaste'])
/** Bought once and used for months: the plan pays for what it uses, not for the whole jar. */
const PANTRY = new Set(['soyProtein', 'oil', 'honey', 'sesame', 'flour'])
function packCost(id: string, grams: number, whole: boolean, shop?: Shop) {
  const [packGrams, packRub] = packOf(id, shop)
  if (!(packGrams > 0 && packRub > 0 && Number.isFinite(packRub) && Number.isFinite(packGrams))) return null
  return (whole && !PANTRY.has(id) ? Math.ceil(grams / packGrams - 1e-9) : grams / packGrams) * packRub
}
function sumKnown(items: (number | null)[]) {
  let sum = 0
  for (const item of items) {
    if (item === null) return null
    sum += item
  }
  return rub(sum)
}
function portion(r: Recipe, slot: number, calories: number, tags: string[], shop?: Shop): Meal {
  const kcal = (fixed: boolean) => r.ingredients.reduce((sum, i) => sum + (FIXED.has(i.product) === fixed ? INGREDIENTS[i.product].kcal * i.grams / 100 : 0), 0)
  const scale = Math.min(2.8, Math.max(.35, (calories - kcal(true)) / Math.max(1, kcal(false))))
  const nutrition = emptyTotals()
  const ingredients = r.ingredients.map(({ product: productId, grams: initial }) => {
    const p = INGREDIENTS[productId]
    const grams = Math.max(1, Math.round(FIXED.has(productId) ? initial : initial * scale))
    for (const key of nutrientKeys) nutrition[key] += p[key] * grams / 100
    return { product: p.name, productId, grams }
  })
  for (const key of nutrientKeys) nutrition[key] = Math.round(nutrition[key])
  return { id: r.id, name: r.name, instructions: r.instructions, meal: slots[slot], tags, ingredients, nutrition, minutes: r.minutes,
    portions: 1, costRub: sumKnown(ingredients.map(i => packCost(...toBuy(i.productId, i.grams), false, shop))) }
}
function addMeal(weights: Weights, meal: Meal) {
  for (const i of meal.ingredients) {
    const [id, grams] = toBuy(i.productId, i.grams * meal.portions)
    weights.set(id, (weights.get(id) ?? 0) + grams)
  }
}
function totals(meals: Meal[]) {
  const sum = emptyTotals()
  for (const m of meals) for (const key of nutrientKeys) sum[key] += m.nutrition[key]
  return sum
}
/** Lunch and dinner cooked together share one dish: `daily` — tonight's dinner in two portions, the second is
 * tomorrow's lunch; `batch` — one dish for the lunches and another for the dinners of N days. null: cooked on its own. */
function groupKey(input: PlanInput, selected: readonly Slot[], dayIndex: number, slot: Slot): string | null {
  if (!isMain(slot)) return null
  if (input.cookingMode === 'batch') return `${slot}:${Math.floor(dayIndex / (input.batchDays ?? 2))}`
  if (input.cookingMode === 'daily' && selected.includes('lunch') && selected.includes('dinner')) {
    if (slot === 'dinner') return `pair:${dayIndex}`
    return dayIndex > 0 ? `pair:${dayIndex - 1}` : null
  }
  return null
}
/** How many breakfasts take turns: nobody cooks a new one every morning. */
/** How many times a week a lunch, dinner or snack is cooked anew: cooked for two meals at once — twice, one at a time — three times. */
const MAX_COOKS: Record<CookingFrequency, number> = { daily: 2, batch: 2, varied: 3 }
const PROTEIN_K = 6 // a fifth short of protein weighs like ~120 ₽ more for one meal
const BREAKFASTS: Record<CookingFrequency, number> = { daily: 3, batch: 2, varied: 7 }
function setup(input: PlanInput) {
  if (![1, 3, 7, 14].includes(input.days)) throw new Error('Выбери срок 1, 3, 7 или 14 дней.')
  if (!Number.isFinite(input.calories) || input.calories < 1200 || input.calories > 6000) throw new Error('Укажи ориентир от 1200 до 6000 ккал.')
  if (input.budget != null && (!Number.isFinite(input.budget) || input.budget < 0)) throw new Error('Проверь недельный бюджет.')
  if (input.macros && macroKeys.some(k => !(Number.isFinite(input.macros![k]) && input.macros![k] > 0))) throw new Error('Проверь ориентиры БЖУ.')
  if (input.persons !== undefined && (!Number.isInteger(input.persons) || input.persons < 1)) throw new Error('Укажи число человек не меньше одного.')
  if (input.children !== undefined && (!Number.isInteger(input.children) || input.children < 0 || input.children >= (input.persons ?? 1))) throw new Error('Детей должно быть меньше, чем всех, кто ест.')
  const chosen = input.selectedMeals ?? MAIN
  if (!chosen.length || chosen.some(s => !slots.includes(s)) || new Set(chosen).size !== chosen.length) throw new Error('Выбери хотя бы один приём пищи.')
  if (input.sharedMeals?.some(s => !slots.includes(s))) throw new Error('Проверь общие приёмы пищи.')
  if (input.cookingMode && !['daily', 'batch', 'varied'].includes(input.cookingMode)) throw new Error('Проверь частоту готовки.')
  if (input.batchDays !== undefined && input.batchDays !== 2 && input.batchDays !== 7) throw new Error('Проверь срок партии.')
  const dietaryTags: Record<Dietary, string[]> = { omnivore: [], pescatarian: ['meat'], vegetarian: ['meat', 'fish'], vegan: ['meat', 'fish', 'dairy', 'egg'] }
  if (input.dietary && !dietaryTags[input.dietary]) throw new Error('Проверь тип питания.')
  const absent: string[] = []
  const excluded = new Set([...readTags(input.allergies, true, absent), ...readTags(input.disliked, false, absent), ...dietaryTags[input.dietary ?? 'omnivore'],
    // protein powder only where plants alone can't make the norm; everyone else gets it from ordinary food
    ...(input.dietary === 'vegan' ? [] : ['proteinPowder'])])
  const liked = readTags(input.liked, false)
  // dishes cooked for two meals may be any lunch or dinner one
  const shared = input.cookingMode === 'batch' || input.cookingMode === 'daily'
  const pick = (withSnack: boolean) => {
    const fr = fractions(withSnack)
    return slots.map((slot, index) => RECIPES.flatMap(r => {
      if (input.dislikedRecipeIds?.includes(r.id)) return []
      if (slot === 'snack' ? r.meal !== 'snack' : r.meal === 'snack') return []
      const anyMain = shared && isMain(slot) && r.meal !== 'breakfast'
      if (r.meal !== slot && !(isMain(slot) && r.meal === 'main') && !anyMain) return []
      const tags = [...new Set(r.ingredients.flatMap(i => [i.product, ...INGREDIENTS[i.product].tags]))]
      return tags.some(tag => excluded.has(tag)) ? [] : [portion(r, index, input.calories * fr[index], tags, input.shop)]
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
function quality(input: PlanInput, meal: Meal, target: Nutrients, liked: Set<string>, uses: Map<string, number>) {
  const kcalError = Math.abs(meal.nutrition.kcal - target.kcal) / Math.max(1, target.kcal)
  let macroError = 0
  for (const key of macroKeys) macroError += Math.abs(meal.nutrition[key] - target[key]) / Math.max(5, target[key])
  const slow = input.quick && (meal.minutes ?? 0) > QUICK ? 1.5 : 0
  // too little protein costs more than too much: it's the macro people fall short of
  const short = Math.max(0, target.protein_g - meal.nutrition.protein_g) / Math.max(5, target.protein_g)
  return kcalError * 4 + macroError * .45 + short * 3.5 + (uses.get(meal.id) ?? 0) * .8 - meal.tags.filter(t => liked.has(t)).length * .55 + slow
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
function addedCost(weights: Weights, meal: Meal, shop?: Shop) {
  let delta = 0
  for (const i of meal.ingredients) {
    const [id, grams] = toBuy(i.productId, i.grams * meal.portions)
    const old = weights.get(id) ?? 0
    const after = packCost(id, old + grams, true, shop)
    const before = packCost(id, old, true, shop)
    if (after === null || before === null) return null
    delta += after - before
  }
  return rub(delta)
}
function compile(input: PlanInput, ctx: Ctx, days: Day[]): MealPlan {
  const weights: Weights = new Map()
  const meals = days.flatMap(d => d.meals)
  meals.forEach(m => addMeal(weights, m))
  const shopping = Array.from(weights, ([productId, raw]) => {
    const grams = Math.round(raw)
    const { name } = INGREDIENTS[productId]
    const [packGrams] = packOf(productId, input.shop)
    return { productId, product: SHOP_NAME[productId] ?? name, grams, packGrams, packs: Math.ceil(grams / packGrams), costRub: packCost(productId, grams, true, input.shop) }
  }).sort((a, b) => a.product.localeCompare(b.product, 'ru'))
  const basketCostRub = sumKnown(shopping.map(i => i.costRub))
  const portionCostRub = sumKnown(meals.map(m => m.costRub))
  const budgetRub = input.budget == null ? null : rub(input.budget * input.days / 7)
  const warnings: string[] = [...ctx.notes]
  if (basketCostRub === null) warnings.push('Для части продуктов цена неизвестна. Стоимость корзины и соответствие бюджету не определены.')
  else if (budgetRub !== null && basketCostRub > budgetRub) warnings.push(`Подобранная корзина превышает бюджет на ${rub(basketCostRub - budgetRub)} ₽. Учтены целые упаковки на выбранный срок.`)
  const share = selectedShare(ctx)
  const f = (d: Day) => factorOf(input, d.day - 1)
  if (days.some(d => Math.abs(d.totals.kcal - input.calories * share * f(d)) > input.calories * share * f(d) * .10)) warnings.push('В отдельные дни калорийность отличается от твоего ориентира более чем на 10%.')
  if (input.macros && days.some(d => macroKeys.some(k => Math.abs(d.totals[k] - input.macros![k] * share * f(d)) > input.macros![k] * share * f(d) * .20))) warnings.push('В отдельные дни количество белков, жиров или углеводов отличается от ориентира более чем на 20%.')
  return { days, shopping, warnings, budgetRub, basketCostRub, portionCostRub, persons: input.persons ?? 1, sharedMeals: input.sharedMeals ?? [] }
}
const factorOf = (input: PlanInput, dayIndex: number) => input.dayFactors?.[dayIndex] ?? 1
/** A portion f times as big: what fills the plate grows, vegetables and herbs stay (see FIXED). */
function scaleMeal(meal: Meal, f: number, shop?: Shop): Meal {
  if (Math.abs(f - 1) < 1e-6) return meal
  const nutrition = emptyTotals()
  const ingredients = meal.ingredients.map(i => {
    const grams = FIXED.has(i.productId) ? i.grams : Math.max(1, Math.round(i.grams * f))
    for (const key of nutrientKeys) nutrition[key] += INGREDIENTS[i.productId][key] * grams / 100
    return { ...i, grams }
  })
  for (const key of nutrientKeys) nutrition[key] = Math.round(nutrition[key])
  return { ...meal, ingredients, nutrition, costRub: sumKnown(ingredients.map(i => packCost(...toBuy(i.productId, i.grams), false, shop))) }
}
const scaleDay = (day: Day, f: number, shop?: Shop): Day => { const meals = day.meals.map(m => scaleMeal(m, f, shop)); return { ...day, meals, totals: totals(meals) } }
/** Training days eat TRAINING times more; the other days of the week a little less, so a week holds the same norm.
 * `weekdays`: of each plan day, 0 = Mon; `training`: the training weekdays. */
export const TRAINING = 1.1
export function trainingFactors(weekdays: number[], training: readonly number[]): number[] | undefined {
  const t = new Set(training).size
  if (!t || t >= 7) return undefined
  const rest = Math.max(.9, (7 - TRAINING * t) / (7 - t))
  return weekdays.map(w => training.includes(w) ? TRAINING : Math.round(rest * 1000) / 1000)
}
/** The same plan moved to other dates: each day's portions rescaled from its old factor to the new one. */
export function retime(input: PlanInput, plan: MealPlan, dayFactors: number[] | undefined): { input: PlanInput; plan: MealPlan } {
  const next: PlanInput = { ...input, dayFactors }
  const { selected, fr, notes } = setup(next)
  const days = plan.days.map((d, i) => scaleDay(d, factorOf(next, i) / factorOf(input, i), next.shop))
  return { input: next, plan: compile(next, { selected, fr, notes }, days) }
}
function distinct(pool: Meal[], others: Meal[]) {
  const alternatives = pool.filter(m => others.every(other => m.id !== other.id))
  return alternatives.length ? alternatives : pool
}
/** Portions of a dish for this slot: everyone at a shared meal, a child's plate smaller. */
function portionsOf(input: PlanInput, slot: Slot): Pick<Meal, 'portions' | 'children'> {
  if (!input.sharedMeals?.includes(slot)) return { portions: 1 }
  const persons = input.persons ?? 1, children = input.children ?? 0
  return children ? { portions: Math.round((persons - children + children * CHILD) * 10) / 10, children } : { portions: persons }
}
/** `avoid`: dishes of the previous plan, so the next one (the same answers) brings new ones first. */
export function createMealPlan(input: PlanInput, avoid: readonly string[] = []): MealPlan {
  // Return the least expensive attempt with a warning if none fits.
  let best: MealPlan | undefined
  for (const plan of attempts(input, avoid)) {
    if (plan.budgetRub === null || (plan.basketCostRub !== null && plan.basketCostRub <= plan.budgetRub)) return plan
    if (!best || (plan.basketCostRub ?? Infinity) < (best.basketCostRub ?? Infinity)) best = plan
  }
  return best!
}
/** What a week costs for these answers, in rubles: the cheapest menu, the cheapest one that still keeps 90 % of the
 * protein target, and the menu with no budget. null when a price is unknown. */
export function budgetRange(input: PlanInput): { cheapest: number; balanced: number; full: number } | null {
  const week = { ...input, days: 7, budget: null }
  const protein = (input.macros?.protein_g ?? input.calories * .20 / 4) * 7
  const plans = [...attempts(week, [])]
  if (plans.some(p => p.basketCostRub === null)) return null
  const cost = (p: MealPlan) => p.basketCostRub!
  const share = plans[0].days.reduce((sum, d) => sum + d.totals.kcal, 0) / (input.calories * 7) // the selected meals' part of the day
  const enough = plans.filter(p => p.days.reduce((sum, d) => sum + d.totals.protein_g, 0) >= protein * share * .9)
  return { cheapest: Math.min(...plans.map(cost)), balanced: Math.min(...(enough.length ? enough : plans.slice(0, 1)).map(cost)), full: cost(plans[0]) }
}
/** One plan per price weight. Price always counts a little: fewer half-used packs and a shorter list. Over budget, it counts more. */
function* attempts(input: PlanInput, avoid: readonly string[]): Generator<MealPlan> {
  const { choices, liked, selected, fr, notes } = setup(input)
  const ctx: Ctx = { selected, fr, notes }
  const breakfasts = BREAKFASTS[input.cookingMode ?? 'varied']
  for (const priceWeight of [.15, .3, .5, .8, 1.2, 2, 4, 12]) {
    const weights: Weights = new Map()
    const uses = new Map<string, number>(avoid.map(id => [id, 1]))
    const assigned = new Map<string, string>() // cooking group -> its dish
    const morning = new Set<string>()
    const cooked = new Map<string, number>() // dish -> times cooked (not eaten): a cheap menu must not be two soups all week
    const days: Day[] = []
    for (let day = 1; day <= input.days; day++) {
      const meals: Meal[] = []
      for (let s = 0; s < slots.length; s++) {
        const slot = slots[s]
        if (!selected.includes(slot)) continue
        const key = groupKey(input, selected, day - 1, slot)
        const forced = key ? assigned.get(key) : undefined
        let pool = choices[s]
        if (forced) pool = pool.filter(m => m.id === forced)
        else {
          pool = distinct(pool, meals)
          // breakfasts take turns, each up to its share of the days; others up to MAX_COOKS times a week
          const cap = slot === 'breakfast' ? Math.max(2, Math.ceil(input.days / breakfasts)) : MAX_COOKS[input.cookingMode ?? 'varied'] * Math.ceil(input.days / 7)
          const fresh = pool.filter(m => (cooked.get(m.id) ?? 0) < cap)
          const turn = slot === 'breakfast' && morning.size >= breakfasts ? fresh.filter(m => morning.has(m.id)) : fresh
          pool = turn.length ? turn : fresh.length ? fresh : slot === 'breakfast' && morning.size >= breakfasts ? pool.filter(m => morning.has(m.id)) : pool
        }
        if (!pool.length) throw new Error('Не удалось подобрать блюда для выбранной частоты готовки с учётом ограничений.')
        const target = targetFor(input, ctx, meals, fr[s] / fr.slice(s).reduce((a, b, i) => a + (selected.includes(slots[s + i]) ? b : 0), 0))
        let bestMeal = pool[0]
        let bestScore = Infinity
        if (!forced) for (const m of pool) {
          const candidate = { ...m, ...portionsOf(input, slot) }
          const delta = addedCost(weights, candidate, input.shop)
          const costScore = delta === null || m.costRub === null ? 10000 : (delta + m.costRub * .6) / 100
          const previousDay = days.at(-1)?.meals.some(previous => previous.id === m.id)
          // saving money must not cost protein: its shortfall weighs as much more as the price does
          const short = Math.max(0, target.protein_g - m.nutrition.protein_g) / Math.max(5, target.protein_g)
          const score = quality(input, m, target, liked, uses) - (input.likedRecipeIds?.includes(m.id) ? 1 : 0) + (previousDay ? .65 : 0) + priceWeight * (costScore + short * PROTEIN_K)
          if (score < bestScore) { bestScore = score; bestMeal = m }
        }
        bestMeal = { ...bestMeal, ...portionsOf(input, slot), ...(forced ? { repeat: true } : {}) }
        meals.push(bestMeal)
        if (key && !forced) assigned.set(key, bestMeal.id)
        if (!forced) cooked.set(bestMeal.id, (cooked.get(bestMeal.id) ?? 0) + 1)
        if (slot === 'breakfast') morning.add(bestMeal.id)
        uses.set(bestMeal.id, (uses.get(bestMeal.id) ?? 0) + 1)
        addMeal(weights, bestMeal)
      }
      days.push(scaleDay({ day, meals, totals: totals(meals) }, factorOf(input, day - 1), input.shop))
    }
    yield compile(input, ctx, days)
  }
}
/** Other dishes for one meal of the plan, best first, each with the plan it would make. A dish cooked for several meals
 * (tonight's dinner and tomorrow's lunch, a batch) changes in all of them. */
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
  const slot = day.meals[mealIndex].meal
  if (!selected.includes(slot)) throw new Error('Приёмы пищи изменились. Составь рацион заново.')
  const key = groupKey(input, selected, dayIndex, slot)
  const cells = key ? plan.days.flatMap((d, di) => d.meals.flatMap((m, mi) => groupKey(input, selected, di, m.meal) === key ? [[di, mi] as const] : []))
    : [[dayIndex, mealIndex] as const]
  const inGroup = (di: number, mi: number) => cells.some(([d, m]) => d === di && m === mi)
  const weights: Weights = new Map()
  const uses = new Map<string, number>()
  for (const [d, current] of plan.days.entries()) for (const [m, meal] of current.meals.entries()) {
    if (!allowedSavedMeal(meal)) throw new Error('Ограничения изменились. Составь рацион заново.')
    if (inGroup(d, m)) continue
    addMeal(weights, meal)
    uses.set(meal.id, (uses.get(meal.id) ?? 0) + 1)
  }
  const others = day.meals.filter((_, i) => !inGroup(dayIndex, i))
  const pool = distinct(choices[slots.indexOf(slot)].filter(m => m.id !== day.meals[mealIndex].id), others)
  if (!pool.length) throw new Error('С учётом ограничений другой вариант для этого приёма пищи не найден.')
  const baseCost = sumKnown(Array.from(weights, ([id, g]) => packCost(id, g, true, input.shop)))
  const budget = input.budget == null ? Infinity : rub(input.budget * input.days / 7)
  return pool.flatMap(candidate => {
    const candidateWeights = new Map(weights)
    let score = 0
    let ok = true
    const days = plan.days.map((current, d) => {
      if (!current.meals.some((_, m) => inGroup(d, m))) return current
      const meals = current.meals.map((old, m) => {
        if (!inGroup(d, m)) return old
        const replacement = choices[slots.indexOf(old.meal)].find(x => x.id === candidate.id)
        if (!replacement) { ok = false; return old }
        const first = cells[0][0] === d && cells[0][1] === m
        const base: Meal = { ...replacement, ...portionsOf(input, old.meal), ...(first ? {} : { repeat: true }) }
        score += quality(input, base, targetFor(input, ctx, current.meals.filter((_, i) => !inGroup(d, i)), 1), liked, uses)
        const meal = scaleMeal(base, factorOf(input, d), input.shop)
        addMeal(candidateWeights, meal)
        return meal
      })
      return { ...current, meals, totals: totals(meals) }
    })
    if (!ok) return []
    const cost = sumKnown(Array.from(candidateWeights, ([id, g]) => packCost(id, g, true, input.shop)))
    const excess = baseCost === null || cost === null ? Infinity : Math.max(0, cost - budget)
    const next = compile(input, ctx, days)
    return [{ meal: next.days[dayIndex].meals[mealIndex], plan: next, excess, score: score / cells.length - (input.likedRecipeIds?.includes(candidate.id) ? 1 : 0) }]
  }).sort((a, b) => a.excess - b.excess || a.score - b.score).map(({ meal, plan }) => ({ meal, plan }))
}

/** The best other dish for one meal. */
export const replaceMeal = (input: PlanInput, plan: MealPlan, dayIndex: number, mealIndex: number): MealPlan =>
  replacementOptions(input, plan, dayIndex, mealIndex)[0].plan

/** «Пересобрать день»: every meal of the day swapped for its best other dish (dishes shared with other days change there too). */
export function rebuildDay(input: PlanInput, plan: MealPlan, dayIndex: number): MealPlan {
  let next = plan
  for (let i = 0; i < plan.days[dayIndex].meals.length; i++) {
    const options = replacementOptions(input, next, dayIndex, i)
    if (options.length) next = options[0].plan
  }
  return next
}

/** Ingredients that stand in for each other in a dish, same grams: a group is one kind of food. */
const SWAPS = [['chicken', 'turkey'], ['rawChicken', 'rawTurkey'], ['fish', 'cod'], ['pollock', 'rawCod'], ['rice', 'buckwheat', 'millet'],
  ['milk', 'soyMilk', 'oatMilk'], ['apple', 'banana'], ['peanut', 'walnut']]
/** What can replace this ingredient, given the answers (no allergen or disliked food). */
export function swapOptions(input: PlanInput, productId: string): { id: string; name: string }[] {
  const { excluded } = setup(input)
  return (SWAPS.find(g => g.includes(productId)) ?? []).filter(id => id !== productId && INGREDIENTS[id]
    && ![id, ...INGREDIENTS[id].tags].some(t => excluded.has(t))).map(id => ({ id, name: INGREDIENTS[id].name }))
}
/** Where one cooking of the dish at (day, meal) is eaten: that meal and the portions kept from it (repeats), in order. */
export function cookedFor(plan: MealPlan, dayIndex: number, mealIndex: number): [number, number][] {
  const id = plan.days[dayIndex].meals[mealIndex].id
  const cells: [number, number][] = [[dayIndex, mealIndex]]
  for (let d = dayIndex; d < plan.days.length; d++) {
    for (let m = d === dayIndex ? mealIndex + 1 : 0; m < plan.days[d].meals.length; m++) {
      const meal = plan.days[d].meals[m]
      if (meal.id !== id) continue
      if (!meal.repeat) return cells
      cells.push([d, m])
    }
  }
  return cells
}
/** One ingredient of a dish swapped for another everywhere this cooking of it is eaten. */
export function swapIngredient(input: PlanInput, plan: MealPlan, dayIndex: number, mealIndex: number, from: string, to: string): MealPlan {
  if (!swapOptions(input, from).some(o => o.id === to)) throw new Error('Эту замену сделать нельзя.')
  const cells = cookedFor(plan, dayIndex, mealIndex)
  const days = plan.days.map((day, d) => {
    if (!cells.some(([cd]) => cd === d)) return day
    const meals = day.meals.map((meal, m) => {
      if (!cells.some(([cd, cm]) => cd === d && cm === m)) return meal
      const nutrition = emptyTotals()
      const ingredients = meal.ingredients.map(i => {
        const productId = i.productId === from ? to : i.productId
        for (const key of nutrientKeys) nutrition[key] += INGREDIENTS[productId][key] * i.grams / 100
        return { ...i, productId, product: INGREDIENTS[productId].name }
      })
      for (const key of nutrientKeys) nutrition[key] = Math.round(nutrition[key])
      const prev = meal.swaps?.find(w => w.to === INGREDIENTS[from].name) // swapped before: keep what the recipe text names
      const swaps = [...(meal.swaps ?? []).filter(w => w !== prev), { from: prev?.from ?? INGREDIENTS[from].name, to: INGREDIENTS[to].name }]
        .filter(w => w.from !== w.to)
      return { ...meal, ingredients, nutrition, swaps, tags: [...new Set(ingredients.flatMap(i => [i.productId, ...INGREDIENTS[i.productId].tags]))],
        costRub: sumKnown(ingredients.map(i => packCost(...toBuy(i.productId, i.grams), false, input.shop))) }
    })
    return { ...day, meals, totals: totals(meals) }
  })
  const { selected, fr, notes } = setup(input)
  return compile(input, { selected, fr, notes }, days)
}
