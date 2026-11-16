import { Fragment, useEffect, useRef, useState } from 'react'
import type { ProfileData, Targets } from './profile'
import AiMeal from './AiMeal'
import RecipeEditor, { type RecipeData } from './Recipe'
import MealPlan from './MealPlan'
import { shrink } from './image'
import type { FoodIntent } from './Home'
import { readBarcode } from './barcode'
import MenuImport from './MenuImport'
import Scanner from './Scanner'
import Calendar from './Calendar'
import { api, ApiError, postJson, publicGet, tg } from './telegram'
import { MEALS, mealNow, type FoodDay, type FoodItem, type MealType, type Product } from './types'
import { foodIcon } from './foodIcon'
import { applyWanted, defaultAmount, fmtQty, parseQuery, unitWord, unitsFor, type Unit, type Wanted } from './units'
import { Bar, Ring, Sheet, Chevron } from './ui'

const DEFAULT_GOALS: Targets = { calories: 2000, protein: 120, fat: 70, carbs: 230 }
const MACROS = [
  { label: 'Белки', key: 'protein_g', goal: 'protein', color: 'var(--protein)' },
  { label: 'Жиры', key: 'fat_g', goal: 'fat', color: 'var(--fat)' },
  { label: 'Углеводы', key: 'carbs_g', goal: 'carbs', color: 'var(--carbs)' },
] as const

const r1 = (n: number) => Math.round(n * 10) / 10
type RecentProduct = Product & { last_amount_g: number }

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

