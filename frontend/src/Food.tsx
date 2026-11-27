import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './food-date.css'
import Fasting from './Fasting'
import type { ProfileData, Targets } from './profile'
import AiMeal from './AiMeal'
import RecipeEditor, { type RecipeData } from './Recipe'
import MealPlan from './MealPlan'
import { RecipeCard } from './MealDay'
import type { Meal } from './mealPrototype'
import { shrink } from './image'
import type { FoodIntent } from './Home'
import { readBarcode } from './barcode'
import MenuImport from './MenuImport'
import Scanner from './Scanner'
import Calendar from './Calendar'
import { eaten, fits, localSearch, remember } from './catalog'
import { api, ApiError, postJson, putJson, publicGet } from './telegram'
import { MEALS, mealNow, type FoodDay, type FoodItem, type MealType, type Product } from './types'
import { emojiSrc, foodIcon } from './foodIcon'
import { FeedbackForm } from './Feedback'
import { applyWanted, defaultAmount, fmtQty, parseQuery, unitWord, unitsFor, type Unit, type Wanted } from './units'
import { Bar, Chevron, Ring, Sheet, Tip } from './ui'
import { plural } from './plural'
import { Icon } from './icons'
import { RECIPES } from './mealCatalog'
import DishPhoto, { dishPhoto } from './DishPhoto'
import { haptic } from './haptics'

const DEFAULT_GOALS: Targets = { calories: 2000, protein: 120, fat: 70, carbs: 230 }
// a rough split of the day for an empty meal's hint («≈ 550 ккал»)
// dishes from the meal plan are logged under the recipe's name: the diary shows their photo
const RECIPE_PHOTO = new Map(RECIPES.flatMap((r) => { const src = dishPhoto(r.id); return src ? [[r.name, src] as const] : [] }))

const MEAL_SHARE: Record<MealType, number> = { breakfast: 0.25, lunch: 0.35, dinner: 0.3, snack: 0.1 }

const MACROS = [
  { label: 'Белки', key: 'protein_g', goal: 'protein', color: 'var(--protein)' },
  { label: 'Жиры', key: 'fat_g', goal: 'fat', color: 'var(--fat)' },
  { label: 'Углеводы', key: 'carbs_g', goal: 'carbs', color: 'var(--carbs)' },
] as const

const r1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('ru-RU') // 35,5, not 35.5
type RecentProduct = Product & { last_amount_g: number; meals?: Partial<Record<MealType, number>> }
type TodayPlan = { finished: boolean; day?: number; upcoming?: string; next_start?: string | null; meals: (Meal & { completed: boolean; away?: boolean })[] }
const planDay = (day: string) => new Date(`${day}T12:00`).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })

const MEAL_TIME: Record<MealType, string> = { breakfast: '07:00', lunch: '13:00', dinner: '19:00', snack: '16:00' }
const nowSlot = () => new Date().toTimeString().slice(0, 5)

/** Breakfast, lunch, dinner always; each snack (by its start time) as its own card; all in time order. */
function mealGroups(day: FoodDay) {
  const groups = (['breakfast', 'lunch', 'dinner'] as MealType[]).map((meal) => ({
    key: meal as string, meal, slot: null as string | null, title: MEALS[meal], time: MEAL_TIME[meal],
    items: day.items.filter((i) => i.meal_type === meal),
  }))
  const snacks = new Map<string, FoodItem[]>()
  for (const i of day.items) if (i.meal_type === 'snack') snacks.set(i.snack_slot ?? '', [...(snacks.get(i.snack_slot ?? '') ?? []), i])
  for (const [slot, items] of snacks) {
    groups.push({ key: `snack-${slot}`, meal: 'snack', slot: slot || null, title: slot ? `Перекус ${slot}` : 'Перекус', time: slot || MEAL_TIME.snack, items })
  }
  return groups.sort((a, b) => a.time.localeCompare(b.time))
}

const GRAM: Unit = { label: 'г', g: 1 }
const ACTIONS_W = 148 // px revealed by a swipe: "Граммы" + "Удалить"

const LONG_PRESS_MS = 450

/** A diary line. Swipe left for "Граммы" / "Удалить"; a long press (or ⋯) opens the menu: amount, move, copy to today, delete.
 * Deleting doesn't ask: the toast offers "Отменить". */
function FoodRow({ item: i, canEdit, onDelete, onGrams, onMove, onCopyToday }: {
  item: FoodItem; canEdit: boolean; onDelete: (id: number) => Promise<void>; onGrams: (id: number, grams: number) => Promise<void>
  onMove?: (id: number, meal: MealType) => Promise<void>; onCopyToday?: (item: FoodItem) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopPress = () => { if (press.current) clearTimeout(press.current); press.current = null }
  const act = (run: () => Promise<void>) => { setBusy(true); run().then(() => setMenu(false)).catch(() => {}).finally(() => setBusy(false)) }
  const [drag, setDrag] = useState<number | null>(null) // live offset while the finger moves
  const [mode, setMode] = useState<'grams' | null>(null)
  const [grams, setGrams] = useState(String(i.amount_g))
  const start = useRef<{ x: number; y: number; base: number } | null>(null)
  const g = Number(grams.replace(',', '.'))
  const gramsOk = Number.isFinite(g) && g > 0 && g <= 5000

  if (mode === 'grams') return (
    <div className="row food-row-edit">
      <span className="food-icon" aria-hidden="true"><FoodEmoji e={foodIcon(i.product.name, i.product.category)} /></span>
      <div className="row-main"><div className="row-title">{i.product.name}</div>
        <div className="input-wrap grams-input"><input autoFocus inputMode="decimal" aria-label={`Граммы, ${i.product.name}`} value={grams}
          onChange={(e) => setGrams(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && gramsOk) onGrams(i.id, g).then(() => setMode(null)) }} /><i>г</i></div>
      </div>
      <div className="confirm">
        <button className="link" disabled={!gramsOk} onClick={() => onGrams(i.id, g).then(() => { setMode(null); setOpen(false) })}>Сохранить</button>
        <button className="link muted-link" onClick={() => setMode(null)}>Отмена</button>
      </div>
    </div>
  )

  const offset = drag ?? (open ? -ACTIONS_W : 0)
  return (
    <div className={i.id < 0 ? 'swipe pending' : 'swipe'} onContextMenu={(e) => { if (canEdit) e.preventDefault() }}>
      {canEdit && (
        <div className="swipe-actions" aria-hidden={!open}>
          <button tabIndex={open ? 0 : -1} onClick={() => { setGrams(String(i.amount_g)); setMode('grams') }}>Граммы</button>
          <button className="swipe-delete" tabIndex={open ? 0 : -1} onClick={() => { setOpen(false); onDelete(i.id).catch(() => {}) }}>Удалить</button>
        </div>
      )}
      <div className={`row swipe-front${drag === null ? '' : ' dragging'}`} style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={(e) => {
          if (!canEdit || mode !== null) return
          start.current = { x: e.clientX, y: e.clientY, base: open ? -ACTIONS_W : 0 }
          stopPress()
          press.current = setTimeout(() => { start.current = null; setDrag(null); setOpen(false); haptic('light'); setMenu(true) }, LONG_PRESS_MS)
        }}
        onPointerMove={(e) => {
          const s0 = start.current
          if (!s0) return
          const dx = e.clientX - s0.x
          if (Math.abs(dx) >= 8 || Math.abs(e.clientY - s0.y) >= 8) stopPress()
          if (drag === null && Math.abs(dx) < 8) return
          if (drag === null && Math.abs(e.clientY - s0.y) > Math.abs(dx)) { start.current = null; return } // a scroll, not a swipe
          setDrag(Math.max(-ACTIONS_W - 20, Math.min(0, s0.base + dx)))
        }}
        onPointerUp={() => { stopPress(); if (drag !== null) setOpen(drag < -ACTIONS_W / 2); setDrag(null); start.current = null }}
        onPointerCancel={() => { stopPress(); setDrag(null); start.current = null }}>
        {RECIPE_PHOTO.has(i.product.name)
          ? <img className="food-icon food-photo" src={RECIPE_PHOTO.get(i.product.name)} alt="" loading="lazy" />
          : <span className="food-icon" aria-hidden="true"><FoodEmoji e={foodIcon(i.product.name, i.product.category)} /></span>}
        <div className="row-main">
          <div className="row-title">{i.product.name}</div>
          <div className="row-sub">{i.unit && i.qty ? `${fmtQty(i.qty)} ${unitWord(i.unit, i.qty)} · ` : ''}{i.amount_g} г · Б {r1(i.protein_g)} · Ж {r1(i.fat_g)} · У {r1(i.carbs_g)}</div>
        </div>
        <div className="row-end">{Math.round(i.kcal)} ккал</div>
        {canEdit && <button className="icon-btn" aria-label={`Действия: ${i.product.name}`} aria-haspopup="dialog" onClick={() => { setOpen(false); setMenu(true) }}>⋯</button>}
      </div>
      {menu && (
        <Sheet title={i.product.name} onClose={() => setMenu(false)}>
          <p className="sub">{i.unit && i.qty ? `${fmtQty(i.qty)} ${unitWord(i.unit, i.qty)} · ` : ''}{i.amount_g} г · {Math.round(i.kcal)} ккал</p>
          <div className="food-menu">
              <button className="btn btn-ghost" onClick={() => { setMenu(false); setGrams(String(i.amount_g)); setMode('grams') }}>Изменить количество</button>
              {onMove && (
                <>
                  <span className="sub">Перенести в</span>
                  <div className="seg seg-3">
                    {(Object.keys(MEALS) as MealType[]).filter((m) => m !== i.meal_type).map((m) => (
                      <button type="button" key={m} disabled={busy} onClick={() => act(() => onMove(i.id, m))}>{MEALS[m]}</button>
                    ))}
                  </div>
                </>
              )}
              {onCopyToday && <button className="btn btn-ghost" disabled={busy} onClick={() => act(() => onCopyToday(i))}>Скопировать на сегодня</button>}
              <button className="btn btn-ghost danger" disabled={busy} onClick={() => act(() => onDelete(i.id))}>Удалить</button>
          </div>
        </Sheet>
      )}
    </div>
  )
}

