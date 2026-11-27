import { useEffect, useState } from 'react'
import { plural } from './plural'
import { api, putJson } from './telegram'
import { calculateTargets, type Goal, type ProfileData } from './profile'
import { createMealPlan, rebuildDay, replacementOptions, type PlanInput, type MealPlan as GeneratedPlan } from './mealPrototype'
import MealRange from './MealRange'
import PlanShopping from './PlanShopping'
import './MealOverview.css'
import MealDay, { labels } from './MealDay'
import DishPhoto from './DishPhoto'
import { INGREDIENTS, PRICES_AS_OF, RECIPES } from './mealCatalog'
import { useBack } from './back'
import { Chevron } from './ui'

type Preferences = { days: 1 | 3 | 7 | 14; goal: 'weight_loss' | 'maintenance' | 'mass_gain'; allergies: string; liked: string; disliked: string; budget: number | null; current_spend: number | null }
const DAYS: Record<number, string> = { 1: '1 день', 3: '3 дня', 7: '7 дней', 14: '14 дней' }
const GOALS: Record<Preferences['goal'], string> = { weight_loss: 'Снизить вес', maintenance: 'Поддерживать вес', mass_gain: 'Набрать вес' }
type Slot = 'breakfast' | 'lunch' | 'dinner'
type Diet = 'omnivore' | 'pescatarian' | 'vegetarian' | 'vegan'
const MEALS: { id: Slot; label: string }[] = [{ id: 'breakfast', label: 'Завтрак' }, { id: 'lunch', label: 'Обед' }, { id: 'dinner', label: 'Ужин' }]
const DIETS: { id: Diet; label: string; description: string }[] = [{ id: 'omnivore', label: 'Всеядное', description: 'Ем разные продукты' }, { id: 'pescatarian', label: 'Пескетарианство', description: 'Ем рыбу и морепродукты' }, { id: 'vegetarian', label: 'Вегетарианство', description: 'Без мяса и рыбы' }, { id: 'vegan', label: 'Веганство', description: 'Только растительная пища' }]
const COOKING = [
  ['daily', 'Готовить раз в день', 'Ужин на 2 порции: вторая — обед на завтра. Завтраки по кругу'],
  ['batch', 'На несколько дней', 'Два блюда за раз: одно на обеды, другое на ужины'],
  ['varied', 'Разные блюда', 'Каждый приём — новое блюдо. Готовить чаще'],
] as const
const dayOptions = Object.values(DAYS)
const goalOptions = Object.values(GOALS)
const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`
const iso = (d: Date) => d.toLocaleDateString('sv-SE')
const shift = (day: string, n: number) => { const d = new Date(`${day}T12:00`); d.setDate(d.getDate() + n); return iso(d) }
const dayName = (day: string) => new Date(`${day}T12:00`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })
type Saved = { input: PlanInput; plan: GeneratedPlan; start?: string | null; next_start?: string | null }
function AnswerGroup({ title, entries }: { title: string; entries: string[][] }) {
  return <section className="answer-group"><h2>{title}</h2><dl>
    {entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl></section>
}
const ALLERGIES: Record<string, string> = { dairy: 'молочное', eggs: 'яйца', gluten: 'глютен', nuts: 'орехи', fish: 'рыба' }
const FORBIDDEN: Record<Diet, string[]> = { omnivore: [], pescatarian: ['meat'], vegetarian: ['meat', 'fish'], vegan: ['meat', 'fish', 'dairy', 'egg'] }
/** Only dishes the chosen diet allows are offered to like: no goulash for a vegan. */
const fitsDiet = (r: typeof RECIPES[number], diet: Diet) => !r.ingredients.some(i => INGREDIENTS[i.product].tags.some((t: string) => FORBIDDEN[diet].includes(t)))
// what the profile already knows is not asked again: it's on the review screen, where it can be changed
type StepId = 'days' | 'goal' | 'persons' | 'meals' | 'cooking' | 'budget' | 'sex' | 'diet' | 'tastes'

export default function MealPlan({ onClose, showSaved = false, renew = false, canEdit = false, healthConsent = true, profile = null }: {
  onClose: () => void; showSaved?: boolean; renew?: boolean; canEdit?: boolean; healthConsent?: boolean; profile?: ProfileData | null
}) {
  useBack(onClose)
  const [view, setView] = useState<'form' | 'review' | 'result' | 'loading'>(showSaved || renew ? 'loading' : 'form')
  const [step, setStep] = useState(0)
  const [dayIndex, setDayIndex] = useState<number | null>(null)
  const [days, setDays] = useState('7 дней')
  const [goal, setGoal] = useState(profile?.goal === 'weight_loss' || profile?.goal === 'fat_loss' ? GOALS.weight_loss : profile?.goal === 'muscle_gain' || profile?.goal === 'mass_gain' ? GOALS.mass_gain : GOALS.maintenance)
  const [allergies, setAllergies] = useState(healthConsent ? (profile?.allergies ?? []).map(a => ALLERGIES[a] ?? a).join(', ') : '')
  const [liked, setLiked] = useState('')
  const [disliked, setDisliked] = useState('')
  const [budget, setBudget] = useState('')
  const [budgetLimits, setBudgetLimits] = useState([30000, 30000])
  const [currentSpend, setCurrentSpend] = useState('')
  const [cookingMode, setCookingMode] = useState<'daily' | 'batch' | 'varied'>('daily')
  const [batchDays, setBatchDays] = useState<2 | 7>(2)
  const [persons, setPersons] = useState(1)
  const [selectedMeals, setSelectedMeals] = useState<Slot[]>(['breakfast', 'lunch', 'dinner'])
  const [sharedMeals, setSharedMeals] = useState<Slot[]>([])
  const [sex, setSex] = useState<'male' | 'female' | null>(profile?.sex ?? null)
  const [diet, setDiet] = useState<Diet>('omnivore')
  const [likedRecipes, setLikedRecipes] = useState<string[]>([])
  const [dislikedRecipes, setDislikedRecipes] = useState<string[]>([])
  const [loading, setLoading] = useState(canEdit)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [noAllergies, setNoAllergies] = useState(false)
  const [plan, setPlan] = useState<GeneratedPlan | null>(null)
  const [planInput, setPlanInput] = useState<PlanInput | null>(null)
  const [savedPlan, setSavedPlan] = useState<Saved | null>(null)
  const [quick, setQuick] = useState(false)
  const [start, setStart] = useState('') // the first day of the plan being saved; '' = today
  const [isSaved, setIsSaved] = useState(false) // the plan on screen is the saved one
  const [planMessage, setPlanMessage] = useState('')
  const [savingPlan, setSavingPlan] = useState(false)
  const [calorieOverride, setCalorieOverride] = useState('')
  const [today] = useState(() => iso(new Date()))

  const flow: StepId[] = ['days', ...(profile?.goal ? [] : ['goal' as const]), 'persons', ...(persons > 1 ? ['meals' as const] : []),
    'cooking', 'budget', ...(profile?.sex ? [] : ['sex' as const]), 'diet', 'tastes']
  const current = flow[Math.min(step, flow.length - 1)]

  useEffect(() => {
    if (!canEdit) return
    let active = true
    api<Saved>('/api/meal-plan').then(value => {
      if (!active) return
      if (value?.plan?.days && value.input) {
        setSavedPlan(value)
        if (showSaved || renew) openSavedPlan(value, renew)
      } else if (showSaved || renew) setPlanMessage('Сохранённый рацион не найден.')
    }).catch(() => { if (active) setPlanMessage('Не удалось загрузить сохранённый рацион.') })
    return () => { active = false }
  }, [canEdit, healthConsent, showSaved, renew])
  const savePlan = async () => {
    if (!plan || !planInput || savingPlan) return
    setSavingPlan(true); setPlanMessage('')
    try {
      const first = start || today
      const result = await api<Saved>('/api/meal-plan', putJson({ input: planInput, plan, ...(first !== today ? { start: first } : {}) }))
      if (!result) throw new Error()
      setSavedPlan(result); setPlanMessage(first === today ? 'Рацион сохранён в твоём профиле.' : `Рацион сохранён и начнётся ${dayName(first)}.`); onClose()
    } catch { setPlanMessage('Не удалось сохранить рацион. Проверь подключение и согласие в профиле.') }
    finally { setSavingPlan(false) }
  }
  /** The same answers, new dishes first: for when the current plan has run out. */
  const nextPlan = (input: PlanInput, previous: GeneratedPlan) => {
    try {
      setPlan(createMealPlan(input, previous.days.flatMap(d => d.meals.map(m => m.id))))
      setIsSaved(false); setPlanMessage('Новый рацион с теми же настройками. Сохрани, чтобы он появился в дневнике.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось подобрать блюда.') }
  }
  const openSavedPlan = (saved: Saved, next = false) => {
    setPlan(saved.plan); setPlanInput(saved.input); setIsSaved(true); setQuick(Boolean(saved.input.quick))
    setDays(DAYS[saved.input.days] ?? `${saved.input.days} ${plural(saved.input.days, 'день', 'дня', 'дней')}`)
    setDiet(saved.input.dietary ?? 'omnivore')
    setAllergies(healthConsent ? saved.input.allergies : '')
    setNoAllergies(!saved.input.allergies.trim())
    setDisliked(saved.input.disliked); setLiked(saved.input.liked)
    setCookingMode(saved.input.cookingMode ?? 'daily'); setBatchDays(saved.input.batchDays ?? 2)
    setPersons(saved.input.persons ?? 1); setSelectedMeals([...(saved.input.selectedMeals ?? ['breakfast', 'lunch', 'dinner'])].filter((m): m is Slot => m !== 'snack')); setSharedMeals([...(saved.input.sharedMeals ?? [])].filter((m): m is Slot => m !== 'snack'))
    setLikedRecipes(saved.input.likedRecipeIds ?? []); setDislikedRecipes(saved.input.dislikedRecipeIds ?? [])
    setCalorieOverride(String(saved.input.calories))
    if (saved.input.goalLabel && Object.values(GOALS).includes(saved.input.goalLabel)) setGoal(saved.input.goalLabel)
    setPlanMessage(''); setView('result')
    if (next) nextPlan(saved.input, saved.plan)
  }
  useEffect(() => {
    if (!canEdit) return
    let active = true
    api<Preferences>('/api/meal-preferences').then(data => {
      if (!active || !data) return
      setBudgetLimits([data.budget, data.current_spend].map(n => Math.max(30000, Math.ceil((n ?? 0) / 100) * 100)))
      setBudget(data.budget == null ? '' : String(data.budget)); setCurrentSpend(data.current_spend == null ? '' : String(data.current_spend))
      const extra = data as Preferences & { persons?: number; selected_meals?: Slot[]; shared_meals?: Slot[]; sex?: 'male' | 'female' | null; dietary_type?: Diet; cooking_mode?: 'daily' | 'batch' | 'varied'; batch_days?: 2 | 7; liked_recipe_ids?: string[]; disliked_recipe_ids?: string[]; quick?: boolean }
      setSex(extra.sex ?? profile?.sex ?? null)
      if (showSaved || renew) return
      setDays(DAYS[data.days]); setGoal(GOALS[data.goal]); setAllergies(healthConsent ? data.allergies : '')
      setPersons(extra.persons ?? 1); setSelectedMeals(extra.selected_meals ?? ['breakfast', 'lunch', 'dinner']); setSharedMeals(extra.shared_meals ?? [])
      setCookingMode(extra.cooking_mode ?? 'daily'); setBatchDays(extra.batch_days ?? 2); setQuick(Boolean(extra.quick)); setDiet(extra.dietary_type ?? 'omnivore'); setLikedRecipes(extra.liked_recipe_ids ?? []); setDislikedRecipes(extra.disliked_recipe_ids ?? [])
      setLiked(data.liked); setDisliked(data.disliked)
    }).catch(() => { if (active) { setLoadFailed(true); setError('Не удалось загрузить сохранённые ответы. Попробуй открыть анкету позже.') } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [canEdit, healthConsent])
  const save = async () => {
    if (loadFailed) return
    const asNumber = (v: string) => v.trim() === '' ? null : Number(v)
    const body = { days: Number.parseInt(days), goal: Object.entries(GOALS).find(([, label]) => label === goal)?.[0], allergies: healthConsent ? allergies : '', liked, disliked, budget: asNumber(budget), current_spend: asNumber(currentSpend), persons, selected_meals: selectedMeals, shared_meals: persons > 1 ? sharedMeals : [], sex, dietary_type: diet, cooking_mode: cookingMode, batch_days: batchDays, quick, liked_recipe_ids: likedRecipes, disliked_recipe_ids: dislikedRecipes }
    if ([body.budget, body.current_spend].some(n => n !== null && (!Number.isInteger(n) || n < 0 || n > 10000000))) { setError('Укажи бюджет целым числом от 0 до 10 000 000 ₽.'); return }
    setError(''); setSaved(false)
    try { const result = await api('/api/meal-preferences', putJson(body)); if (result === null) throw new Error(); setSaved(true) }
    catch { setError('Не удалось сохранить ответы. Проверь подключение и попробуй ещё раз.') }
  }
  const selectedGoal: Goal = goal === GOALS.weight_loss ? (profile?.goal === 'fat_loss' ? 'fat_loss' : 'weight_loss') : goal === GOALS.mass_gain ? (profile?.goal === 'muscle_gain' ? 'muscle_gain' : 'mass_gain') : 'maintenance'
  const targets = profile ? (selectedGoal === profile.goal && profile.targets && (!sex || sex === profile.sex) ? profile.targets : calculateTargets({ ...profile, sex: sex ?? profile.sex }, selectedGoal)) : null
  const defaultCalories = targets?.calories ?? (goal === GOALS.weight_loss ? 1800 : goal === GOALS.mass_gain ? 2200 : 2000)
  const next = () => {
    if (current === 'meals' && selectedMeals.length === 0) { setError('Выбери хотя бы один приём пищи.'); return }
    if (current === 'persons' && persons === 1) { setSelectedMeals(['breakfast', 'lunch', 'dinner']); setSharedMeals([]) }
    setError('')
    if (step >= flow.length - 1) setView('review'); else setStep(s => s + 1)
  }
  const toggleMeal = (id: Slot) => {
    setSelectedMeals(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id])
    setSharedMeals(prev => prev.filter(m => m !== id))
  }
  const toggleShared = (id: Slot) => setSharedMeals(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id])
  /** A tap marks a dish as liked (and takes it off the old "не моё" list); a second tap unmarks it. */
  const toggleLike = (id: string) => {
    setLikedRecipes(prev => prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id])
    setDislikedRecipes(prev => prev.filter(v => v !== id))
  }
  const generate = () => {
    if (healthConsent && !allergies.trim() && !noAllergies) { setError('Укажи аллергию или подтверди, что её нет.'); return }
    try {
      const override = calorieOverride.trim() ? Number(calorieOverride) : null
      if (override !== null && (!Number.isInteger(override) || override < 1200 || override > 6000)) { setError('Укажи целое значение от 1200 до 6000 ккал.'); return }
      const calories = override ?? defaultCalories
      const budgetRub = budget.trim() ? Number(budget) : null
      const input: PlanInput = { days: Number.parseInt(days), calories, allergies, disliked, liked, goalLabel: goal, cookingMode, batchDays, ...(quick ? { quick } : {}), persons, selectedMeals, sharedMeals: persons > 1 ? sharedMeals : [], dietary: diet, likedRecipeIds: likedRecipes, dislikedRecipeIds: dislikedRecipes, budget: budgetRub, ...(targets && override === null ? { macros: { protein_g: targets.protein, fat_g: targets.fat, carbs_g: targets.carbs } } : {}) }
      setPlan(createMealPlan(input))
      setPlanInput(input); setIsSaved(false)
      setPlanMessage(''); setError(''); setView('result')
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось подобрать блюда.') }
  }
  const back = () => {
    setError('')
    if (view === 'form') return step === 0 ? onClose() : setStep(s => s - 1)
    if (view === 'review') return setView('form')
    if (view === 'result' && (showSaved || renew)) return onClose()
    setView('review')
  }
  if (view === 'loading') return <section className="meal-plan"><div className="meal-plan-heading"><h1>Весь рацион</h1><button className="link" onClick={onClose}>Назад</button></div>
    <p role="status">{planMessage || 'Открываем меню…'}</p></section>
  if (view === 'result' && dayIndex !== null && plan?.days[dayIndex] && planInput) {
    return <MealDay day={plan.days[dayIndex]} batch={planInput.cookingMode === 'batch'} error={error}
      onBack={() => { setDayIndex(null); setError('') }}
      options={index => replacementOptions(planInput, plan, dayIndex, index)}
      onPick={p => { setPlan(p); setIsSaved(false); setPlanMessage('') }} onClearError={() => setError('')}
      onRebuild={() => { try { setPlan(rebuildDay(planInput, plan, dayIndex)); setIsSaved(false) } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось пересобрать день.') } }} />
  }
  const snack = plan?.days.some(d => d.meals.some(m => m.meal === 'snack'))
  // the current plan still runs: the new one can follow it, so the last days are not lost
  const currentEnd = savedPlan?.start && !savedPlan.next_start ? shift(savedPlan.start, savedPlan.plan.days.length - 1) : null
  const monday = shift(today, ((8 - new Date(`${today}T12:00`).getDay()) % 7) || 7)
  const startOptions: [string, string][] = [
    ...(currentEnd && currentEnd >= today ? [[shift(currentEnd, 1), `После текущего, ${dayName(shift(currentEnd, 1))}`] as [string, string]] : []),
    [today, 'Сегодня'], [shift(today, 1), 'Завтра'], ...(monday !== shift(today, 1) ? [[monday, 'С понедельника'] as [string, string]] : []),
  ]
  return <div className="meal-plan">
    <div className="meal-plan-heading"><div>{view === 'form' && <span className="sub">Шаг {step + 1} из {flow.length}</span>}<h1>{view === 'result' ? 'Рацион' : view === 'review' ? 'Проверь ответы' : 'Подбор рациона'}</h1></div><button className="link" onClick={back}>Назад</button></div>
    {view === 'form' && <div className="meal-plan-progress" aria-hidden="true"><span style={{ width: `${(step + 1) * (100 / flow.length)}%` }} /></div>}
    <section className={view === 'result' ? 'meal-plan-result' : view === 'review' ? 'meal-review-page' : 'card meal-plan-card'}>
      {view === 'form' && current === 'days' && <><img src="/images/meal-planning.jpg" className="meal-q-food-image" alt="Пример сервировки блюд" />{savedPlan && <button className="btn btn-ghost meal-plan-next" onClick={() => openSavedPlan(savedPlan)}>Открыть сохранённый рацион</button>}<h2>На сколько дней составить рацион?</h2><div className="meal-q-range-card"><strong className="meal-q-budget-value">{days}</strong>
        <MealRange label="Срок рациона" min={0} max={dayOptions.length - 1} step={1} value={dayOptions.indexOf(days)} valueText={days} onChange={i => setDays(dayOptions[i])} />
        <div className="meal-q-range-labels">{dayOptions.map(v => <button key={v} type="button" className={days === v ? 'selected' : ''} aria-pressed={days === v} onClick={() => setDays(v)}>{v}</button>)}</div></div></>}
      {view === 'form' && current === 'goal' && <><h2>Какая у тебя цель?</h2><p className="sub">От неё зависит калорийность.</p><GoalPicker goal={goal} onGoal={setGoal} /></>}
      {view === 'form' && current === 'persons' && <><h2>Кто будет есть?</h2><p className="sub">Укажи общее число людей, включая тебя.</p><div className="meal-q-range-card"><strong className="meal-q-budget-value">{persons} {plural(persons, 'человек', 'человека', 'человек')}</strong><MealRange label="Количество человек" min={1} max={10} step={1} value={persons} onChange={setPersons} /><div className="meal-q-range-ends"><span>1</span><span>10</span></div></div></>}
      {view === 'form' && current === 'meals' && <><h2>Какие приёмы пищи включить?</h2><p className="sub">Выбери приёмы, затем отметь общие с семьёй.</p><div className="meal-q-meals">{MEALS.map(m => <div key={m.id}><button className="meal-q-meal" aria-pressed={selectedMeals.includes(m.id)} onClick={() => toggleMeal(m.id)}>{m.label}</button>{selectedMeals.includes(m.id) && <button className="meal-q-meal" aria-pressed={sharedMeals.includes(m.id)} onClick={() => toggleShared(m.id)}>Для всей семьи</button>}</div>)}</div></>}
      {view === 'form' && current === 'cooking' && <><h2>Как тебе удобнее готовить?</h2><p className="sub">Учтём это при выборе блюд и продуктов.</p><div className="meal-q-cooking">{COOKING.map(([id, title, hint]) => <button key={id} className="meal-q-option" aria-pressed={cookingMode === id} onClick={() => setCookingMode(id)}><span><strong>{title}</strong><small>{hint}</small></span></button>)}</div>{cookingMode === 'batch' && <><div className="meal-q-options">{([2, 7] as const).map(n => <button key={n} className="meal-plan-option" aria-pressed={batchDays === n} onClick={() => setBatchDays(n)}>На {n} {plural(n, 'день', 'дня', 'дней')}</button>)}</div><p className="sub">Готовишь два блюда сразу на {batchDays} {plural(batchDays, 'день', 'дня', 'дней')}: одно на обеды, другое на ужины.{batchDays === 7 ? ' Часть порций нужно заморозить, проверяй сроки хранения.' : ''}</p></>}
        <label className="meal-plan-confirm"><input type="checkbox" checked={quick} onChange={e => setQuick(e.target.checked)} /> Только быстрые блюда, до 30 минут</label></>}
      {view === 'form' && current === 'budget' && <BudgetStep persons={persons} budget={budget} currentSpend={currentSpend} limits={budgetLimits} onBudget={setBudget} onCurrent={setCurrentSpend} />}
      {view === 'form' && current === 'sex' && <><h2>Твой пол</h2><p className="sub">Нужен для расчёта нормы. Остальные данные можно заполнить в профиле.</p><div className="meal-q-options">{([{ id: 'female', label: 'Женский' }, { id: 'male', label: 'Мужской' }] as const).map(v => <button className="meal-q-option" aria-pressed={sex === v.id} key={v.id} onClick={() => setSex(v.id)}><strong>{v.label}</strong></button>)}</div></>}
      {view === 'form' && current === 'diet' && <><h2>Какой у тебя тип питания?</h2><p className="sub">Подберём подходящие блюда.</p><div className="meal-q-options">{DIETS.map(v => <button className="meal-q-option" aria-pressed={diet === v.id} key={v.id} onClick={() => setDiet(v.id)}><img className="meal-q-diet-photo" src={`/images/diets/${v.id}.jpg`} alt="" /><span><strong>{v.label}</strong><small>{v.description}</small></span></button>)}</div></>}
      {view === 'form' && current === 'tastes' && <><h2>Что тебе нравится?</h2><p className="sub">Отметь блюда, которые хочешь есть, и они будут чаще. Ряды листаются вбок. Можно пропустить.</p>
        {([['Завтраки', 'breakfast'], ['Обеды и ужины', 'main'], ['Перекусы', 'snack']] as const).map(([title, kind]) => (
          <section className="taste-group" key={title}><h3>{title}</h3>
            <div className="taste-row">{RECIPES.filter(r => fitsDiet(r, diet) && (kind === 'main' ? r.meal !== 'breakfast' && r.meal !== 'snack' : r.meal === kind)).map(r => {
              const on = likedRecipes.includes(r.id)
              return <button type="button" key={r.id} className="taste-tile" title={r.name} aria-pressed={on} onClick={() => toggleLike(r.id)}>
                <DishPhoto id={r.id} name={r.name} alt={`Пример блюда: ${r.name}`} />
                <span>{r.name}</span>{on && <i aria-hidden="true">✓</i>}
              </button>
            })}</div>
          </section>
        ))}
        {likedRecipes.length > 0 && <p className="sub taste-count" role="status">Отмечено: {likedRecipes.length}</p>}
        <label className="meal-plan-label">Что не ешь<textarea aria-label="Что не ешь" value={disliked} onChange={e => setDisliked(e.target.value)} placeholder="Например, грибы, рыба" /></label>
      </>}
      {view === 'review' && <>
        <section className="calorie-choice">
          <h2>Дневной ориентир</h2>
          <p className="calorie-number">{Number(calorieOverride || defaultCalories).toLocaleString('ru-RU')} <small>ккал</small></p>
          <MealRange label="Свой дневной ориентир, ккал" min={1200} max={6000} step={1}
            value={Number(calorieOverride || defaultCalories)} valueText={`${calorieOverride || defaultCalories} ккал`}
            onChange={n => setCalorieOverride(String(n))} />
          <div className="meal-q-range-ends"><span>1 200</span><span>6 000</span></div>
          <p className="sub">{targets ? `Дневной ориентир по профилю — ${targets.calories} ккал` : 'Примерный ориентир. Для личного расчёта заполни профиль.'}</p>
          {calorieOverride && <button className="link" onClick={() => setCalorieOverride('')}>Вернуть исходное значение</button>}
        </section>
        <section className="answer-group"><h2>Цель</h2><GoalPicker goal={goal} onGoal={g => { setGoal(g); setCalorieOverride('') }} /></section>
        <section className="answer-group"><h2>Аллергии</h2>
          {healthConsent ? <>
            <label className="meal-plan-label">Что нельзя есть совсем<textarea aria-label="Аллергии и ограничения" value={allergies} onChange={e => { setAllergies(e.target.value); setError('') }} placeholder="Например, арахис или молоко" /></label>
            {!allergies.trim() && <label className="meal-plan-confirm"><input type="checkbox" checked={noAllergies} onChange={e => setNoAllergies(e.target.checked)} /> У меня нет пищевой аллергии</label>}
          </> : <p className="sub">Чтобы указать аллергии, включи обработку данных о здоровье в профиле.</p>}
        </section>
        <AnswerGroup title="Твой план" entries={[
          ['Срок', days], ['Человек', String(persons)], ['Готовка', (cookingMode === 'daily' ? 'Раз в день' : cookingMode === 'batch' ? `На ${batchDays} ${plural(batchDays, 'день', 'дня', 'дней')}` : 'Разные блюда') + (quick ? ', быстрые блюда' : '')],
          ['Приёмы пищи', MEALS.filter(m => selectedMeals.includes(m.id)).map(m => m.label).join(', ')],
          ...(persons > 1 ? [['Общие с семьёй', MEALS.filter(m => sharedMeals.includes(m.id)).map(m => m.label).join(', ') || 'Нет']] : []),
        ]} />
        <AnswerGroup title="Вкусы" entries={[
          ['Тип питания', DIETS.find(d => d.id === diet)?.label ?? ''], ['Любимые блюда', likedRecipes.length ? `${likedRecipes.length} отмечено` : 'Не отмечены'],
          ...(liked ? [['Нравится', liked]] : []), ['Не ешь', disliked || 'Не указано'],
        ]} />
        <AnswerGroup title="Расходы в неделю" entries={[
          ['Бюджет', budget ? `${budget} ₽` : 'Без лимита'], ['Сейчас', currentSpend ? `${currentSpend} ₽ в неделю` : 'Не указано'],
        ]} />
        <p className="sub">{persons > 1 && 'Общие блюда рассчитываются одинаковыми порциями по твоей норме. '}{canEdit ? 'Ответы можно сохранить.' : 'В деморежиме ответы не сохраняются.'}</p>
        {saved && <p role="status">Ответы сохранены</p>}</>}
      {view === 'result' && plan && <>
        <div className="meal-result-intro"><h2>Рацион на {days}</h2><p>{`Ориентир — ${planInput?.calories ?? '—'} ккал в день`}</p>
          {plan.basketCostRub != null && <p className="plan-cost">Продукты ≈ {rub(plan.basketCostRub)} на весь срок{plan.days.length > 7 || persons > 1 ? ` · ≈ ${rub(plan.basketCostRub / plan.days.length * 7 / persons)} в неделю на человека` : ''}
            {plan.budgetRub != null && plan.basketCostRub <= plan.budgetRub && <span className="pos"> · в рамках бюджета</span>}
            {Number(currentSpend) > plan.basketCostRub / plan.days.length * 7 && <span className="pos"> · на {rub(Number(currentSpend) - plan.basketCostRub / plan.days.length * 7)} в неделю меньше, чем сейчас</span>}</p>}
          <div className="meal-result-disclaimer">Цены — обычные, без акций, по сайту сети «Магнит» ({PRICES_AS_OF}); в твоём магазине могут отличаться. Считаем целыми упаковками. {persons > 1 && 'Общие блюда рассчитаны на одинаковые порции по твоей норме. '}При аллергии проверяй состав и следы аллергенов.</div></div>
        {snack && <p className="sub">Добавили перекус: при {planInput?.calories} ккал три тарелки вышли бы слишком большими.</p>}
        {diet === 'vegan' && <p className="sub">Белок в растительном меню — из тофу, нута, чечевицы, маша, орехов и соевого протеина. Если протеин не нужен, напиши «протеин» в «Что не ешь».</p>}
        {plan.warnings.map(w => <p className="sub" key={w}>{w}</p>)}
        <div className="meal-result-section-head"><h2>Меню по дням</h2><span>{plan.days.length} {plural(plan.days.length, 'день', 'дня', 'дней')}</span></div>
        <div className="meal-result-days plan-days-list">{plan.days.map((day, index) => {
          // the dish that's new this day: with cooking for several days lunch repeats, and every row would show the same photo
          const before = plan.days[index - 1]?.meals.map(m => m.id) ?? []
          const featured = [day.meals.find(m => m.meal === 'lunch'), ...day.meals].find(m => m && !before.includes(m.id)) ?? day.meals.find(m => m.meal === 'lunch') ?? day.meals[0]
          return <button key={day.day} className="plan-day-link" aria-label={`Открыть день ${day.day}`} onClick={() => setDayIndex(index)}>
            {featured && <DishPhoto id={featured.id} name={featured.name} />}
            <span className="plan-day-copy"><strong>День {day.day}</strong>
              {day.meals.map(m => <small key={m.meal}>{labels[m.meal]}: {m.name}</small>)}
              <span>Б {day.totals.protein_g} · Ж {day.totals.fat_g} · У {day.totals.carbs_g} г</span>
            </span>
            <span className="plan-day-energy">≈ {day.totals.kcal}<small>ккал</small></span>
            <span className="plan-arrow" aria-hidden="true"><Chevron dir="right" /></span>
          </button>
        })}</div>
        <PlanShopping items={plan.shopping} canShare={canEdit} days={plan.days.length} />
      </>}
    </section>
    {error && <p role="alert">{error}</p>}
    {planMessage && <p role="status">{planMessage}</p>}
    {view === 'result' && canEdit && !isSaved && <div className="plan-start" role="radiogroup" aria-label="Начать рацион">
      <span className="sub">Начать</span>
      {startOptions.map(([day, label]) => <button key={day} className="chip" role="radio" aria-checked={(start || today) === day} onClick={() => setStart(day)}>{label}</button>)}
    </div>}
    {view === 'result' && canEdit && !isSaved && <button className="btn meal-plan-next" disabled={savingPlan} onClick={savePlan}>{savingPlan ? 'Сохраняем…' : 'Сохранить и использовать рацион'}</button>}
    {view === 'result' && canEdit && isSaved && plan && planInput && <button className="btn meal-plan-next" onClick={() => nextPlan(planInput, plan)}>Составить следующий рацион</button>}
    {view === 'result' && !canEdit && <p className="sub">В деморежиме рацион доступен до закрытия страницы. Чтобы сохранить, открой Nextly в своём аккаунте.</p>}
    {view === 'form' ? <button className="btn meal-plan-next" disabled={loading} onClick={next}>{step >= flow.length - 1 ? 'Посмотреть ответы' : 'Продолжить'}</button>
      : view === 'review' ? <><button className="btn meal-plan-next" onClick={generate}>Составить рацион</button>{canEdit && <button className="btn btn-ghost meal-plan-next" disabled={loadFailed} onClick={save}>Сохранить ответы</button>}<button className="btn btn-ghost meal-plan-next" onClick={() => { setSaved(false); setStep(0); setView('form') }}>Изменить ответы</button></>
      : <button className="btn btn-ghost meal-plan-next" onClick={() => setView('review')}>К ответам</button>}
  </div>
}

function GoalPicker({ goal, onGoal }: { goal: string; onGoal: (g: string) => void }) {
  return <div className="meal-q-range-card meal-q-goal"><strong className="meal-q-budget-value">{goal}</strong>
    <MealRange label="Цель" min={0} max={2} step={1} value={goalOptions.indexOf(goal)} valueText={goal} onChange={i => onGoal(goalOptions[i])} />
    <div className="meal-q-range-labels">{goalOptions.map(v => <button key={v} type="button" className={goal === v ? 'selected' : ''} aria-pressed={goal === v} onClick={() => onGoal(v)}>{v}</button>)}</div></div>
}

/** Per person per week: quick picks, the slider fine-tunes. */
const BUDGET_PRESETS = [{ label: 'Экономно', per: 2000 }, { label: 'Средне', per: 3500 }, { label: 'Свободно', per: 5500 }]

function BudgetStep({ persons, budget, currentSpend, limits, onBudget, onCurrent }: {
  persons: number; budget: string; currentSpend: string; limits: number[]
  onBudget: (v: string) => void; onCurrent: (v: string) => void
}) {
  // the scale follows the household: 10 000 ₽ a week per person, more if a saved answer was bigger
  const max = (i: number) => Math.max(persons * 10000, Math.min(limits[i], Math.ceil(Number(i ? currentSpend : budget) / 1000) * 1000))
  const b = Number(budget)
  return <>
    <h2>Бюджет на неделю</h2>
    <p className="sub">{persons > 1 ? `На всех, ${persons} чел.: подберём` : 'Подберём'} блюда под эту сумму. Можно пропустить.</p>
    <div className="budget-presets" role="group" aria-label="Готовые варианты">
      {BUDGET_PRESETS.map((p) => {
        const sum = p.per * persons
        return <button type="button" key={p.label} aria-pressed={b === sum} onClick={() => onBudget(String(sum))}><b>{p.label}</b><small>{rub(sum)}</small></button>
      })}
      <button type="button" aria-pressed={!budget} onClick={() => onBudget('')}><b>Без лимита</b><small>не важно</small></button>
    </div>
    <div className="meal-q-budget">
      <div className="budget-head">
        <b className="meal-q-budget-value">{budget ? rub(b) : 'Без лимита'}</b>
        {budget && <span className="sub">≈ {rub(Math.round(b / persons / 7 / 10) * 10)} в день{persons > 1 ? ' на человека' : ''}</span>}
      </div>
      <MealRange label="Желаемый бюджет" min={0} max={max(0)} step={100} value={b} valueText={budget ? `${budget} рублей` : 'Без лимита'} onChange={(n) => onBudget(n ? String(n) : '')} />
      <div className="q-slider-ends"><span>0 ₽</span><span>{rub(max(0))}</span></div>
    </div>
    <details className="budget-current" open={!!currentSpend || undefined}>
      <summary>Сколько тратишь сейчас? <small>необязательно: покажем, сколько сэкономишь</small></summary>
      <div className="budget-head"><b>{currentSpend ? rub(Number(currentSpend)) : 'Не указано'}</b></div>
      <MealRange label="Сколько тратишь сейчас" min={0} max={max(1)} step={100} value={Number(currentSpend)} valueText={currentSpend ? `${currentSpend} рублей` : 'Не указано'} onChange={(n) => onCurrent(n ? String(n) : '')} />
    </details>
  </>
}