/** A diary line. Swipe left for "Граммы" / "Удалить"; a long press (or ⋯) opens the menu: amount, move, copy to today, delete. */
function FoodRow({ item: i, canEdit, onDelete, onGrams, onMove, onCopyToday }: {
  item: FoodItem; canEdit: boolean; onDelete: (id: number) => Promise<void>; onGrams: (id: number, grams: number) => Promise<void>
  onMove?: (id: number, meal: MealType) => Promise<void>; onCopyToday?: (item: FoodItem) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<'menu' | 'confirm' | null>(null)
  const [busy, setBusy] = useState(false)
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopPress = () => { if (press.current) clearTimeout(press.current); press.current = null }
  const act = (run: () => Promise<void>) => { setBusy(true); run().then(() => setMenu(null)).catch(() => {}).finally(() => setBusy(false)) }
  const [drag, setDrag] = useState<number | null>(null) // live offset while the finger moves
  const [mode, setMode] = useState<'grams' | 'confirm' | null>(null)
  const [grams, setGrams] = useState(String(i.amount_g))
  const start = useRef<{ x: number; y: number; base: number } | null>(null)
  const g = Number(grams.replace(',', '.'))
  const gramsOk = Number.isFinite(g) && g > 0 && g <= 5000

  if (mode === 'grams') return (
    <div className="row food-row-edit">
      <span className="food-icon" aria-hidden="true">{foodIcon(i.product.name, i.product.category)}</span>
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
    <div className="swipe" onContextMenu={(e) => { if (canEdit) e.preventDefault() }}>
      {canEdit && (
        <div className="swipe-actions" aria-hidden={!open}>
          <button tabIndex={open ? 0 : -1} onClick={() => { setGrams(String(i.amount_g)); setMode('grams') }}>Граммы</button>
          <button className="swipe-delete" tabIndex={open ? 0 : -1} onClick={() => setMode('confirm')}>Удалить</button>
        </div>
      )}
      <div className={`row swipe-front${drag === null ? '' : ' dragging'}`} style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={(e) => {
          if (!canEdit || mode !== null) return
          start.current = { x: e.clientX, y: e.clientY, base: open ? -ACTIONS_W : 0 }
          stopPress()
          press.current = setTimeout(() => { start.current = null; setDrag(null); setOpen(false); tg?.HapticFeedback?.impactOccurred?.('medium'); setMenu('menu') }, LONG_PRESS_MS)
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
        <span className="food-icon" aria-hidden="true">{foodIcon(i.product.name, i.product.category)}</span>
        <div className="row-main">
          <div className="row-title">{i.product.name}</div>
          <div className="row-sub">{i.unit && i.qty ? `${fmtQty(i.qty)} ${unitWord(i.unit, i.qty)} · ` : ''}{i.amount_g} г · Б {r1(i.protein_g)} · Ж {r1(i.fat_g)} · У {r1(i.carbs_g)}</div>
        </div>
        {mode === 'confirm' ? (
          <div className="confirm">
            <button className="link danger" onClick={() => onDelete(i.id)}>Удалить</button>
            <button className="link" onClick={() => { setMode(null); setOpen(false) }}>Отмена</button>
          </div>
        ) : (
          <>
            <div className="row-end">{Math.round(i.kcal)} ккал</div>
            {canEdit && <button className="icon-btn" aria-label={`Действия: ${i.product.name}`} aria-haspopup="dialog" onClick={() => { setOpen(false); setMenu('menu') }}>⋯</button>}
          </>
        )}
      </div>
      {menu && (
        <Sheet title={i.product.name} onClose={() => setMenu(null)}>
          <p className="sub">{i.unit && i.qty ? `${fmtQty(i.qty)} ${unitWord(i.unit, i.qty)} · ` : ''}{i.amount_g} г · {Math.round(i.kcal)} ккал</p>
          {menu === 'confirm' ? (
            <div className="food-menu">
              <button className="btn btn-danger" disabled={busy} onClick={() => act(() => onDelete(i.id))}>Да, удалить</button>
              <button className="btn btn-ghost" onClick={() => setMenu('menu')}>Отмена</button>
            </div>
          ) : (
            <div className="food-menu">
              <button className="btn btn-ghost" onClick={() => { setMenu(null); setGrams(String(i.amount_g)); setMode('grams') }}>Изменить количество</button>
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
              <button className="btn btn-ghost danger" onClick={() => setMenu('confirm')}>Удалить</button>
            </div>
          )}
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
      <button className="icon-btn" aria-label="Предыдущий день" disabled={date <= min} onClick={() => onDate(shiftDay(date, -1))}>‹</button>
      <button className="date-label" aria-label={`${dayLabel(date)}: открыть календарь`} onClick={() => setCalendar(true)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
        <span>{dayLabel(date)}</span>
      </button>
      <button className="icon-btn" aria-label="Следующий день" disabled={date >= max} onClick={() => onDate(shiftDay(date, 1))}>›</button>
      {calendar && <Calendar value={date} onPick={onDate} onClose={() => setCalendar(false)} />}
    </div>
  )
}

type Suggest = { kcal_left: number; protein_left: number; options: { title: string; items: { product_id: number; amount_g: number; unit?: string | null; qty?: number | null }[]; kcal: number; protein_g: number }[] }

/** Lunch and dinner time: the user's own past meals that fit what's left of today's norm. */
function WhatToEat({ eaten, onLog }: { eaten: number; onLog: (meal: MealType, items: Suggest['options'][0]['items']) => Promise<void> }) {
  const meal = mealNow()
  const key = `suggest-hidden-${today()}-${meal}`
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(key) === '1' } catch { return false } })
  const [s, setS] = useState<Suggest | null>(null)
  const [busy, setBusy] = useState(false)
  const show = !hidden && (meal === 'lunch' || meal === 'dinner')
  useEffect(() => {
    if (show) api<Suggest>(`/api/suggest/meal?meal_type=${meal}`).then((r) => setS(r)).catch(() => {})
  }, [show, meal, eaten])
  if (!show || !s?.options.length) return null
  return (
    <section className="card suggest">
      <div className="card-head">
        <h2>Что съесть на {meal === 'lunch' ? 'обед' : 'ужин'}</h2>
        <button className="link" aria-label="Скрыть на сегодня" onClick={() => { setHidden(true); try { localStorage.setItem(key, '1') } catch { /* private mode */ } }}>✕</button>
      </div>
      <p className="sub">Осталось {s.kcal_left} ккал{s.protein_left > 10 ? ` и ${s.protein_left} г белка` : ''} — из того, что вы ели раньше:</p>
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

export default function Food({ day, date = today(), onDate, targets, canEdit, healthConsent = false, profile = null, onAdd, onDelete, onGrams = async () => {}, onMove, onCopyToday, aiEnabled = false, onAiDone = async () => {}, intent = null, onCopy = async () => {}, onLogSet, onSaved, onLogBatch }: {
  day: FoodDay
  date?: string // the day on screen, YYYY-MM-DD
  onDate?: (iso: string) => void
  targets?: Targets
  canEdit: boolean
  healthConsent?: boolean
  profile?: ProfileData | null
  onAdd: (productId: number, grams: number, meal: MealType, slot?: string | null, counted?: { unit: string; qty: number }) => Promise<void>
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
}) {
  const goals = targets ?? DEFAULT_GOALS
  const isToday = date === today()
  const editable = canEdit && date >= shiftDay(today(), -BACKFILL_DAYS) // older days: read only
  const [saving, setSaving] = useState<{ meal: MealType; slot?: string | null; name: string } | null>(null)
  const [saveError, setSaveError] = useState('')
  const [planning, setPlanning] = useState(false)
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

  if (planning) return <MealPlan onClose={() => setPlanning(false)} canEdit={canEdit} healthConsent={healthConsent || !canEdit} profile={profile} />

  const go = (n: number) => {
    const next = shiftDay(date, n)
    if (!onDate || next > today() || next < shiftDay(today(), -HISTORY_DAYS)) return
    tg?.HapticFeedback?.selectionChanged()
    setBefore(null)
    onDate(next)
  }

  return (
    <>
      <div className="food-head">
        <h1>Питание</h1>
        {onDate && canEdit && <DateBar date={date} onDate={(d) => { setBefore(null); onDate(d) }} />}
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
        <div className="card-head"><h2>{isToday ? 'КБЖУ за сегодня' : `КБЖУ · ${dayLabel(date)}`}</h2><span className="sub">{Math.round(t.kcal)} / {goals.calories}</span></div>
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
        {!targets && <span className="sub">Ориентир по умолчанию — заполните анкету в профиле, чтобы получить свою норму.</span>}
      </section>
      {canEdit && !editable && <p className="sub">Дописать можно только последние {BACKFILL_DAYS} дней — этот день только для просмотра.</p>}
      {editable && <button className="btn nutrition-add" onClick={() => setAdding({ meal: isToday ? mealNow() : 'dinner' })}>{isToday ? '+ Добавить продукт' : `+ Дописать за ${dayLabel(date).toLowerCase()}`}</button>}
      {canEdit && isToday && aiEnabled && (
        <div className="ai-row">
          <button className="btn btn-ghost" onClick={() => setAiMode('text')}>✨ Текстом</button>
          <button className="btn btn-ghost" onClick={() => setAiMode('photo')}>📷 Фото</button>
        </div>
      )}

      <section className="meal-diary">
      <h2>Приёмы пищи</h2>
      {mealGroups(day).map(({ key, meal, slot, title, items }) => {
        const kcal = items.reduce((s, i) => s + i.kcal, 0)
        const main = meal !== 'snack'
        const shut = collapsed.includes(key)
        const repeat = main && items.length === 0 && before?.items.some((i) => i.meal_type === meal)
        return (
          <section className={items.length ? 'meal-group' : 'meal-group meal-empty'} key={key}>
            <div className="meal-head">
              <button className="meal-toggle" aria-expanded={items.length ? !shut : undefined} disabled={!items.length}
                onClick={() => setCollapsed((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]))}>
                <h2>{title}</h2>
                {items.length > 0 && <span className="meal-kcal">{Math.round(kcal)} ккал</span>}
                {items.length > 0 && <span className="meal-chevron" aria-hidden="true"><Chevron /></span>}
              </button>
              {editable && <button className="link meal-add" onClick={() => setAdding({ meal, slot })}>+ Добавить</button>}
            </div>
            {items.length > 0 && <div className="meal-totals">Б {Math.round(items.reduce((n, i) => n + i.protein_g, 0))} · Ж {Math.round(items.reduce((n, i) => n + i.fat_g, 0))} · У {Math.round(items.reduce((n, i) => n + i.carbs_g, 0))}</div>}
            {items.length > 0 && !shut && (
              <div className="list">
                {items.map((i) => (
                  <FoodRow key={i.id} item={i} canEdit={editable} onDelete={onDelete} onGrams={onGrams} onMove={onMove} onCopyToday={isToday ? undefined : onCopyToday} />
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
      {editable && <button className="link meal-snack" onClick={() => setAdding({ meal: 'snack', slot: isToday ? nowSlot() : null })}>+ Перекус</button>}
      </section>
      {canEdit && isToday && targets && onLogBatch && <WhatToEat eaten={Math.round(day.totals.kcal)} onLog={onLogBatch} />}
      <button className="card meal-plan-entry" onClick={() => setPlanning(true)}><span><strong>Подбор рациона</strong><small>По вашим предпочтениям</small></span><span>Открыть →</span></button>
      {!canEdit && <p className="sub">Демо-режим: чтобы вести дневник, откройте приложение из Telegram.</p>}
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
      {adding && <AddFood meal={adding.meal} slot={adding.slot} dayTitle={isToday ? null : dayLabel(date)} onClose={() => setAdding(null)} onAdd={onAdd} aiEnabled={aiEnabled && isToday} onLogSet={onLogSet}
        onAiText={(text) => { setAdding(null); setAiText(text); setAiMode('text') }} />}
    </>
  )
}

/** Same-named products together, the first (the plain one, ranked so by the server) shown, the rest behind "ещё N". */
function groupByName(list: Product[]): [Product, Product[]][] {
  const groups = new Map<string, [Product, Product[]]>()
  for (const p of list) {
    const k = p.name.toLowerCase()
    const g = groups.get(k)
    if (g) g[1].push(p)
    else groups.set(k, [p, []])
  }
  return [...groups.values()]
}

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many

type MealSetData = { id: number; name: string; items: { product_id: number; name: string; amount_g: number }[]; kcal: number }

/** Search and add; the sheet stays open for the next product of the meal ("Готово" closes it). */
function AddFood({ meal: initialMeal, slot = null, dayTitle = null, onClose, onAdd, aiEnabled = false, onAiText, onLogSet }: {
  meal: MealType
  slot?: string | null
  dayTitle?: string | null // a past day of the diary
  aiEnabled?: boolean
  onLogSet?: (setId: number, meal: MealType, slot: string | null) => Promise<void>
  onAiText?: (text: string) => void // nothing found: describe it to the AI instead
  onClose: () => void
  onAdd: (productId: number, grams: number, meal: MealType, slot?: string | null, counted?: { unit: string; qty: number }) => Promise<void>
}) {
  const [meal, setMeal] = useState(initialMeal)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Product[] | null>(null)
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
  const [custom, setCustom] = useState<false | true | 'notFound'>(false)
  const [lastCode, setLastCode] = useState<string | null>(null) // unknown scanned code, linked to the custom product
  const [scan, setScan] = useState<'idle' | 'busy' | 'manual'>('idle')
  const [code, setCode] = useState('')
  const [scanner, setScanner] = useState(false)
  const [menuMode, setMenuMode] = useState(false)
  const [added, setAdded] = useState<{ name: string; kcal: number }[]>([])
  const [justAdded, setJustAdded] = useState<number | null>(null) // product id: a brief ✓ on its "+"
  const search = useRef<HTMLInputElement>(null)
  const addedKcal = added.reduce((n, a) => n + a.kcal, 0)

  /** Added: stay in the sheet, back to an empty search for the next product. */
  function done(p: Product, grams: number) {
    setAdded((a) => [...a, { name: p.name, kcal: Math.round((p.kcal * grams) / 100) }])
    setJustAdded(p.id)
    setTimeout(() => setJustAdded((id) => (id === p.id ? null : id)), 1200)
    setPicked(null); setQ(''); setResults(null); setWanted(null); setThanks(false)
    setTimeout(() => search.current?.focus(), 0)
  }

  /** "+" on a row: the last amount for recent products, else what the row shows (typed amount, a piece, a portion, 100 g). */
  async function quickAdd(p: Product | RecentProduct) {
    if (busy) return
    const shown = 'last_amount_g' in p ? { unit: GRAM, qty: Number(p.last_amount_g) } : (wanted && applyWanted(p, wanted)) || defaultAmount(p)
    const grams = Math.round(shown.qty * shown.unit.g * 10) / 10
    setBusy(true)
    setError('')
    try {
      const s = meal === 'snack' ? slot : null
      await (shown.unit.label === 'г' ? onAdd(p.id, grams, meal, s) : onAdd(p.id, grams, meal, s, { unit: shown.unit.label, qty: shown.qty }))
      done(p, grams)
    } catch { setError('Не удалось добавить. Попробуйте ещё раз.') }
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
    } catch { setError('Не удалось добавить набор') }
    setBusy(false)
  }
  const [thanks, setThanks] = useState(false)
  const [recent, setRecent] = useState<RecentProduct[] | null>(null)
  const [favorites, setFavorites] = useState<Product[] | null>(null)

  useEffect(() => {
    api<RecentProduct[]>('/api/products/recent').then(setRecent).catch(() => {})
    api<Product[]>('/api/favorites').then(setFavorites).catch(() => {})
  }, [])

  const isFav = picked != null && favorites?.some((f) => f.id === picked.id)
  async function toggleFav(p: Product) {
    const was = favorites?.some((f) => f.id === p.id)
    setFavorites((fs) => (was ? (fs ?? []).filter((f) => f.id !== p.id) : [p, ...(fs ?? [])])) // optimistic
    try { await api(`/api/favorites/${p.id}`, { method: was ? 'DELETE' : 'PUT' }) } catch { setError('Не удалось обновить избранное') }
  }
  async function lookup(c: string) {
    setScan('busy')
    setError('')
    try {
      const p = await api<Product>(`/api/products/barcode/${c}`)
      if (p) { pick(p); setScan('idle'); return }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { setScan('idle'); setLastCode(c); setCustom('notFound'); return }
      setError(e instanceof ApiError ? e.message : 'Не удалось связаться с сервером')
    }
    setScan('manual')
  }
  async function onPhoto(file?: File) {
    if (!file) return
    setScan('busy')
    setError('')
    const c = await readBarcode(file).catch(() => null)
    if (c) return lookup(c)
    setError('Не получилось распознать штрихкод. Сфотографируйте ближе и ровнее или введите цифры.')
    setScan('manual')
  }

  function pick(p: Product | RecentProduct) {
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

  useEffect(() => {
    if (q.trim().length < 2) return
    let stale = false
    // signed request also returns the user's own products; outside Telegram fall back to the public catalog
    const find = (text: string, quiet = false) => {
      const url = `/api/products/search?q=${encodeURIComponent(text)}${quiet ? '&quiet=1' : ''}`
      return api<Product[]>(url).then((r) => r ?? publicGet<Product[]>(url))
    }
    const timer = setTimeout(async () => {
      try {
        // "яйцо 2": the number may be part of a name ("Творог 9%"), so the whole text goes first, then without the amount
        const { text, wanted: w } = parseQuery(q)
        let r = w && w.unit ? null : await find(q.trim(), Boolean(w))
        if (w && !r?.length && text.length >= 2) { r = await find(text); if (!stale) setWanted(w) } else if (!stale) setWanted(null)
        if (!stale) setResults(r ?? [])
      } catch { if (!stale) setError('Поиск недоступен — проверьте соединение') }
    }, 300) // wait for the user to stop typing
    return () => { stale = true; clearTimeout(timer) }
  }, [q])

  function resultRow(p: Product) {
    // calories for what the user would add: the amount typed ("яйцо 2"), else one piece / portion / 100 g
    const shown = (wanted && applyWanted(p, wanted)) || defaultAmount(p)
    const kcal = Math.round((p.kcal * shown.qty * shown.unit.g) / 100)
    return (
      <div className="row quick-row" key={p.id}>
        <button className="row-main row-btn-plain" onClick={() => pick(p)}>
          <div className="row-title">{p.name}</div>
          <div className="row-sub">{p.brand ? `${p.brand} · ` : ''}на 100 г: {Math.round(p.kcal)} ккал · Б {p.protein_g} · Ж {p.fat_g} · У {p.carbs_g}</div>
        </button>
        <div className="row-end result-kcal">{kcal} ккал<small>{fmtQty(shown.qty)} {unitWord(shown.unit.label, shown.qty)}</small></div>
        {plusButton(p, `${fmtQty(shown.qty)} ${unitWord(shown.unit.label, shown.qty)}`)}
      </div>
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
      await (unit.label === 'г' ? onAdd(picked.id, g, meal, s) : onAdd(picked.id, g, meal, s, { unit: unit.label, qty }))
      done(picked, g)
    } catch {
      setError('Не удалось добавить. Попробуйте ещё раз.')
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
        <CustomProduct aiEnabled={aiEnabled} barcode={custom === 'notFound' ? lastCode : null} onCreated={(p) => { setCustom(false); setError(''); setThanks(!!p.shared); pick(p) }} onCancel={() => { setCustom(false); setError('') }} />
      ) : menuMode && !picked ? (
        <MenuImport onPick={(p) => { setMenuMode(false); pick(p) }} onCancel={() => setMenuMode(false)} />
      ) : !picked ? (
        <>
          <div className="input-wrap">
            <input autoFocus ref={search} placeholder="Поиск: творог, гречка…" value={q}
              onChange={(e) => { setQ(e.target.value); setError(''); if (e.target.value.trim().length < 2) setResults(null) }} />
          </div>
          {recent && (
            <div className="meal-actions">
              <button type="button" className="link" disabled={scan === 'busy'} onClick={() => { setError(''); setScanner(true) }}>
                {scan === 'busy' ? 'Ищем товар…' : '▥ Сканировать штрихкод'}
              </button>
              <button type="button" className="link" onClick={() => setCustom(true)}>+ Свой продукт</button>
              <button type="button" className="link" onClick={() => setRecipe('new')}>🍲 Рецепт</button>
              {aiEnabled && <button type="button" className="link" onClick={() => setMenuMode(true)}>📷 Меню ресторана</button>}
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
              <div className="seg seg-inline">
                <button type="button" aria-pressed={list === 'recent'} onClick={() => setList('recent')}>Недавние</button>
                <button type="button" aria-pressed={list === 'favorites'} onClick={() => setList('favorites')}>Избранное</button>
                <button type="button" aria-pressed={list === 'mine'} onClick={openMine}>Наборы</button>
              </div>
              {list === 'mine' ? (
                <div className="list scroll-list">
                  {sets === null || recipes === null ? <p className="sub">Загружаем…</p> : sets.length + recipes.length === 0 ? (
                    <p className="sub">Наборы — то, что вы обычно едите вместе: в дневнике под приёмом пищи нажмите «☆ В наборы». Рецепт — своё блюдо из продуктов: «🍲 Рецепт» выше.</p>
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
                        <div className="row-title">🍲 {r.name}</div>
                        <div className="row-sub">{Math.round(r.kcal)} ккал на 100 г{r.portion_g ? ` · порция ${r.portion_g} г` : ''}</div>
                      </button>
                      <button className="link" aria-label={`Изменить рецепт ${r.name}`} onClick={() => setRecipe(r)}>✎</button>
                      <button className="link" aria-label={`Удалить рецепт ${r.name}`} onClick={() => api(`/api/recipes/${r.id}`, { method: 'DELETE' }).then(() => setRecipes(recipes.filter((x) => x.id !== r.id)))}>✕</button>
                    </div>
                  ))}
                </div>
              ) : (list === 'recent' ? recent : favorites).length === 0 ? (
                <p className="sub">{list === 'recent' ? 'Здесь появятся продукты, которые вы добавляли.' : 'Отметьте продукт звёздочкой — он появится здесь.'}</p>
              ) : (
                <div className="list scroll-list">
                  {(list === 'recent' ? recent : favorites).map((p) => {
                    const d = 'last_amount_g' in p ? { unit: GRAM, qty: Number(p.last_amount_g) } : defaultAmount(p)
                    const amount = `${fmtQty(d.qty)} ${unitWord(d.unit.label, d.qty)}`
                    const kcal = Math.round((p.kcal * d.qty * d.unit.g) / 100)
                    return (
                      <div className="row quick-row" key={p.id}>
                        <button className="row-main row-btn-plain" onClick={() => pick(p)}>
                          <div className="row-title">{p.name}</div>
                          <div className="row-sub">{amount} · {kcal} ккал</div>
                        </button>
                        {plusButton(p, amount)}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
          {results && results.length === 0 && (
            <div className="not-found">
              <p className="row-title">Не нашли «{parseQuery(q).text || q.trim()}»</p>
              {aiEnabled && onAiText && <button className="btn" onClick={() => onAiText(q.trim())}>✨ Описать AI: «{q.trim()}»</button>}
              <button className="btn btn-ghost" onClick={() => setCustom(true)}>{aiEnabled ? '📷 Сфоткать этикетку или ввести вручную' : '+ Добавить свой продукт'}</button>
              <button className="link" onClick={() => { setError(''); setScanner(true) }}>▥ Сканировать штрихкод</button>
            </div>
          )}
          {results && results.length > 0 && (
            <div className="list scroll-list">
              {groupByName(results).map(([first, rest]) => {
                const key = first.name.toLowerCase()
                const open = openGroups.includes(key)
                return (
                  <Fragment key={first.id}>
                    {resultRow(first)}
                    {rest.length > 0 && !open && (
                      <button className="link more-brands" onClick={() => setOpenGroups([...openGroups, key])}>
                        ещё {rest.length} {plural(rest.length, 'вариант', 'варианта', 'вариантов')} ›
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
          {thanks && <p className="sub pos">Спасибо! Этот продукт подтвердили и другие — теперь он доступен всем, а вам +25 XP.</p>}
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
          {valid && (
            <p className="sub">
              {Math.round((picked.kcal * g) / 100)} ккал · Б {r1((picked.protein_g * g) / 100)} · Ж {r1((picked.fat_g * g) / 100)} · У {r1((picked.carbs_g * g) / 100)}
            </p>
          )}
          <button className="btn" disabled={!valid || busy} onClick={add}>{busy ? 'Добавляем…' : `Добавить в «${MEALS[meal]}»`}</button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {added.length > 0 && (
        <div className="added-bar" role="status">
          <span><strong>✓ Добавлено: {added.length}</strong><small>{addedKcal} ккал · {added.slice(-2).map((a) => a.name).join(', ')}{added.length > 2 ? '…' : ''}</small></span>
          <button className="btn btn-side" onClick={onClose}>Готово</button>
        </div>
      )}
      {scanner && (
        <Scanner onCode={(c) => { setScanner(false); lookup(c) }} onClose={() => setScanner(false)}
          onPhoto={(f) => { setScanner(false); onPhoto(f) }} onManual={() => { setScanner(false); setScan('manual') }} />
      )}
    </Sheet>
  )
}

type Label = { found: true; name: string; kcal: number; protein_g: number; fat_g: number; carbs_g: number; note: string
  brand?: string; package_g?: number | null; pieces?: number | null; liquid?: boolean } | { found: false; note: string }

function CustomProduct({ barcode, aiEnabled, onCreated, onCancel }: {
  barcode: string | null; aiEnabled: boolean; onCreated: (p: Product & { shared?: boolean }) => void; onCancel: () => void
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
      setHint(r.note || 'Проверьте цифры с упаковкой и сохраните.')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось прочитать этикетку')
    } finally {
      setReading(false)
    }
  }
  const fields = [['kcal', 'Ккал', 900], ['protein_g', 'Белки, г', 100], ['fat_g', 'Жиры, г', 100], ['carbs_g', 'Углеводы, г', 100]] as const

  async function save() {
    if (v.name.trim().length < 2) return setError('Введите название')
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
      const p = await api<Product & { shared: boolean }>('/api/products', postJson({
        name: v.name, kcal: num(v.kcal), protein_g: num(v.protein_g), fat_g: num(v.fat_g), carbs_g: num(v.carbs_g),
        brand: v.brand.trim() || null, portion_g: portion, ...units, ...(liquid ? { ml_g: 1 } : {}), ...(barcode ? { barcode } : {}),
      }))
      if (p) onCreated(p)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось сохранить')
      setBusy(false)
    }
  }

  return (
    <>
      {barcode && <p className="row-title strong">Товара {barcode} пока нет в базе. Добавьте его один раз — дальше он будет находиться по штрихкоду у всех.</p>}
      {barcode && <p className="xp-note">🏅 <b>+25 XP</b>, когда ещё двое подтвердят те же цифры и товар попадёт в общий каталог</p>}
      {!barcode && <p className="sub">Значения — на 100 г, они есть на упаковке. Сначала продукт виден только вам; когда ещё двое внесут те же цифры, он попадёт в общий каталог, а вы получите <b>+25 XP</b>.</p>}
      {aiEnabled && (
        <label className={`btn ${barcode ? '' : 'btn-ghost '}photo-btn${reading ? ' disabled' : ''}`}>
          {reading ? 'Читаю этикетку…' : '📷 Сфоткать этикетку — заполню сам'}
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