const today = () => new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD in the phone's zone
const BACKFILL_DAYS = 30 // as on the server
function shiftDay(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`) // noon: a DST change can't push it into another day
  d.setDate(d.getDate() + n)
  return d.toLocaleDateString('sv-SE')
}
function dayLabel(iso: string): string {
  if (iso === today()) return 'Сегодня'
  if (iso === shiftDay(today(), -1)) return 'Вчера'
  return new Date(`${iso}T12:00:00`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })
}

const HISTORY_DAYS = 365 // how far back the diary can be viewed (written: BACKFILL_DAYS)

/** ‹ Сегодня › — arrows step a day, a tap on the label opens the month calendar. */
function DateBar({ date, onDate }: { date: string; onDate: (iso: string) => void }) {
  const [calendar, setCalendar] = useState(false)
  const max = today(), min = shiftDay(max, -HISTORY_DAYS)
  return (
    <div className="date-bar">
      <button className="icon-btn" aria-label="Предыдущий день" disabled={date <= min} onClick={() => onDate(shiftDay(date, -1))}><Chevron dir="left" /></button>
      <button className="date-label" aria-label={`${dayLabel(date)}: открыть календарь`} onClick={() => setCalendar(true)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
        <span>{dayLabel(date)}</span>
      </button>
      <button className="icon-btn" aria-label="Следующий день" disabled={date >= max} onClick={() => onDate(shiftDay(date, 1))}><Chevron dir="right" /></button>
      {calendar && <Calendar value={date} onPick={onDate} onClose={() => setCalendar(false)} />}
    </div>
  )
}

type Suggest = { kcal_left: number; protein_left: number; options: { title: string; idea?: boolean; items: { product_id: number; amount_g: number; unit?: string | null; qty?: number | null }[]; kcal: number; protein_g: number }[] }

/** Lunch and dinner time: the user's own past meals that fit what's left of today's norm. */
function WhatToEat({ eaten, onLog }: { eaten: number; onLog: (meal: MealType, items: Suggest['options'][0]['items']) => Promise<void> }) {
  const meal = mealNow()
  const key = `suggest-hidden-${today()}-${meal}`
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(key) === '1' } catch { return false } })
  const [s, setS] = useState<Suggest | null>(null)
  const [busy, setBusy] = useState(false)
  const show = !hidden
  useEffect(() => {
    if (show) api<Suggest>(`/api/suggest/meal?meal_type=${meal}`).then((r) => setS(r)).catch(() => {})
  }, [show, meal, eaten])
  if (!show || !s?.options.length) return null
  return (
    <section className="card suggest">
      <div className="card-head">
        <h2>Что съесть на {MEALS[meal].toLowerCase()}</h2>
        <button className="link" aria-label="Скрыть на сегодня" onClick={() => { setHidden(true); try { localStorage.setItem(key, '1') } catch { /* private mode */ } }}>✕</button>
      </div>
      <p className="sub">Осталось {s.kcal_left.toLocaleString('ru-RU')} ккал{s.protein_left > 10 ? ` и ${s.protein_left} г белка` : ''} — {s.options.some((o) => !o.idea) ? 'из твоих прошлых записей' : 'пара идей, пока мало истории'}:</p>
      <div className="list">
        {s.options.map((o) => (
          <button className="row row-btn" key={o.title} disabled={busy} onClick={() => { setBusy(true); onLog(meal, o.items).finally(() => setBusy(false)) }}>
            <div className="row-main"><div className="row-title">{o.title}</div><div className="row-sub">белок {Math.round(o.protein_g)} г</div></div>
            <div className="row-end result-kcal">{Math.round(o.kcal)} ккал<small>+ записать</small></div>
          </button>
        ))}
      </div>
    </section>
  )
}

/** Search answers for this session, by URL: typing back over the same letters needs no network. */
export default function Food({ day, date = today(), onDate, queued = 0, targets, canEdit, healthConsent = false, profile = null, onAdd, onDelete, onGrams = async () => {}, onMove, onCopyToday, aiEnabled = false, onAiDone = async () => {}, intent = null, onCopy = async () => {}, onLogSet, onSaved, onLogBatch, onPlanLogged = async () => {} }: {
  day: FoodDay
  date?: string // the day on screen, YYYY-MM-DD
  queued?: number // entries logged offline, waiting for the network
  onDate?: (iso: string) => void
  targets?: Targets
  canEdit: boolean
  healthConsent?: boolean
  profile?: ProfileData | null
  onAdd: (productId: number, grams: number, meal: MealType, slot?: string | null, counted?: { unit: string; qty: number }, name?: string) => Promise<(() => Promise<void>) | void>
  onDelete: (id: number) => Promise<void>
  onGrams?: (id: number, grams: number) => Promise<void>
  onMove?: (id: number, meal: MealType) => Promise<void>
  onCopyToday?: (item: FoodItem) => Promise<void>
  aiEnabled?: boolean
  onAiDone?: (xp: number) => Promise<void>
  intent?: FoodIntent | null // shortcut from Home: open the matching sheet right away
  onCopy?: (fromDay: string, meal: MealType) => Promise<void>
  onLogSet?: (setId: number, meal: MealType, slot: string | null) => Promise<void>
  onSaved?: (message: string) => void
  onLogBatch?: (meal: MealType, items: { product_id: number; amount_g: number }[]) => Promise<void>
  onPlanLogged?: () => Promise<void>
}) {
  const goals = targets ?? DEFAULT_GOALS
  const isToday = date === today()
  const editable = canEdit && date >= shiftDay(today(), -BACKFILL_DAYS) // older days: read only
  const [saving, setSaving] = useState<{ meal: MealType; slot?: string | null; name: string } | null>(null)
  const [saveError, setSaveError] = useState('')
  // ?open=plan (the bot's "send the list to the family chat" tip): straight to the saved plan
  const [planning, setPlanning] = useState<'new' | 'saved' | 'renew' | null>(() => ({ plan: 'saved', renew: 'renew' } as const)[new URLSearchParams(window.location.search).get('open') as 'plan' | 'renew'] ?? null)
  const [recipe, setRecipe] = useState<Meal | null>(null)
  const [todayPlan, setTodayPlan] = useState<TodayPlan | null>(null)
  const [planBusy, setPlanBusy] = useState<number | null>(null)
  const [planError, setPlanError] = useState('')
  const togglePlanMeal = async (index: number, completed: boolean, away = false) => {
    if (planBusy !== null) return
    setPlanBusy(index); setPlanError('')
    try {
      await api(`/api/meal-plan/today/${index}`, putJson({ completed, away }))
      await onPlanLogged()
      setTodayPlan(await api<TodayPlan>('/api/meal-plan/today'))
    } catch { setPlanError('Приём пищи не обновился: нет связи. Попробуй ещё раз') }
    finally { setPlanBusy(null) }
  }
  const [adding, setAdding] = useState<{ meal: MealType; slot?: string | null } | null>(intent === 'search' ? { meal: mealNow() } : null)
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [aiMode, setAiMode] = useState<'text' | 'photo' | null>(intent === 'search' ? null : intent)
  const [aiText, setAiText] = useState('')
  const t = day.totals
  const [before, setBefore] = useState<FoodDay | null>(null) // the day before the one on screen: "Как вчера"
  const [copying, setCopying] = useState<MealType | null>(null)
  const swipe = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!canEdit) return
    let stale = false
    api<FoodDay>(`/api/food-logs?day=${shiftDay(date, -1)}`).then((d) => { if (!stale) setBefore(d) }).catch(() => {})
    return () => { stale = true }
  }, [canEdit, date])

  useEffect(() => {
    if (!canEdit || planning) return
    let active = true
    api<TodayPlan>('/api/meal-plan/today').then(result => { if (active) { setTodayPlan(result && Array.isArray(result.meals) ? result : null); setPlanError('') } }).catch(() => { if (active) setPlanError('Нет связи. Рацион покажем, как только вернётся интернет') })
    return () => { active = false }
  }, [canEdit, planning, day])

  if (planning) return <MealPlan showSaved={planning === 'saved'} renew={planning === 'renew'} onClose={() => setPlanning(null)} canEdit={canEdit} healthConsent={healthConsent || !canEdit} profile={profile} />

  const groups = mealGroups(day)
  const firstSnack = groups.find(g => g.meal === 'snack')?.key
  const plannedSnack = isToday ? todayPlan?.meals.find(p => p.meal === 'snack') : undefined
  const plannedBlock = (planned: TodayPlan['meals'][number], title: string) => todayPlan && (planned.away ? <div className="planned-meal planned-away">
    <span className="sub">{title} по рациону — {planned.name}. Сегодня вне дома.</span>
    <button className="link" disabled={planBusy !== null} onClick={() => togglePlanMeal(todayPlan.meals.indexOf(planned), false)}>Вернуть</button>
  </div> : <><div className="planned-meal">
    <button className="planned-recipe-link" aria-label={`Открыть ${title} — ${planned.name}`} onClick={() => setRecipe(planned)}>
      <DishPhoto id={planned.id} name={planned.name} />
      <span className="planned-meal-info"><span className="plan-slot">{title}</span><strong>{planned.name}</strong><small>{Math.round(planned.nutrition.kcal)} ккал · Б {Math.round(planned.nutrition.protein_g)} · Ж {Math.round(planned.nutrition.fat_g)} · У {Math.round(planned.nutrition.carbs_g)}</small></span>
      <span className="plan-arrow" aria-hidden="true"><Chevron dir="right" /></span>
    </button>
    <button className={planned.completed ? 'planned-meal-check is-done' : 'planned-meal-check'} role="checkbox" aria-checked={planned.completed} aria-label={`${planned.completed ? 'Отменить' : 'Отметить'}: ${planned.name}`} disabled={planBusy !== null} onClick={() => togglePlanMeal(todayPlan.meals.indexOf(planned), !planned.completed)}>{planned.completed ? '✓' : ''}</button>
  </div>
  {!planned.completed && editable && <button className="link planned-away-link" disabled={planBusy !== null}
    onClick={async () => { await togglePlanMeal(todayPlan.meals.indexOf(planned), false, true); setAdding({ meal: planned.meal, ...(planned.meal === 'snack' ? { slot: nowSlot() } : {}) }) }}>
    Ем вне дома</button>}</>)

  const go = (n: number) => {
    const next = shiftDay(date, n)
    if (!onDate || next > today() || next < shiftDay(today(), -HISTORY_DAYS)) return
    haptic('select')
    setBefore(null)
    onDate(next)
  }

  return (
    <>
      <div className="food-head">
        <h1>Питание</h1>
      </div>
      <section className="card nutrition-summary"
        onPointerDown={(e) => { swipe.current = { x: e.clientX, y: e.clientY } }}
        onPointerUp={(e) => {
          const s0 = swipe.current
          swipe.current = null
          if (!s0 || !canEdit) return
          const dx = e.clientX - s0.x
          if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(e.clientY - s0.y)) go(dx > 0 ? -1 : 1) // swipe right = the day before
        }}>
        <div className="card-head nutrition-summary-head">
          <div className="nutrition-summary-title"><h2>{isToday ? 'КБЖУ за сегодня' : `КБЖУ · ${dayLabel(date)}`}</h2><span className="sub">{Math.round(t.kcal).toLocaleString('ru-RU')} / {goals.calories.toLocaleString('ru-RU')} ккал</span></div>
          {onDate && canEdit && <DateBar date={date} onDate={(d) => { setBefore(null); onDate(d) }} />}
        </div>
        <div className="ring-wrap">
          <Ring value={t.kcal} goal={goals.calories} />
          <div className="macros">
            {MACROS.map((m) => (
              <div key={m.key}>
                <div className={t[m.key] > goals[m.goal] * 1.1 && m.key !== 'protein_g' ? 'macro-row warn' : 'macro-row'}><span>{m.label}</span><span>{Math.round(t[m.key])} / {goals[m.goal]} г</span></div>
                <Bar value={t[m.key]} goal={goals[m.goal]} color={m.color} warnOver={m.key !== 'protein_g'} />
              </div>
            ))}
          </div>
        </div>
        {!targets && <span className="sub">Это средняя норма. Заполни анкету, и посчитаем твою.</span>}
        {isToday && targets?.day && targets.carbs_shift ? <span className="sub day-kind">{targets.day === 'training'
          ? `День тренировки: углеводов +${targets.carbs_shift} г — топливо для нагрузки.`
          : `День отдыха: углеводов ${targets.carbs_shift} г — за неделю норма та же.`}</span> : null}
      </section>
      {editable && onDate && <Tip id="days">Свайп вбок листает дни, дата сверху открывает календарь.</Tip>}
      {canEdit && !editable && <p className="sub">Дописать можно только последние {BACKFILL_DAYS} дней — этот день только для просмотра.</p>}
      {editable && (isToday
        ? <button className="food-search" onClick={() => setAdding({ meal: mealNow() })} aria-label={`Добавить продукт в «${MEALS[mealNow()]}»: поиск`}>
            <Icon name="search" /><span>Найти продукт или блюдо</span><span className="food-search-meal">{MEALS[mealNow()]}</span>
          </button>
        : <button className="btn nutrition-add" onClick={() => setAdding({ meal: 'dinner' })}>{`+ Дописать за ${dayLabel(date).toLowerCase()}`}</button>)}
      {canEdit && isToday && aiEnabled && (
        <div className="ai-row">
          <button className="btn btn-ghost" onClick={() => setAiMode('text')}>Текстом</button>
          <button className="btn btn-ghost" onClick={() => setAiMode('photo')}>Фото</button>
        </div>
      )}

      <section className="meal-diary">
      <h2>Приёмы пищи</h2>
      {editable && day.items.length > 0 && <Tip id="row-menu" after={onDate ? 'days' : undefined}>Зажми продукт, чтобы изменить или перенести. Смахни влево для быстрых действий.</Tip>}
      {queued > 0 && <p className="queued" role="status">Ждут связи: {queued} — отправим автоматически</p>}
      {isToday && todayPlan && !todayPlan.finished && !todayPlan.upcoming && <p className="sub plan-day-label">Рацион · день {todayPlan.day}. Отмечай съеденное.</p>}
      {isToday && todayPlan?.upcoming && <p className="sub plan-day-label">Рацион начнётся: {planDay(todayPlan.upcoming)}.</p>}
      {isToday && todayPlan?.finished && todayPlan.next_start && <p className="sub plan-day-label">Новый рацион начнётся: {planDay(todayPlan.next_start)}.</p>}
      {isToday && todayPlan?.finished && !todayPlan.next_start && editable && <div className="plan-finished">
        <p className="sub">Рацион закончился. Составим следующий с теми же настройками и новыми блюдами?</p>
        <button className="btn btn-ghost" onClick={() => setPlanning('renew')}>Составить следующий</button>
      </div>}
      {planError && <p className="error" role="alert">{planError}</p>}
      {groups.map(({ key, meal, slot, title, items }) => {
        const kcal = items.reduce((s, i) => s + i.kcal, 0)
        const main = meal !== 'snack'
        // the plan's snack sits with the first snack of the day, or on its own below when none is written yet
        const planned = isToday && (main || key === firstSnack) ? todayPlan?.meals.find(p => p.meal === meal) : undefined
        const shut = collapsed.includes(key)
        const repeat = main && items.length === 0 && before?.items.some((i) => i.meal_type === meal)
        return (
          <section className={items.length ? 'meal-group' : 'meal-group meal-empty'} key={key}>
            {planned && plannedBlock(planned, title)}
            <div className="meal-head">
              <button className="meal-toggle" aria-expanded={items.length ? !shut : undefined} disabled={!items.length}
                onClick={() => setCollapsed((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]))}>
                <h2>{title}</h2>
                {items.length > 0 && <span className="meal-kcal">{Math.round(kcal)} ккал</span>}
                {items.length > 0 && <span className="meal-chevron" aria-hidden="true"><Chevron /></span>}
                {!items.length && main && editable && targets && <span className="meal-hint">≈ {Math.round(goals.calories * MEAL_SHARE[meal] / 50) * 50} ккал</span>}
              </button>
              {editable && <button className="link meal-add" onClick={() => setAdding({ meal, slot })}>+ Добавить</button>}
            </div>
            {items.length > 0 && <div className="meal-totals">Б {Math.round(items.reduce((n, i) => n + i.protein_g, 0))} · Ж {Math.round(items.reduce((n, i) => n + i.fat_g, 0))} · У {Math.round(items.reduce((n, i) => n + i.carbs_g, 0))}</div>}
            {items.length > 0 && !shut && (
              <div className="list">
                {items.map((i) => (
                  <FoodRow key={i.id} item={i} canEdit={editable && i.id > 0} onDelete={onDelete} onGrams={onGrams} onMove={onMove} onCopyToday={isToday ? undefined : onCopyToday} />
                ))}
              </div>
            )}
            {editable && (items.length > 1 || repeat) && (
              <div className="meal-actions">
                {items.length > 1 && <button className="link" onClick={() => setSaving({ meal, slot, name: `Мой ${MEALS[meal].toLowerCase()}` })}>☆ В наборы</button>}
                {repeat && before && (
                  <button className="link meal-repeat" disabled={copying === meal}
                    onClick={() => { setCopying(meal); onCopy(before.date, meal).finally(() => setCopying(null)) }}>
                    ↻ {isToday ? 'Как вчера' : 'Как накануне'} · {Math.round(before.items.filter((i) => i.meal_type === meal).reduce((a, i) => a + i.kcal, 0))} ккал
                  </button>
                )}
              </div>
            )}
          </section>
        )
      })}
      {plannedSnack && !firstSnack && <section className="meal-group meal-empty">{plannedBlock(plannedSnack, 'Перекус')}</section>}
      {editable && <button className="link meal-snack" onClick={() => setAdding({ meal: 'snack', slot: isToday ? nowSlot() : null })}>+ Перекус</button>}
      </section>
      <button className="card meal-plan-entry" onClick={() => setPlanning(todayPlan ? 'saved' : 'new')}><span className="meal-plan-icon" aria-hidden="true"><Icon name="leaf" size={22} /></span><span className="meal-plan-text"><strong>{todayPlan ? 'Весь рацион' : 'Подбор рациона'}</strong><small>{todayPlan ? 'Меню по дням и список покупок' : 'По твоим предпочтениям'}</small></span><span className="meal-plan-go"><Chevron /></span></button>
      {canEdit && isToday && <Fasting protein={targets?.protein} refresh={day.items.length} />}
      {canEdit && isToday && targets && onLogBatch && <WhatToEat eaten={Math.round(day.totals.kcal)} onLog={onLogBatch} />}
      {!canEdit && <p className="sub">Демо-режим: чтобы вести дневник, открой приложение из Telegram.</p>}
      {recipe && <RecipeCard meal={recipe} onClose={() => setRecipe(null)} />}
      {aiMode && <AiMeal mode={aiMode} initialText={aiText} onClose={() => { setAiMode(null); setAiText('') }} onDone={onAiDone} />}
      {saving && (
        <Sheet title="Сохранить как набор" onClose={() => setSaving(null)}>
          <p className="sub">Весь «{MEALS[saving.meal]}» — одним нажатием в любой день: «+ Добавить» → «Наборы».</p>
          <div className="input-wrap"><input autoFocus aria-label="Название набора" maxLength={60} value={saving.name} onChange={(e) => setSaving({ ...saving, name: e.target.value })} /></div>
          {saveError && <p className="error" role="alert">{saveError}</p>}
          <button className="btn" disabled={!saving.name.trim()} onClick={() => {
            setSaveError('')
            api('/api/meal-sets', postJson({ name: saving.name, from_day: day.date || today(), meal_type: saving.meal, snack_slot: saving.slot }))
              .then(() => { setSaving(null); onSaved?.('Набор сохранён') })
              .catch((e) => setSaveError(e instanceof Error && e.message ? e.message : 'Не получилось сохранить'))
          }}>Сохранить</button>
        </Sheet>
      )}
      {adding && <AddFood meal={adding.meal} slot={adding.slot} dayTitle={isToday ? null : dayLabel(date)} kcalLeft={targets ? goals.calories - t.kcal : undefined} onClose={() => setAdding(null)} onAdd={onAdd} aiEnabled={aiEnabled && isToday} onLogSet={onLogSet}
        onAiText={(text) => { setAdding(null); setAiText(text); setAiMode('text') }} />}
    </>
  )
}

/** Same-named products together, the first (the plain one, ranked so by the server) shown, the rest behind "ещё N". */
const low = (s: string) => s.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')

/** Same product under different brands: «Молоко 2,5%» from five dairies is one line with «ещё 4 бренда». */
function groupKey(p: Product) {
  let n = low(p.name)
  if (p.brand) n = n.replace(low(p.brand), '')
  return n.replace(/(\d),(\d)/g, '$1.$2').replace(/[«»"'„“]/g, '').replace(/\s+/g, ' ').trim()
}

function groupByName(list: Product[]): [Product, Product[]][] {
  const groups = new Map<string, [Product, Product[]]>()
  for (const p of list) {
    const k = groupKey(p)
    const g = groups.get(k)
    if (g) g[1].push(p)
    else groups.set(k, [p, []])
  }
  return [...groups.values()]
}


/** The typed word starts in bold: the eye finds why a row is here. */
function Marked({ text, query }: { text: string; query: string }) {
  const words = low(query).split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 2)
  const name = low(text) // same length as text: ё → е and lower case keep every index
  const out: ReactNode[] = []
  let at = 0
  for (const m of name.matchAll(/[a-zа-я0-9]+/g)) {
    let len = 0
    for (const w of words) { let i = 0; while (i < w.length && w[i] === m[0][i]) i++; if (i >= Math.min(w.length, 3) || i === m[0].length) len = Math.max(len, i) }
    if (!len) continue
    out.push(text.slice(at, m.index), <b key={m.index}>{text.slice(m.index, m.index + len)}</b>)
    at = m.index + len
  }
  out.push(text.slice(at))
  return <>{out}</>
}

/** Several products at once: «гречка 150, курица 200, огурец». */
const splitMany = (q: string) => q.split(/[;\n]+|,(?!\d)/).map((x) => x.trim()).filter((x) => x.length >= 2) // «молоко 2,5%» stays one

const QUERIES = 'setly-queries'
function pastQueries(): string[] { try { return JSON.parse(localStorage.getItem(QUERIES) || '[]') } catch { return [] } }
function keepQuery(q: string) {
  const t = q.trim().toLocaleLowerCase('ru-RU')
  if (t.length < 2 || splitMany(t).length > 1) return
  try { localStorage.setItem(QUERIES, JSON.stringify([t, ...pastQueries().filter((x) => x !== t)].slice(0, 8))) } catch { /* private mode */ }
}

/** Portions offered right in a result row: tap one and it's added. */
function portionsFor(p: Product): { unit: Unit; qty: number }[] {
  const d = defaultAmount(p)
  return (d.unit.label === 'г' || d.unit.label === 'мл' ? [100, 150, 200, 300] : [0.5, 1, 2, 3]).map((qty) => ({ unit: d.unit, qty }))
}

type Rec = { lang: string; interimResults: boolean; start: () => void; stop: () => void; onend: () => void; onerror: () => void
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void }
// the system's own speech recognition, where the WebView has it (Chrome on Android does, Telegram's iOS view does not)
const Recognition = (globalThis as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec })
const Speech = Recognition.SpeechRecognition ?? Recognition.webkitSpeechRecognition

const searchCache = new Map<string, Product[]>()
/** Signed request also returns the user's own products; outside Telegram fall back to the public catalog. */
function findProducts(text: string, signal: AbortSignal, quiet = false) {
  const url = `/api/products/search?q=${encodeURIComponent(text)}${quiet ? '&quiet=1' : ''}`
  const hit = searchCache.get(url)
  if (hit) return Promise.resolve(hit) // backspace, or the same word again: no round trip
  return api<Product[]>(url, { signal }).then((r) => r ?? publicGet<Product[]>(url)).then((r) => {
    searchCache.set(url, r)
    if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value!)
    return r
  })
}

/** "яйцо 2": the number may be part of a name ("Творог 9%"), so the whole text is tried too — both at once, the whole one
 * wins when it finds something. Returns the rows and the amount they are for. */
async function searchQuery(q: string, signal: AbortSignal): Promise<{ items: Product[]; wanted: Wanted | null }> {
  const { text, wanted: w } = parseQuery(q)
  const [whole, stripped] = await Promise.all([
    w && w.unit ? null : findProducts(q.trim(), signal, Boolean(w)),
    w && text.length >= 2 ? findProducts(text, signal) : null,
  ])
  const r = whole?.length || !w ? whole : stripped
  return { items: r ?? [], wanted: r === stripped && w ? w : null }
}

type MealSetData = { id: number; name: string; items: { product_id: number; name: string; amount_g: number }[]; kcal: number }

/** Search and add; the sheet stays open for the next product of the meal ("Готово" closes it). */
function AddFood({ meal: initialMeal, slot = null, dayTitle = null, kcalLeft, onClose, onAdd, aiEnabled = false, onAiText, onLogSet }: {
  meal: MealType
  kcalLeft?: number // of the day's norm: each result shows what would be left after it
  slot?: string | null
  dayTitle?: string | null // a past day of the diary
  aiEnabled?: boolean
  onLogSet?: (setId: number, meal: MealType, slot: string | null) => Promise<void>
  onAiText?: (text: string) => void // nothing found: describe it to the AI instead
  onClose: () => void
  onAdd: (productId: number, grams: number, meal: MealType, slot?: string | null, counted?: { unit: string; qty: number }) => Promise<(() => Promise<void>) | void>
}) {
  const [meal, setMeal] = useState(initialMeal)
  const [q, setQ] = useState('')
  const [found, setFound] = useState<{ q: string; items: Product[] } | null>(null) // the server's answer, for the query it answered
  const [picked, setPicked] = useState<Product | null>(null)
  const [grams, setGrams] = useState('100') // the amount in `unit`
  const [unit, setUnit] = useState<Unit>(GRAM)
  const [wanted, setWanted] = useState<Wanted | null>(null) // an amount typed into the search
  const [openGroups, setOpenGroups] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [list, setList] = useState<'recent' | 'favorites' | 'mine'>('recent')
  const [sets, setSets] = useState<MealSetData[] | null>(null)
  const [recipes, setRecipes] = useState<RecipeData[] | null>(null)
  const [recipe, setRecipe] = useState<RecipeData | 'new' | null>(null)
  const [custom, setCustom] = useState<false | true | 'notFound' | 'fix'>(false) // fix: other numbers for an unverified product
  const [attach, setAttach] = useState<string | null>(null) // an unknown barcode to tie to a product found by name
  const [lastCode, setLastCode] = useState<string | null>(null) // unknown scanned code, linked to the custom product
  const [scan, setScan] = useState<'idle' | 'busy' | 'manual'>('idle')
  const [code, setCode] = useState('')
  const [scanner, setScanner] = useState(false)
  const [menuMode, setMenuMode] = useState(false)
  const [added, setAdded] = useState<{ name: string; kcal: number; undo?: () => Promise<void> }[]>([])
  const [portions, setPortions] = useState<number | null>(null) // product id: its portion choices are open
  const [many, setMany] = useState<{ q: string; items: { part: string; p: Product | null; qty: number; unit: Unit }[] } | null>(null)
  const [queries, setQueries] = useState(pastQueries)
  const [listening, setListening] = useState(false)
  const [justAdded, setJustAdded] = useState<number | null>(null) // product id: a brief ✓ on its "+"
  const search = useRef<HTMLInputElement>(null)
  const addedKcal = added.reduce((n, a) => n + a.kcal, 0)
  const [fromScan, setFromScan] = useState(false) // scanning in a row: after adding, the camera opens again
  const [reporting, setReporting] = useState<number | null>(null) // product id: the «wrong numbers» form is open

  /** "останется 1 650" / "сверх нормы на 120" for a portion of `kcal`. */
  function leftAfter(kcal: number) {
    if (kcalLeft === undefined) return null
    const rest = Math.round(kcalLeft - kcal)
    return <span className={rest < 0 ? 'left-after over' : 'left-after'}>{rest >= 0 ? `останется ${rest.toLocaleString('ru-RU')}` : `сверх нормы на ${(-rest).toLocaleString('ru-RU')}`}</span>
  }

  /** Added: stay in the sheet, back to an empty search for the next product. */
  function done(p: Product, grams: number, undo?: (() => Promise<void>) | void) {
    haptic('light')
    keepQuery(q); setQueries(pastQueries()); setPortions(null)
    setAdded((a) => [...a, { name: p.name, kcal: Math.round((p.kcal * grams) / 100), undo: undo || undefined }])
    setJustAdded(p.id)
    setTimeout(() => setJustAdded((id) => (id === p.id ? null : id)), 1200)
    setPicked(null); setQ(''); setFound(null); setWanted(null); setThanks('')
    if (fromScan) setTimeout(() => setScanner(true), 250)
    else setTimeout(() => search.current?.focus(), 0)
  }

  /** "+" on a row: the last amount for recent products, else what the row shows (typed amount, a piece, a portion, 100 g). */
  async function quickAdd(p: Product | RecentProduct, amount?: { unit: Unit; qty: number }) {
    if (busy) return
    const shown = amount ?? ('last_amount_g' in p ? { unit: GRAM, qty: Number(p.last_amount_g) } : (wanted && applyWanted(p, wanted)) || defaultAmount(p))
    const grams = Math.round(shown.qty * shown.unit.g * 10) / 10
    setBusy(true)
    setError('')
    try {
      const s = meal === 'snack' ? slot : null
      eaten(p); searchCache.clear() // «mine» first: the cached order is out of date
      const undo = await (shown.unit.label === 'г' ? onAdd(p.id, grams, meal, s) : onAdd(p.id, grams, meal, s, { unit: shown.unit.label, qty: shown.qty }))
      done(p, grams, undo)
    } catch { setError('Не добавилось. Попробуй ещё раз') }
    setBusy(false)
  }

  function openMine() {
    setList('mine')
    api<MealSetData[]>('/api/meal-sets').then((r) => setSets(r ?? [])).catch(() => setSets([]))
    api<RecipeData[]>('/api/recipes').then((r) => setRecipes(r ?? [])).catch(() => setRecipes([]))
  }

  async function logSet(id: number) {
    if (!onLogSet) return
    setBusy(true)
    const set = sets?.find((x) => x.id === id)
    try {
      await onLogSet(id, meal, meal === 'snack' ? slot : null)
      if (set) setAdded((a) => [...a, { name: set.name, kcal: Math.round(set.kcal) }])
    } catch { setError('Набор не добавился. Попробуй ещё раз') }
    setBusy(false)
  }
  const [thanks, setThanks] = useState('')
  const [checked, setChecked] = useState(false) // "Всё верно" given for the picked unverified product
  const [recent, setRecent] = useState<RecentProduct[] | null>(null)
  const [favorites, setFavorites] = useState<Product[] | null>(null)

  useEffect(() => {
    // kept on the phone too: offline, recent and favourites still work (the entry waits in the offline queue)
    const cached = <T,>(path: string, key: string, set: (v: T) => void) => api<T>(path)
      .then((v) => { set(v as T); try { if (v) localStorage.setItem(key, JSON.stringify(v)) } catch { /* private mode */ } })
      .catch(() => { try { const v = localStorage.getItem(key); if (v) set(JSON.parse(v)) } catch { /* nothing kept */ } })
    cached<RecentProduct[]>('/api/products/recent', 'setly-recent', setRecent)
    cached<Product[]>('/api/favorites', 'setly-favorites', setFavorites)
  }, [])

  // what this meal usually has comes first (newest first among equals: sort is stable)
  const recentForMeal = useMemo(() => recent && [...recent].sort((a, b) => (b.meals?.[meal] ?? 0) - (a.meals?.[meal] ?? 0)).slice(0, 20), [recent, meal])
  const isFav = picked != null && favorites?.some((f) => f.id === picked.id)
  async function toggleFav(p: Product) {
    const was = favorites?.some((f) => f.id === p.id)
    setFavorites((fs) => (was ? (fs ?? []).filter((f) => f.id !== p.id) : [p, ...(fs ?? [])])) // optimistic
    try { await api(`/api/favorites/${p.id}`, { method: was ? 'DELETE' : 'PUT' }) } catch { setError('Избранное не обновилось. Попробуй ещё раз') }
  }
  async function lookup(c: string) {
    setScan('busy')
    setError('')
    try {
      const p = await api<Product>(`/api/products/barcode/${c}`)
      if (p) { pick(p); setScan('idle'); return }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { setScan('idle'); setLastCode(c); setCustom('notFound'); return }
      setError(e instanceof ApiError ? e.message : 'Нет связи с Nextly. Попробуй через минуту')
    }
    setScan('manual')
  }
  async function onPhoto(file?: File) {
    if (!file) return
    setScan('busy')
    setError('')
    const c = await readBarcode(file).catch(() => null)
    if (c) return lookup(c)
    setError('Не получилось распознать штрихкод. Сфотографируй ближе и ровнее или введи цифры.')
    setScan('manual')
  }

  function pick(p: Product | RecentProduct) {
    if (attach) { // the unknown barcode goes with this product: for this user now, for everyone once others agree
      api(`/api/products/${p.id}/barcode`, postJson({ barcode: attach })).catch(() => {})
      setAttach(null)
      setThanks('Штрихкод привязан. В следующий раз сканер найдёт товар сразу.')
    }
    setChecked(false)
    setPicked(p)
    const typed = wanted && q.trim().length >= 2 ? applyWanted(p, wanted) : null // "яйцо 2" opens with 2 шт
    if (typed) { setUnit(typed.unit); setGrams(fmtQty(typed.qty)); return }
    if ('last_amount_g' in p) { setUnit(GRAM); setGrams(String(p.last_amount_g)); return }
    const d = defaultAmount(p)
    setUnit(d.unit); setGrams(fmtQty(d.qty))
  }

  function switchUnit(u: Unit) {
    // grams and ml keep the amount already typed; pieces, glasses and spoons start from one
    if (u.label === 'г') setGrams(String(Math.round(Number.isFinite(g) ? g : 100)))
    else if (u.label === 'мл') setGrams(String(Math.round((Number.isFinite(g) ? g : 200) / u.g)))
    else setGrams('1')
    setUnit(u)
  }

  const parts = splitMany(q)
  useEffect(() => {
    if (q.trim().length < 2) return
    const ctrl = new AbortController() // a newer letter cancels the request in flight
    const list = splitMany(q)
    const timer = setTimeout(async () => {
      try {
        if (list.length > 1) { // each part's best row, with the amount typed for it
          const items = await Promise.all(list.map(async (part) => {
            const r = await searchQuery(part, ctrl.signal)
            const p = r.items[0] ?? null
            const a = p ? (r.wanted && applyWanted(p, r.wanted)) || defaultAmount(p) : { unit: GRAM, qty: 0 }
            return { part, p, ...a }
          }))
          if (!ctrl.signal.aborted) setMany({ q, items })
          return
        }
        const r = await searchQuery(q, ctrl.signal)
        if (ctrl.signal.aborted) return
        setWanted(r.wanted)
        setFound({ q, items: r.items }); r.items.forEach(remember)
      } catch (e) { if (!ctrl.signal.aborted && !(e instanceof DOMException)) setError('Поиск недоступен. Проверь интернет') }
    }, 150) // wait for the user to stop typing
    return () => { ctrl.abort(); clearTimeout(timer) }
  }, [q])

  async function addMany() {
    if (!many || busy) return
    setBusy(true); setError('')
    const s = meal === 'snack' ? slot : null
    try {
      for (const { p, unit: u, qty: n } of many.items) {
        if (!p) continue
        const grams = Math.round(n * u.g * 10) / 10
        eaten(p)
        const undo = await (u.label === 'г' ? onAdd(p.id, grams, meal, s) : onAdd(p.id, grams, meal, s, { unit: u.label, qty: n }))
        setAdded((a) => [...a, { name: p.name, kcal: Math.round((p.kcal * grams) / 100), undo: undo || undefined }])
      }
      searchCache.clear(); haptic('light')
      setQ(''); setMany(null); setFound(null)
    } catch { setError('Добавилось не всё. Проверь список ниже') }
    setBusy(false)
  }

  async function undoLast() {
    const last = added[added.length - 1]
    if (!last) return
    setAdded((a) => a.slice(0, -1))
    try { await last.undo?.() } catch { setError('Не получилось отменить. Удали запись в дневнике') }
  }

  function listen() {
    if (!Speech) return
    const r = new Speech()
    r.lang = 'ru-RU'; r.interimResults = true
    // «гречка 150 и курица 200» said aloud: the «и» splits it into products, like a comma typed
    r.onresult = (e) => setQ(Array.from(e.results).map((x) => x[0].transcript).join(' ').replace(/\s+и\s+/g, ', '))
    r.onend = r.onerror = () => setListening(false)
    setListening(true); setError('')
    try { r.start() } catch { setListening(false) }
  }

  // the phone's own catalog answers at once; the server's results replace it when they arrive
  const local = useMemo(() => (q.trim().length >= 2 ? localSearch(parseQuery(q).text || q) : []), [q])
  // while the new answer loads: the phone's matches, else the last answer's rows that still fit (no «сгущёнка варёная» for «варенье»)
  const results = parts.length > 1 ? null : found?.q === q ? found.items : local.length ? local : found ? found.items.filter((p) => fits(p, parseQuery(q).text || q)) : null
  const typed = parseQuery(q).text || q.trim()
  const guessed = found?.q === q && results != null && results.length > 0 && !results.some((p) => fits(p, typed)) // typo fallback rows

  function resultRow(p: Product) {
    // everything for what the user would add: the amount typed ("яйцо 2"), else one piece / portion / 100 g
    const shown = (wanted && applyWanted(p, wanted)) || defaultAmount(p)
    const k = (shown.qty * shown.unit.g) / 100
    const kcal = Math.round(p.kcal * k)
    const amount = `${fmtQty(shown.qty)} ${unitWord(shown.unit.label, shown.qty)}`
    const open = portions === p.id
    return (
      <Fragment key={p.id}>
        <div className="row quick-row">
          <span className="food-icon" aria-hidden="true"><FoodEmoji e={foodIcon(p.name, p.category)} /></span>
          <button className="row-main row-btn-plain" onClick={() => pick(p)}>
            <div className="row-title"><Marked text={p.name} query={typed} /></div>
            {p.brand && <div className="row-brand">{p.brand}</div>}
            <div className="row-sub"><span className="macro-p">Б {r1(p.protein_g * k)}</span> · Ж {r1(p.fat_g * k)} · У {r1(p.carbs_g * k)}</div>
          </button>
          <button className="row-end result-kcal portion-toggle" aria-expanded={open} aria-label={`${kcal} ккал за ${amount}. Другая порция`}
            onClick={() => setPortions(open ? null : p.id)}>
            {kcal} ккал<small>{amount} <Chevron /></small>{leftAfter(kcal)}
          </button>
          {plusButton(p, amount)}
        </div>
        {open && (
          <div className="portion-row" role="group" aria-label={`Порция: ${p.name}`}>
            {portionsFor(p).map((o) => (
              <button type="button" key={o.qty} className="habit-chip" disabled={busy} onClick={() => quickAdd(p, o)}>
                {({ 0.5: '½' } as Record<number, string>)[o.qty] ?? o.qty} {o.unit.label}<small> · {Math.round((p.kcal * o.qty * o.unit.g) / 100)}</small>
              </button>
            ))}
          </div>
        )}
      </Fragment>
    )
  }

  function plusButton(p: Product, amount: string) {
    const ok = justAdded === p.id
    return (
      <button className={ok ? 'quick-add done' : 'quick-add'} disabled={busy} aria-label={`Добавить ${amount}: ${p.name}`} onClick={() => quickAdd(p)}>
        {ok ? '✓' : '+'}
      </button>
    )
  }

  const qty = Number(grams.replace(',', '.'))
  const g = Math.round(qty * unit.g * 10) / 10 // grams
  const valid = Number.isFinite(g) && g > 0 && g <= 5000

  async function add() {
    if (!picked || !valid) return
    setBusy(true)
    setError('')
    try {
      const s = meal === 'snack' ? slot : null
      eaten(picked); searchCache.clear()
      const undo = await (unit.label === 'г' ? onAdd(picked.id, g, meal, s) : onAdd(picked.id, g, meal, s, { unit: unit.label, qty }))
      done(picked, g, undo)
    } catch {
      setError('Не добавилось. Попробуй ещё раз')
    }
    setBusy(false)
  }

  return (
    <Sheet title={dayTitle ? `Дописать · ${dayTitle}` : 'Добавить продукт'} onClose={onClose}>
      <div className="seg seg-4">
        {(Object.keys(MEALS) as MealType[]).map((m) => (
          <button type="button" key={m} aria-pressed={meal === m} onClick={() => setMeal(m)}>{MEALS[m]}</button>
        ))}
      </div>

      {recipe && !picked ? (
        <RecipeEditor initial={recipe === 'new' ? null : recipe} onCancel={() => setRecipe(null)}
          onSaved={(p) => { setRecipe(null); setRecipes(null); pick(p) }} />
      ) : custom && !picked ? (
        <CustomProduct aiEnabled={aiEnabled} barcode={custom === 'notFound' || custom === 'fix' ? lastCode : null} fix={custom === 'fix'}
          onFind={custom === 'notFound' ? () => { setAttach(lastCode); setCustom(false); setError('') } : undefined}
          onCreated={(p) => {
            setCustom(false); setError('')
            setThanks(p.shared ? 'Спасибо! Продукт подтвердили другие, теперь он есть у всех. +25 XP.'
              : p.published ? 'Готово, теперь товар найдётся по штрихкоду у всех. Когда двое сверят цифры с упаковкой, тебе придёт +25 XP.'
              : custom === 'fix' ? 'Спасибо! Когда ещё кто-то внесёт те же цифры, они заменят прежние.' : '')
            pick(p)
          }} onCancel={() => { setCustom(false); setError('') }} />
      ) : menuMode && !picked ? (
        <MenuImport kcalLeft={kcalLeft} onPick={(p) => { setMenuMode(false); pick(p) }} onCancel={() => setMenuMode(false)} />
      ) : !picked ? (
        <>
          {attach && (
            <p className="sub attach-note">Найди товар по названию, и привяжем к нему штрихкод {attach}.{' '}
              <button type="button" className="link" onClick={() => setAttach(null)}>Отмена</button></p>
          )}
          <div className="input-wrap">
            <input autoFocus ref={search} placeholder="Поиск: гречка 150, курица 200" value={q} aria-label="Поиск продукта"
              onChange={(e) => { setQ(e.target.value); setError(''); setFromScan(false); if (e.target.value.trim().length < 2) { setFound(null); setMany(null) } }} />
            {Speech && <button type="button" className={listening ? 'mic on' : 'mic'} aria-label="Сказать голосом" aria-pressed={listening} onClick={listen}><Icon name="mic" /></button>}
          </div>
          {q.trim().length < 2 && queries.length > 0 && (
            <div className="query-chips" role="group" aria-label="Недавние запросы">
              {queries.map((x) => <button type="button" key={x} className="habit-chip" onClick={() => setQ(x)}>{x}</button>)}
            </div>
          )}
          {recent && (
            <div className="meal-actions">
              <button type="button" className="link" disabled={scan === 'busy'} onClick={() => { setError(''); setScanner(true) }}>
                {scan === 'busy' ? 'Ищем товар…' : '▥ Сканировать штрихкод'}
              </button>
              <button type="button" className="link" onClick={() => setCustom(true)}>+ Свой продукт</button>
              <button type="button" className="link" onClick={() => setRecipe('new')}>Рецепт</button>
              {aiEnabled && <button type="button" className="link" onClick={() => setMenuMode(true)}>Меню ресторана</button>}
            </div>
          )}
          {scan === 'manual' && (
            <div className="code-row">
              <div className="input-wrap">
                <input inputMode="numeric" placeholder="Цифры под штрихкодом" value={code} aria-label="Цифры штрихкода"
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 14))} />
              </div>
              <button className="btn btn-side" disabled={code.length < 8} onClick={() => lookup(code)}>Найти</button>
            </div>
          )}
          {q.trim().length < 2 && recent && favorites && (
            <>
              {recent.length > 0 && <Tip id="quick-add">«+» добавляет сразу, окно остаётся открытым.</Tip>}
              <div className="seg seg-inline">
                <button type="button" aria-pressed={list === 'recent'} onClick={() => setList('recent')}>Недавние</button>
                <button type="button" aria-pressed={list === 'favorites'} onClick={() => setList('favorites')}>Избранное</button>
                <button type="button" aria-pressed={list === 'mine'} onClick={openMine}>Наборы</button>
              </div>
              {list === 'mine' ? (
                <div className="list scroll-list">
                  {sets === null || recipes === null ? <p className="sub">Загружаем…</p> : sets.length + recipes.length === 0 ? (
                    <p className="sub">Наборы — то, что ты обычно ешь вместе. В дневнике под приёмом пищи нажми «☆ В наборы». Рецепт — своё блюдо из продуктов: «Рецепт» выше.</p>
                  ) : null}
                  {sets?.map((s) => (
                    <div className="row" key={`s${s.id}`}>
                      <button className="row-main row-btn-plain" disabled={busy} onClick={() => logSet(s.id)}>
                        <div className="row-title">☆ {s.name}</div>
                        <div className="row-sub">{s.items.map((i) => i.name).join(', ')}</div>
                      </button>
                      <span className="row-end">{Math.round(s.kcal)} ккал</span>
                      <button className="link" aria-label={`Удалить набор ${s.name}`} onClick={() => api(`/api/meal-sets/${s.id}`, { method: 'DELETE' }).then(() => setSets(sets.filter((x) => x.id !== s.id)))}>✕</button>
                    </div>
                  ))}
                  {recipes?.map((r) => (
                    <div className="row" key={`r${r.id}`}>
                      <button className="row-main row-btn-plain" onClick={() => pick(r)}>
                        <div className="row-title">{r.name}</div>
                        <div className="row-sub">{Math.round(r.kcal)} ккал на 100 г{r.portion_g ? ` · порция ${r.portion_g} г` : ''}</div>
                      </button>
                      <button className="link" aria-label={`Изменить рецепт ${r.name}`} onClick={() => setRecipe(r)}>✎</button>
                      <button className="link" aria-label={`Удалить рецепт ${r.name}`} onClick={() => api(`/api/recipes/${r.id}`, { method: 'DELETE' }).then(() => setRecipes(recipes.filter((x) => x.id !== r.id)))}>✕</button>
                    </div>
                  ))}
                </div>
              ) : (list === 'recent' ? recentForMeal! : favorites).length === 0 ? (
                <p className="sub">{list === 'recent' ? 'Здесь появятся твои недавние продукты.' : 'Отметь продукт звёздочкой, и он появится здесь.'}</p>
              ) : (
                <div className="list scroll-list">
                  {(list === 'recent' ? recentForMeal! : favorites).map((p, i, all) => {
                    const d = 'last_amount_g' in p ? { unit: GRAM, qty: Number(p.last_amount_g) } : defaultAmount(p)
                    const amount = `${fmtQty(d.qty)} ${unitWord(d.unit.label, d.qty)}`
                    const kcal = Math.round((p.kcal * d.qty * d.unit.g) / 100)
                    // what this meal usually has heads the list; the rest of the recent ones follow under their own line
                    const usual = (x: Product | RecentProduct) => 'meals' in x && (x.meals?.[meal] ?? 0) > 0
                    const head = list !== 'recent' ? null : i === 0 && usual(p) ? `Обычно на ${MEALS[meal].toLowerCase()}`
                      : !usual(p) && (i === 0 ? false : usual(all[i - 1])) ? 'Другие недавние' : null
                    return (
                      <Fragment key={p.id}>
                        {head && <p className="list-head">{head}</p>}
                        <div className="row quick-row">
                          <span className="food-icon" aria-hidden="true"><FoodEmoji e={foodIcon(p.name, p.category)} /></span>
                          <button className="row-main row-btn-plain" onClick={() => pick(p)}>
                            <div className="row-title">{p.name}</div>
                            <div className="row-sub">{amount} · {kcal} ккал{kcalLeft !== undefined && <> · {leftAfter(kcal)}</>}</div>
                          </button>
                          {plusButton(p, amount)}
                        </div>
                      </Fragment>
                    )
                  })}
                </div>
              )}
            </>
          )}
          {parts.length > 1 && (
            <div className="many">
              <p className="list-head">{parts.length} {plural(parts.length, 'продукт', 'продукта', 'продуктов')} одной строкой</p>
              {many?.q !== q ? <p className="sub">Ищем…</p> : (
                <div className="list">
                  {many.items.map(({ part, p, qty: n, unit: u }) => p ? (
                    <div className="row" key={part}>
                      <span className="food-icon" aria-hidden="true"><FoodEmoji e={foodIcon(p.name, p.category)} /></span>
                      <div className="row-main"><div className="row-title">{p.name}</div><div className="row-sub">{fmtQty(n)} {unitWord(u.label, n)}</div></div>
                      <span className="row-end">{Math.round((p.kcal * n * u.g) / 100)} ккал</span>
                    </div>
                  ) : <p className="sub" key={part}>«{part}» не нашли. Добавь его отдельно</p>)}
                </div>
              )}
              {many?.q === q && many.items.some((x) => x.p) && (() => {
                const n = many.items.filter((x) => x.p).length
                const kcal = many.items.reduce((t, x) => t + (x.p ? (x.p.kcal * x.qty * x.unit.g) / 100 : 0), 0)
                return <button className="btn" disabled={busy} onClick={addMany}>Добавить {n} {plural(n, 'продукт', 'продукта', 'продуктов')} · {Math.round(kcal)} ккал</button>
              })()}
            </div>
          )}
          {results && results.length === 0 && (
            <div className="not-found">
              <p className="row-title">Не нашли «{typed}»</p>
              <p className="sub">Проверь написание{typed.includes(' ') ? ' или ищи по одному слову' : ''}. Если продукта нет в базе, добавь его сам.</p>
              {typed.includes(' ') && <button className="link" onClick={() => setQ(typed.split(' ')[0])}>Искать «{typed.split(' ')[0]}»</button>}
              {aiEnabled && onAiText && <button className="btn" onClick={() => onAiText(q.trim())}>Описать AI: «{q.trim()}»</button>}
              <button className="btn btn-ghost" onClick={() => setCustom(true)}>{aiEnabled ? 'Сфоткать этикетку или ввести вручную' : '+ Добавить свой продукт'}</button>
              <button className="link" onClick={() => { setError(''); setScanner(true) }}>▥ Сканировать штрихкод</button>
            </div>
          )}
          {results && results.length > 0 && (
            <div className="list scroll-list">
              {guessed && <p className="list-head">Точно «{typed}» не нашли. Похожие:</p>}
              {groupByName(results).map(([first, rest]) => {
                const key = groupKey(first)
                const open = openGroups.includes(key)
                return (
                  <Fragment key={first.id}>
                    {resultRow(first)}
                    {rest.length > 0 && !open && (
                      <button className="link more-brands" onClick={() => setOpenGroups([...openGroups, key])}>
                        ещё {rest.length} {rest.every((r) => r.brand) ? plural(rest.length, 'бренд', 'бренда', 'брендов') : plural(rest.length, 'вариант', 'варианта', 'вариантов')}
                      </button>
                    )}
                    {open && rest.map(resultRow)}
                  </Fragment>
                )
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="row">
            <span className="food-icon" aria-hidden="true"><FoodEmoji e={foodIcon(picked.name, picked.category)} /></span>
            <div className="row-main">
              <div className="row-title">{picked.name}</div>
              <div className="row-sub">{picked.brand ?? ''}</div>
            </div>
            {favorites && (
              <button className={isFav ? 'icon-btn star on' : 'icon-btn star'} aria-pressed={isFav} aria-label="В избранное" onClick={() => toggleFav(picked)}>
                {isFav ? '★' : '☆'}
              </button>
            )}
            <button className="link" onClick={() => setPicked(null)}>Другой</button>
          </div>
          {thanks && <p className="sub pos">{thanks}</p>}
          {picked.unverified && !thanks && (
            <div className="unverified-note">
              <p className="sub">{checked ? 'Спасибо, учли! Когда цифры сверят ещё люди, товар станет проверенным.'
                : 'Товар добавил пользователь, цифры ещё не проверены. Сверь с упаковкой:'}</p>
              {!checked && <div className="meal-actions">
                <button className="link" onClick={() => { setChecked(true); api(`/api/products/${picked.id}/confirm`, { method: 'POST' }).catch(() => {}) }}>✓ Всё верно</button>
                <button className="link" onClick={() => { setLastCode(picked.barcode ?? null); setPicked(null); setCustom('fix') }}>Цифры другие? Исправить</button>
              </div>}
            </div>
          )}
          <label className="field">
            <span>Количество{unit.label !== 'г' && valid ? ` · ${fmtQty(g)} г` : ''}</span>
            <div className="input-wrap">
              <input inputMode="decimal" autoFocus aria-label="Количество" value={grams} onChange={(e) => setGrams(e.target.value)} />
              <i>{unit.label}</i>
            </div>
          </label>
          {unitsFor(picked).length > 1 && (
            <div className="unit-chips" role="group" aria-label="Единица">
              {unitsFor(picked).map((u) => (
                <button type="button" key={u.label} className="habit-chip" aria-pressed={u.label === unit.label} onClick={() => switchUnit(u)}>
                  {u.label}{u.label !== 'г' && u.label !== 'мл' && <small> · {fmtQty(u.g)} г</small>}
                </button>
              ))}
            </div>
          )}
          <div className="unit-chips amount-chips" role="group" aria-label="Быстрое количество">
            {(unit.label === 'г' || unit.label === 'мл' ? [50, 100, 150, 200, 300] : [0.5, 1, 1.5, 2, 3]).map((v) => (
              <button type="button" key={v} className="habit-chip" aria-pressed={qty === v} onClick={() => setGrams(fmtQty(v))}>
                {({ 0.5: '½', 1.5: '1½' } as Record<number, string>)[v] ?? v}
              </button>
            ))}
          </div>
          {valid && ( // what this amount is, big: it changes as the amount does
            <div className="amount-sum" aria-live="polite">
              <div className="amount-kcal"><strong>{Math.round((picked.kcal * g) / 100)}</strong> ккал{kcalLeft !== undefined && <small>{leftAfter((picked.kcal * g) / 100)}</small>}</div>
              <div className="amount-macros">
                <span className="macro-chip p"><b>{r1((picked.protein_g * g) / 100)}</b> белки</span>
                <span className="macro-chip f"><b>{r1((picked.fat_g * g) / 100)}</b> жиры</span>
                <span className="macro-chip c"><b>{r1((picked.carbs_g * g) / 100)}</b> углев.</span>
              </div>
            </div>
          )}
          <button className="btn" disabled={!valid || busy} onClick={add}>{busy ? 'Добавляем…' : `Добавить в «${MEALS[meal]}»`}</button>
          {reporting === picked.id
            ? <FeedbackForm kind="product" productId={picked.id} placeholder="Что не так: калории, белки, вес упаковки? Можно написать, как на этикетке" />
            : <button type="button" className="link product-report" onClick={() => setReporting(picked.id)}>Неверные КБЖУ? Сообщить</button>}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {added.length > 0 && (
        <div className="added-bar" role="status">
          <span><strong>Добавлено: {added.length}</strong><small>{addedKcal} ккал · {added.slice(-2).map((a) => a.name).join(', ')}{added.length > 2 ? '…' : ''}</small></span>
          {added[added.length - 1].undo && <button className="link" onClick={undoLast}>Отменить</button>}
          <button className="btn btn-side" onClick={onClose}>Готово</button>
        </div>
      )}
      {scanner && (
        <Scanner note={fromScan && added.length ? `Добавлено: ${added.length} · ${addedKcal} ккал — сканируй следующий` : undefined}
          onCode={(c) => { setScanner(false); setFromScan(true); lookup(c) }} onClose={() => { setScanner(false); setFromScan(false) }}
          onPhoto={(f) => { setScanner(false); onPhoto(f) }} onManual={() => { setScanner(false); setScan('manual') }} />
      )}
    </Sheet>
  )
}

type Label = { found: true; name: string; kcal: number; protein_g: number; fat_g: number; carbs_g: number; note: string
  brand?: string; package_g?: number | null; pieces?: number | null; liquid?: boolean } | { found: false; note: string }

function CustomProduct({ barcode, fix = false, aiEnabled, onCreated, onCancel, onFind }: {
  barcode: string | null; fix?: boolean; aiEnabled: boolean; onCreated: (p: Product & { shared?: boolean; published?: boolean }) => void
  onCancel: () => void; onFind?: () => void
}) {
  const [v, setV] = useState({ name: '', kcal: '', protein_g: '', fat_g: '', carbs_g: '', brand: '', portion_g: '', package_g: '', pieces: '' })
  const [liquid, setLiquid] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [hint, setHint] = useState('')
  const num = (x: string) => Number(x.replace(',', '.'))

  async function readLabel(file?: File) {
    if (!file) return
    setReading(true)
    setError('')
    setHint('')
    try {
      const form = new FormData()
      form.append('file', await shrink(file, 1600).catch(() => file), 'label.jpg')
      const r = await api<Label>('/api/ai/label', { method: 'POST', body: form })
      if (!r) return
      if (!r.found) { setError(r.note); return }
      const s = (n: number) => String(n).replace('.', ',')
      setV((old) => ({ ...old, name: old.name || r.name, kcal: s(r.kcal), protein_g: s(r.protein_g), fat_g: s(r.fat_g), carbs_g: s(r.carbs_g),
        brand: old.brand || r.brand || '', package_g: r.package_g ? s(r.package_g) : old.package_g, pieces: r.pieces ? String(r.pieces) : old.pieces }))
      if (r.liquid !== undefined) setLiquid(r.liquid)
      setHint(r.note || 'Проверь цифры с упаковкой и сохрани.')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось прочитать этикетку')
    } finally {
      setReading(false)
    }
  }
  const fields = [['kcal', 'Ккал', 900], ['protein_g', 'Белки, г', 100], ['fat_g', 'Жиры, г', 100], ['carbs_g', 'Углеводы, г', 100]] as const

  async function save() {
    if (v.name.trim().length < 2) return setError('Введи название')
    for (const [k, label, max] of fields) {
      const n = num(v[k])
      if (v[k] === '' || !Number.isFinite(n) || n < 0 || n > max) return setError(`${label}: от 0 до ${max}`)
    }
    if (num(v.protein_g) + num(v.fat_g) + num(v.carbs_g) > 100) return setError('Белков, жиров и углеводов вместе не больше 100 г')
    const portion = v.portion_g ? num(v.portion_g) : null
    if (portion !== null && !(portion > 0 && portion <= 3000)) return setError('Порция: от 1 до 3000 г')
    const pack = v.package_g ? num(v.package_g) : null
    if (pack !== null && !(pack > 0 && pack <= 3000)) return setError('Упаковка: от 1 до 3000 г')
    const pieces = v.pieces ? Math.round(num(v.pieces)) : 1
    if (!(pieces >= 1 && pieces <= 100)) return setError('Штук в упаковке: от 1 до 100')
    // a package of 6 × 50 g counts in pieces and as the whole pack; a single item is "1 упаковка"
    const units = pack === null ? {} : pieces > 1
      ? { piece_g: Math.round((pack / pieces) * 10) / 10, piece_name: 'шт', portion_g: pack, portion_name: 'упаковка' }
      : { piece_g: pack, piece_name: 'упаковка' }
    setBusy(true)
    try {
      searchCache.clear() // the new product must show up when searched again
      const p = await api<Product & { shared: boolean }>('/api/products', postJson({
        name: v.name, kcal: num(v.kcal), protein_g: num(v.protein_g), fat_g: num(v.fat_g), carbs_g: num(v.carbs_g),
        brand: v.brand.trim() || null, portion_g: portion, ...units, ...(liquid ? { ml_g: 1 } : {}), ...(barcode ? { barcode } : {}),
      }))
      if (p) onCreated(p)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не сохранилось. Попробуй ещё раз')
      setBusy(false)
    }
  }

  return (
    <>
      {barcode && !fix && <p className="row-title strong">Товара {barcode} пока нет в базе. Добавь его один раз, и он будет находиться по штрихкоду у всех.</p>}
      {barcode && !fix && <p className="xp-note"><b>+25 XP</b>, когда двое сверят цифры с упаковкой</p>}
      {fix && <p className="row-title strong">Внеси цифры с упаковки. Если ещё кто-то внесёт такие же, они заменят нынешние у всех.</p>}
      {onFind && <button type="button" className="link" onClick={onFind}>Он есть в поиске под своим названием? Найти и привязать штрихкод</button>}
      {!barcode && <p className="sub">Значения на 100 г, они есть на упаковке. Сначала продукт виден только тебе; когда ещё двое внесут те же цифры, он попадёт в общий каталог, а ты получишь <b>+25 XP</b>.</p>}
      {aiEnabled && (
        <label className={`btn ${barcode ? '' : 'btn-ghost '}photo-btn${reading ? ' disabled' : ''}`}>
          {reading ? 'Читаю этикетку…' : 'Сфоткать этикетку и заполнить'}
          <input type="file" accept="image/*" capture="environment" hidden disabled={reading}
            onChange={(e) => { readLabel(e.target.files?.[0]); e.target.value = '' }} />
        </label>
      )}
      {hint && <p className="sub pos">{hint}</p>}
      <label className="field">
        <span>Название</span>
        <div className="input-wrap"><input autoFocus value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></div>
      </label>
      <div className="grid2">
        {fields.map(([k, label]) => (
          <label className="field" key={k}>
            <span>{label}</span>
            <div className="input-wrap"><input inputMode="decimal" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></div>
          </label>
        ))}
      </div>
      <div className="grid2">
        <label className="field">
          <span>Бренд / заведение</span>
          <div className="input-wrap"><input value={v.brand} placeholder="необязательно" onChange={(e) => setV({ ...v, brand: e.target.value })} /></div>
        </label>
        {barcode ? (
          <label className="field">
            <span>Упаковка, {liquid ? 'мл' : 'г'}</span>
            <div className="input-wrap"><input inputMode="decimal" value={v.package_g} placeholder="необязательно" onChange={(e) => setV({ ...v, package_g: e.target.value })} /></div>
          </label>
        ) : (
          <label className="field">
            <span>Порция, г</span>
            <div className="input-wrap"><input inputMode="decimal" value={v.portion_g} placeholder="необязательно" onChange={(e) => setV({ ...v, portion_g: e.target.value })} /></div>
          </label>
        )}
      </div>
      {barcode && (
        <div className="grid2">
          <label className="field">
            <span>Штук внутри</span>
            <div className="input-wrap"><input inputMode="numeric" value={v.pieces} placeholder="1" onChange={(e) => setV({ ...v, pieces: e.target.value })} /></div>
          </label>
          <label className="consent-check liquid-check">
            <input type="checkbox" checked={liquid} onChange={(e) => setLiquid(e.target.checked)} />
            <span><b>Напиток</b><span className="sub">считать в мл</span></span>
          </label>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" disabled={busy} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить продукт'}</button>
      <button className="link" onClick={onCancel}>Назад к поиску</button>
    </>
  )
}

function FoodEmoji({ e }: { e: string }) {
  return <img className="food-emoji" src={emojiSrc(e)} alt="" draggable={false} />
}
