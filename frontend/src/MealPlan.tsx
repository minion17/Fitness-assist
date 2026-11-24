import { useEffect, useState } from 'react'
import { plural } from './plural'
import { api, putJson } from './telegram'
import { calculateTargets, type Goal, type ProfileData } from './profile'
import { createMealPlan, replaceMeal, type PlanInput, type MealPlan as GeneratedPlan } from './mealPrototype'
import MealRange from './MealRange'
import PlanShopping from './PlanShopping'
import './MealOverview.css'
import MealDay from './MealDay'
import { RECIPES } from './mealCatalog'
import { useBack } from './back'

type Preferences = { days: 1 | 3 | 7 | 14; goal: 'weight_loss' | 'maintenance' | 'mass_gain'; allergies: string; liked: string; disliked: string; budget: number | null; current_spend: number | null }
const DAYS: Record<number, string> = { 1: '1 день', 3: '3 дня', 7: '7 дней', 14: '14 дней' }
const GOALS: Record<Preferences['goal'], string> = { weight_loss: 'Снизить вес', maintenance: 'Поддерживать вес', mass_gain: 'Набрать вес' }
type Slot = 'breakfast' | 'lunch' | 'dinner'
type Diet = 'omnivore' | 'pescatarian' | 'vegetarian' | 'vegan'
const MEALS: { id: Slot; label: string; icon: string }[] = [{ id: 'breakfast', label: 'Завтрак', icon: '☕' }, { id: 'lunch', label: 'Обед', icon: '🥗' }, { id: 'dinner', label: 'Ужин', icon: '🍽️' }]
const DIETS: { id: Diet; label: string; icon: string; description: string }[] = [{id:'omnivore',label:'Всеядное',icon:'🍽️',description:'Ем разные продукты'}, {id:'pescatarian',label:'Пескетарианство',icon:'🐟',description:'Ем рыбу и морепродукты'}, {id:'vegetarian',label:'Вегетарианство',icon:'🥗',description:'Без мяса и рыбы'}, {id:'vegan',label:'Веганство',icon:'🌱',description:'Только растительная пища'}]
const recipeImage = (id: string) => `/images/recipes/${id}.jpg`
const dayOptions = Object.values(DAYS)
const goalOptions = Object.values(GOALS)
function AnswerGroup({ title, entries }: { title: string; entries: string[][] }) {
  return <section className="answer-group"><h2>{title}</h2><dl>
    {entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl></section>
}
const ALLERGIES: Record<string, string> = { dairy: 'молочное', eggs: 'яйца', gluten: 'глютен', nuts: 'орехи', fish: 'рыба' }

export default function MealPlan({ onClose, showSaved = false, canEdit = false, healthConsent = true, profile = null }: { onClose: () => void; showSaved?: boolean; canEdit?: boolean; healthConsent?: boolean; profile?: ProfileData | null }) {
  useBack(onClose)
  const [step, setStep] = useState(showSaved ? -1 : 0)
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
  const [plan, setPlan] = useState<ReturnType<typeof createMealPlan> | null>(null)
  const [planInput, setPlanInput] = useState<PlanInput | null>(null)
  const [savedPlan, setSavedPlan] = useState<{ input: PlanInput; plan: GeneratedPlan } | null>(null)
  const [planMessage, setPlanMessage] = useState('')
  const [savingPlan, setSavingPlan] = useState(false)
  const [calorieOverride, setCalorieOverride] = useState('')
  useEffect(() => {
    if (!canEdit) return
    let active = true
    api<{ input: PlanInput; plan: GeneratedPlan }>('/api/meal-plan').then(value => {
      if (!active) return
      if (value?.plan?.days && value.input) {
        setSavedPlan(value)
        if (showSaved) openSavedPlan(value)
      } else if (showSaved) setPlanMessage('Сохранённый рацион не найден.')
    }).catch(() => { if (active) setPlanMessage('Не удалось загрузить сохранённый рацион.') })
    return () => { active = false }
  }, [canEdit, healthConsent, showSaved])
  const savePlan = async () => {
    if (!plan || !planInput || savingPlan) return
    setSavingPlan(true); setPlanMessage('')
    try {
      const result = await api<{ input: PlanInput; plan: GeneratedPlan }>('/api/meal-plan', putJson({ input: planInput, plan }))
      if (!result) throw new Error()
      setSavedPlan(result); setPlanMessage('Рацион сохранён в твоём профиле.'); onClose()
    } catch { setPlanMessage('Не удалось сохранить рацион. Проверь подключение и согласие в профиле.') }
    finally { setSavingPlan(false) }
  }
  const openSavedPlan = (savedPlan: { input: PlanInput; plan: GeneratedPlan }) => {
    setPlan(savedPlan.plan); setPlanInput(savedPlan.input)
    setDays(DAYS[savedPlan.input.days] ?? `${savedPlan.input.days} ${plural(savedPlan.input.days, 'день', 'дня', 'дней')}`)
    setDiet(savedPlan.input.dietary ?? 'omnivore')
    setAllergies(healthConsent ? savedPlan.input.allergies : '')
    setNoAllergies(!savedPlan.input.allergies.trim())
    setDisliked(savedPlan.input.disliked); setLiked(savedPlan.input.liked)
    setCookingMode(savedPlan.input.cookingMode ?? 'daily'); setBatchDays(savedPlan.input.batchDays ?? 2)
    setPersons(savedPlan.input.persons ?? 1); setSelectedMeals([...(savedPlan.input.selectedMeals ?? ['breakfast', 'lunch', 'dinner'])]); setSharedMeals([...(savedPlan.input.sharedMeals ?? [])])
    setLikedRecipes(savedPlan.input.likedRecipeIds ?? []); setDislikedRecipes(savedPlan.input.dislikedRecipeIds ?? [])
    setCalorieOverride(String(savedPlan.input.calories))
    if (savedPlan.input.goalLabel && Object.values(GOALS).includes(savedPlan.input.goalLabel)) setGoal(savedPlan.input.goalLabel)
    setPlanMessage(''); setStep(12)
  }
  useEffect(() => {
    if (!canEdit) return
    let active = true
    api<Preferences>('/api/meal-preferences').then(data => {
      if (!active || !data) return
      if (showSaved) {
        setBudget(data.budget == null ? '' : String(data.budget))
        setCurrentSpend(data.current_spend == null ? '' : String(data.current_spend))
        setBudgetLimits([data.budget, data.current_spend].map(n => Math.max(30000, Math.ceil((n ?? 0) / 100) * 100)))
        setSex((data as Preferences & { sex?: 'male' | 'female' }).sex ?? profile?.sex ?? null)
        return
      }
      setDays(DAYS[data.days]); setGoal(GOALS[data.goal]); setAllergies(healthConsent ? data.allergies : '')
      const extra = data as Preferences & { persons?: number; selected_meals?: Slot[]; shared_meals?: Slot[]; sex?: 'male' | 'female' | null; dietary_type?: Diet; cooking_mode?: 'daily' | 'batch' | 'varied'; batch_days?: 2 | 7; liked_recipe_ids?: string[]; disliked_recipe_ids?: string[] }
      setPersons(extra.persons ?? 1); setSelectedMeals(extra.selected_meals ?? ['breakfast', 'lunch', 'dinner']); setSharedMeals(extra.shared_meals ?? [])
      setCookingMode(extra.cooking_mode ?? 'daily'); setBatchDays(extra.batch_days ?? 2); setSex(extra.sex ?? profile?.sex ?? null); setDiet(extra.dietary_type ?? 'omnivore'); setLikedRecipes(extra.liked_recipe_ids ?? []); setDislikedRecipes(extra.disliked_recipe_ids ?? [])
      setBudgetLimits([data.budget, data.current_spend].map(n => Math.max(30000, Math.ceil((n ?? 0) / 100) * 100)))
      setLiked(data.liked); setDisliked(data.disliked); setBudget(data.budget === null ? '' : String(data.budget)); setCurrentSpend(data.current_spend === null ? '' : String(data.current_spend))
    }).catch(() => { if (active) { setLoadFailed(true); setError('Не удалось загрузить сохранённые ответы. Попробуй открыть анкету позже.') } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [canEdit, healthConsent])
  const save = async () => {
    if (loadFailed) return
    const asNumber = (v: string) => v.trim() === '' ? null : Number(v)
    const body = { days: Number.parseInt(days), goal: Object.entries(GOALS).find(([, label]) => label === goal)?.[0], allergies: healthConsent ? allergies : '', liked, disliked, budget: asNumber(budget), current_spend: asNumber(currentSpend), persons, selected_meals: selectedMeals, shared_meals: persons > 1 ? sharedMeals : [], sex, dietary_type: diet, cooking_mode: cookingMode, batch_days: batchDays, liked_recipe_ids: likedRecipes, disliked_recipe_ids: dislikedRecipes }
    if ([body.budget, body.current_spend].some(n => n !== null && (!Number.isInteger(n) || n < 0 || n > 10000000))) { setError('Укажи бюджет целым числом от 0 до 10 000 000 ₽.'); return }
    setError(''); setSaved(false)
    try { const result = await api('/api/meal-preferences', putJson(body)); if (result === null) throw new Error(); setSaved(true) }
    catch { setError('Не удалось сохранить ответы. Проверь подключение и попробуй ещё раз.') }
  }
  const selectedGoal: Goal = goal === GOALS.weight_loss ? (profile?.goal === 'fat_loss' ? 'fat_loss' : 'weight_loss') : goal === GOALS.mass_gain ? (profile?.goal === 'muscle_gain' ? 'muscle_gain' : 'mass_gain') : 'maintenance'
  const targets = profile ? (selectedGoal === profile.goal && profile.targets && (!sex || sex === profile.sex) ? profile.targets : calculateTargets({ ...profile, sex: sex ?? profile.sex }, selectedGoal)) : null
  const defaultCalories = targets?.calories ?? (goal === GOALS.weight_loss ? 1800 : goal === GOALS.mass_gain ? 2200 : 2000)
  const next = () => {
    if (step === 3 && selectedMeals.length === 0) { setError('Выбери хотя бы один приём пищи.'); return }
    if (step === 2 && persons === 1) { setSelectedMeals(['breakfast', 'lunch', 'dinner']); setSharedMeals([]); setError(''); setStep(4); return }
    setError(''); setStep((s) => s + 1)
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
    if (!allergies.trim() && !noAllergies) { setError('Укажи аллергию или подтверди её отсутствие.'); return }
    try {
      const override = calorieOverride.trim() ? Number(calorieOverride) : null
      if (override !== null && (!Number.isInteger(override) || override < 1200 || override > 6000)) { setError('Укажи целое значение от 1200 до 6000 ккал.'); return }
      const calories = override ?? defaultCalories
      const input: PlanInput = { days: Number.parseInt(days), calories, allergies, disliked, liked, goalLabel: goal, cookingMode, batchDays, persons, selectedMeals, sharedMeals: persons > 1 ? sharedMeals : [], dietary: diet, likedRecipeIds: likedRecipes, dislikedRecipeIds: dislikedRecipes, ...(targets && override === null ? { macros: { protein_g: targets.protein, fat_g: targets.fat, carbs_g: targets.carbs } } : {}) }
      setPlan(createMealPlan(input))
      setPlanInput(input)
      setPlanMessage(''); setError(''); setStep(12)
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось подобрать блюда.') }
  }
  const changeMeal = (dayIndex: number, mealIndex: number) => {
    if (!plan || !planInput) return
    try {
      setPlan(replaceMeal(planInput, plan, dayIndex, mealIndex))
      setPlanMessage(''); setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось заменить блюдо.')
    }
  }
  const back = () => step === 0 || (showSaved && step === 12) ? onClose() : setStep((s) => s === 4 && persons === 1 ? 2 : s - 1)
  const visibleStep = step > 2 && persons === 1 ? step : step + 1
  const totalSteps = persons === 1 ? 10 : 11
  if (step === -1) return <section className="meal-plan"><div className="meal-plan-heading"><h1>Весь рацион</h1><button className="link" onClick={onClose}>Назад</button></div>
    <p role="status">{planMessage || 'Открываем меню…'}</p></section>
  if (step === 12 && dayIndex !== null && plan?.days[dayIndex]) {
    return <MealDay day={plan.days[dayIndex]} batch={planInput?.cookingMode === 'batch'} error={error}
      onBack={() => { setDayIndex(null); setError('') }}
      onReplace={index => changeMeal(dayIndex, index)} onClearError={() => setError('')} />
  }
  return <div className="meal-plan">
    <div className="meal-plan-heading"><div>{step < 11 && <span className="sub">ПИТАНИЕ · {Math.min(visibleStep, totalSteps)} / {totalSteps}</span>}<h1>{step === 12 ? 'Рацион' : step === 11 ? 'Твои ответы' : 'Подбор рациона'}</h1></div><button className="link" onClick={back}>Назад</button></div>
    {step < 11 && <div className="meal-plan-progress" aria-hidden="true"><span style={{ width: `${Math.min(visibleStep, totalSteps) * (100 / totalSteps)}%` }} /></div>}
    <section className={step === 12 ? 'meal-plan-result' : step === 11 ? 'meal-review-page' : 'card meal-plan-card'}>
      {step === 0 && <><img src="/images/meal-planning.jpg" className="meal-q-food-image" alt="Пример сервировки блюд" />{savedPlan && <button className="btn btn-ghost meal-plan-next" onClick={() => openSavedPlan(savedPlan)}>Открыть сохранённый рацион</button>}<h2>На сколько дней составить рацион?</h2><div className="meal-q-range-card"><strong className="meal-q-budget-value">{days}</strong>
        <MealRange label="Срок рациона" min={0} max={dayOptions.length - 1} step={1} value={dayOptions.indexOf(days)} valueText={days} onChange={i => setDays(dayOptions[i])} />
        <div className="meal-q-range-labels">{dayOptions.map(v => <button key={v} type="button" className={days === v ? 'selected' : ''} aria-pressed={days === v} onClick={() => setDays(v)}>{v}</button>)}</div></div></>}
      {step === 1 && <><h2>Какая у тебя цель?</h2><p className="sub">Это поможет подобрать направление питания.</p><div className="meal-q-range-card meal-q-goal"><strong className="meal-q-budget-value">{goal}</strong><MealRange label="Цель" min={0} max={2} step={1} value={goalOptions.indexOf(goal)} valueText={goal} onChange={i => setGoal(goalOptions[i])} /><div className="meal-q-range-labels">{goalOptions.map(v => <button key={v} type="button" className={goal === v ? 'selected' : ''} aria-pressed={goal === v} onClick={() => setGoal(v)}>{v}</button>)}</div></div></>}
      {step === 9 && <><h2>Есть аллергии или ограничения?</h2>{healthConsent ? <><p className="sub">Укажи продукты и ингредиенты, которые необходимо исключить.</p><label className="meal-plan-label">Аллергии и ограничения<textarea aria-label="Аллергии и ограничения" value={allergies} onChange={e => setAllergies(e.target.value)} placeholder="Например, арахис или молоко" /></label></> : <p className="sub">Чтобы указать аллергии, включи обработку данных о здоровье в профиле.</p>}</>}
      {step === 10 && <><h2>Что тебе нравится?</h2><p className="sub">Укажи любимые продукты и то, что не хочешь включать.</p><label className="meal-plan-label">Продукты, которые нравятся<textarea aria-label="Продукты, которые нравятся" value={liked} onChange={e => setLiked(e.target.value)} placeholder="Например, курица, гречка" /></label><label className="meal-plan-label">Что не нравится<textarea aria-label="Что не нравится" value={disliked} onChange={e => setDisliked(e.target.value)} placeholder="Например, грибы" /></label></>}
      {step === 2 && <><h2>Кто будет есть?</h2><p className="sub">Укажи общее число людей, включая тебя.</p><div className="meal-q-range-card"><strong className="meal-q-budget-value">{persons} {persons === 1 ? 'человек' : persons < 5 ? 'человека' : 'человек'}</strong><MealRange label="Количество человек" min={1} max={10} step={1} value={persons} onChange={setPersons} /><div className="meal-q-range-ends"><span>1</span><span>10</span></div></div></>}
      {step === 3 && <><h2>Какие приёмы пищи включить?</h2><p className="sub">Выбери приёмы, затем отметь общие с семьёй.</p><div className="meal-q-meals">{MEALS.map(m => <div key={m.id}><button className="meal-q-meal" aria-pressed={selectedMeals.includes(m.id)} onClick={() => toggleMeal(m.id)}>{m.icon} {m.label}</button>{persons > 1 && selectedMeals.includes(m.id) && <button className="meal-q-meal" aria-pressed={sharedMeals.includes(m.id)} onClick={() => toggleShared(m.id)}>Для всей семьи</button>}</div>)}</div></>}
      {step === 4 && <><h2>Как тебе удобнее готовить?</h2><p className="sub">Учтём это при выборе блюд и продуктов.</p><div className="meal-q-cooking">{([
        ['daily', '🍳', 'Готовить каждый день', 'Один основной продукт на обед и ужин'],
        ['batch', '🥡', 'На несколько дней', 'Повторяем блюда, чтобы приготовить порции заранее'],
        ['varied', '🥗', 'Разные блюда', 'Больше разнообразия в течение дня']
      ] as const).map(([id, icon, title, hint]) => <button key={id} className="meal-q-option" aria-pressed={cookingMode === id} onClick={() => setCookingMode(id)}><span className="meal-q-emoji">{icon}</span><span><strong>{title}</strong><small>{hint}</small></span></button>)}</div>{cookingMode === 'batch' && <><div className="meal-q-options">{([2, 7] as const).map(n => <button key={n} className="meal-plan-option" aria-pressed={batchDays === n} onClick={() => setBatchDays(n)}>На {n} {n === 2 ? 'дня' : 'дней'}</button>)}</div><p className="sub">Одинаковое основное блюдо повторяется на обед и ужин. Для недели часть порций может потребовать заморозки; проверяй сроки хранения каждого продукта.</p></>}</>}
      {step === 5 && <BudgetStep persons={persons} budget={budget} currentSpend={currentSpend} limits={budgetLimits} onBudget={setBudget} onCurrent={setCurrentSpend} />}
      {step === 6 && <><h2>Твой пол</h2><p className="sub">{profile ? 'Данные взяты из профиля и используются для расчёта.' : 'Укажи пол. Остальные данные для расчёта можно заполнить в профиле.'}</p><div className="meal-q-options">{([{id:'female',icon:'👩',label:'Женский'},{id:'male',icon:'👨',label:'Мужской'}] as const).map(v => <button className="meal-q-option" aria-pressed={sex === v.id} key={v.id} onClick={() => setSex(v.id)}><span className="meal-q-emoji">{v.icon}</span><strong>{v.label}</strong></button>)}</div></>}
      {step === 7 && <><h2>Какой у тебя тип питания?</h2><p className="sub">Подберём подходящие варианты.</p><div className="meal-q-options">{DIETS.map(v => <button className="meal-q-option" aria-pressed={diet === v.id} key={v.id} onClick={() => setDiet(v.id)}><img className="meal-q-diet-photo" src={`/images/diets/${v.id}.jpg`} alt="" /><span><strong>{v.label}</strong><small>{v.description}</small></span></button>)}</div></>}
      {step === 8 && <><h2>Что тебе нравится?</h2><p className="sub">Отметь блюда, которые хочешь есть, — чаще поставим их в рацион. Можно пропустить.</p>
        {([['Завтраки', RECIPES.filter((r) => r.meal === 'breakfast')], ['Обеды и ужины', RECIPES.filter((r) => r.meal !== 'breakfast')]] as const).map(([title, list]) => (
          <section className="taste-group" key={title}><h3>{title}</h3>
            <div className="taste-grid">{list.map((r) => {
              const on = likedRecipes.includes(r.id)
              return <button type="button" key={r.id} className="taste-tile" title={r.name} aria-pressed={on} onClick={() => toggleLike(r.id)}>
                <img src={recipeImage(r.id)} alt={`Пример блюда: ${r.name}`} loading="lazy" />
                <span>{r.name}</span>{on && <i aria-hidden="true">✓</i>}
              </button>
            })}</div>
          </section>
        ))}
        {likedRecipes.length > 0 && <p className="sub taste-count" role="status">Отмечено: {likedRecipes.length}</p>}
      </>}
      {step === 11 && <>
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
        <AnswerGroup title="Твой план" entries={[
          ['Срок', days], ['Цель', goal], ['Человек', String(persons)], ['Готовка', cookingMode === 'daily' ? 'Каждый день' : cookingMode === 'batch' ? `На ${batchDays} дн.` : 'Разные блюда'],
          ['Приёмы пищи', MEALS.filter(m => selectedMeals.includes(m.id)).map(m => m.label).join(', ')],
          ...(persons > 1 ? [['Общие с семьёй', MEALS.filter(m => sharedMeals.includes(m.id)).map(m => m.label).join(', ') || 'Нет']] : [])
        ]} />
        <AnswerGroup title="Вкусы и ограничения" entries={[
          ['Тип питания', DIETS.find(d => d.id === diet)?.label ?? ''], ['Аллергии', allergies || 'Не указаны'],
          ['Нравится', liked || 'Не указано'], ['Не нравится', disliked || 'Не указано']
        ]} />
        <AnswerGroup title="Расходы в неделю" entries={[
          ['Бюджет', budget ? `${budget} ₽` : 'Не указан'], ['Сейчас', currentSpend ? `${currentSpend} ₽ в неделю` : 'Не указано']
        ]} />
        <p className="sub">Цены пока не участвуют в подборе.{persons > 1 && ' Общие блюда рассчитываются одинаковыми порциями по твоей норме.'} {canEdit ? 'Ответы можно сохранить.' : 'В деморежиме ответы не сохраняются.'}</p>{!allergies.trim() && <label className="meal-plan-confirm"><input type="checkbox" checked={noAllergies} onChange={e => setNoAllergies(e.target.checked)} /> У меня нет пищевой аллергии</label>}{saved && <p role="status">Ответы сохранены</p>}</>}
      {step === 12 && plan && <>
        <div className="meal-result-intro"><span className="meal-result-kicker">ТВОЙ ПЛАН · ПРОБНАЯ ВЕРСИЯ</span><h2>Рацион на {days}</h2><p>{`Ориентир — ${planInput?.calories ?? '—'} ккал в день`}</p><div className="meal-result-disclaimer">Расчёты примерные. Общие блюда рассчитаны на одинаковые порции по твоей норме. При аллергии проверяй состав и следы аллергенов. Стоимость и бюджет пока не рассчитаны.</div></div>
        {diet === 'vegan' && <p className="sub">Растительное меню пока ограничено по разнообразию и источникам белка. Проверь состав рациона.</p>}{plan.warnings.filter(w => w.includes("калорийность") || w.includes("количество белков")).map(w => <p className="sub" key={w}>{w}</p>)}<div className="meal-result-section-head"><h2>Меню по дням</h2><span>{plan.days.length} дн.</span></div>
        <div className="meal-result-days plan-days-list">{plan.days.map((day, index) => {
          const featured = day.meals.find(m => m.meal === 'lunch') ?? day.meals[0]
          return <button key={day.day} className="plan-day-link" aria-label={`Открыть день ${day.day}`} onClick={() => setDayIndex(index)}>
            {featured && <img src={recipeImage(featured.id)} alt="" loading="lazy" />}
            <span className="plan-day-copy"><strong>День {day.day}</strong>
              {day.meals.map(m => <small key={m.meal}>{MEALS.find(slot => slot.id === m.meal)?.label} · {m.name}</small>)}
              <span>Б {day.totals.protein_g} · Ж {day.totals.fat_g} · У {day.totals.carbs_g} г</span>
            </span>
            <span className="plan-day-energy">≈ {day.totals.kcal}<small>ккал</small></span>
            <span className="plan-arrow" aria-hidden="true">›</span>
          </button>
        })}</div>
        <PlanShopping items={plan.shopping} canShare={canEdit} days={plan.days.length} />
      </>}
    </section>
    {error && <p role="alert">{error}</p>}
    {planMessage && <p role="status">{planMessage}</p>}
    {step === 12 && canEdit && <button className="btn meal-plan-next" disabled={savingPlan} onClick={savePlan}>{savingPlan ? 'Сохраняем…' : 'Сохранить и использовать рацион'}</button>}
    {step === 12 && !canEdit && <p className="sub">В деморежиме рацион доступен до закрытия страницы. Для сохранения открой SETLY в своём аккаунте.</p>}
    {step < 11 ? <button className="btn meal-plan-next" disabled={loading} onClick={next}>{step === 10 ? 'Посмотреть ответы' : 'Продолжить'}</button> : step === 11 ? <><button className="btn meal-plan-next" onClick={generate}>Составить рацион</button>{canEdit && <button className="btn btn-ghost meal-plan-next" disabled={loadFailed} onClick={save}>Сохранить ответы</button>}<button className="btn btn-ghost meal-plan-next" onClick={() => { setSaved(false); setStep(0) }}>Изменить ответы</button></> : <button className="btn btn-ghost meal-plan-next" onClick={() => setStep(11)}>К ответам</button>}
  </div>
}

/** Per person per week: quick picks, the slider fine-tunes. */
const BUDGET_PRESETS = [{ label: 'Экономно', per: 2000 }, { label: 'Средне', per: 3500 }, { label: 'Свободно', per: 5500 }]

function BudgetStep({ persons, budget, currentSpend, limits, onBudget, onCurrent }: {
  persons: number; budget: string; currentSpend: string; limits: number[]
  onBudget: (v: string) => void; onCurrent: (v: string) => void
}) {
  // the scale follows the household: 10 000 ₽ a week per person, more if a saved answer was bigger
  const max = (i: number) => Math.max(persons * 10000, Math.min(limits[i], Math.ceil(Number(i ? currentSpend : budget) / 1000) * 1000))
  const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`
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
      <summary>Сколько тратишь сейчас? <small>необязательно — покажем, сколько сэкономишь</small></summary>
      <div className="budget-head"><b>{currentSpend ? rub(Number(currentSpend)) : 'Не указано'}</b></div>
      <MealRange label="Сколько тратишь сейчас" min={0} max={max(1)} step={100} value={Number(currentSpend)} valueText={currentSpend ? `${currentSpend} рублей` : 'Не указано'} onChange={(n) => onCurrent(n ? String(n) : '')} />
    </details>
  </>
}
