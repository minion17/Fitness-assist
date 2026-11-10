// Daily overview with compact food and workout summaries.
import { useState } from 'react'
import type { Targets } from './profile'
import { useCountUp } from './motion'
import { nextDay, type FoodDay, type Program, type WorkoutLog } from './types'

export type Water = { ml: number; goal_ml: number }
export type WeekDay = { date: string; kcal: number; water_ml: number; workouts: number }
export type FoodIntent = 'photo' | 'text' | 'search'

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const liters = (ml: number) => (ml / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const exercisesLabel = (n: number) => `${n} ${n % 100 >= 11 && n % 100 <= 14 ? 'упражнений' : n % 10 === 1 ? 'упражнение' : n % 10 >= 2 && n % 10 <= 4 ? 'упражнения' : 'упражнений'}`

const PORTIONS = [150, 250, 330, 500]

/** A glass that fills up to the day's goal, with a slow wave on top. */
function Glass({ frac }: { frac: number }) {
  const level = useCountUp(Math.max(0, Math.min(1, frac)))
  const top = 6 + (1 - level) * 54  // water surface: y=60 empty .. y=6 full
  return (
    <svg className="glass" width="46" height="64" viewBox="0 0 46 64" aria-hidden="true">
      <defs><clipPath id="glass-in"><path d="M5 4h36l-4 54a4 4 0 0 1-4 4H13a4 4 0 0 1-4-4z" /></clipPath></defs>
      <g clipPath="url(#glass-in)">
        <rect x="0" y="0" width="46" height="64" fill="var(--water-soft)" />
        {level > 0.01 && (
          <g style={{ transform: `translateY(${top}px)` }} className="glass-water">
            <path className="glass-wave" d="M-46 3 q5.75 -4 11.5 0 t11.5 0 t11.5 0 t11.5 0 t11.5 0 t11.5 0 t11.5 0 t11.5 0 V70 H-46z" fill="var(--water)" />
          </g>
        )}
      </g>
      <path d="M5 4h36l-4 54a4 4 0 0 1-4 4H13a4 4 0 0 1-4-4z" fill="none" stroke="color-mix(in srgb, var(--water) 55%, transparent)" strokeWidth="2" />
    </svg>
  )
}

function WaterCard({ water, canEdit, onWater }: { water: Water; canEdit: boolean; onWater: (delta: number) => void }) {
  const [remove, setRemove] = useState(false) // "Убрать": the same chips subtract (any amount, not only the last glass)
  const [custom, setCustom] = useState<string | null>(null)
  const ml = Number(custom)
  const sign = remove ? -1 : 1
  const customOk = Number.isInteger(ml) && ml >= 10 && ml <= (remove ? Math.min(1000, water.ml) : 1000)
  const change = (n: number) => {
    onWater(sign * Math.min(n, remove ? water.ml : n))
    setCustom(null)
    if (remove) setRemove(false) // a correction is usually one tap; back to adding
  }

  return (
    <section className={`card water${remove ? ' water-removing' : ''}`}>
      <div className="water-row">
        <Glass frac={water.goal_ml > 0 ? water.ml / water.goal_ml : 0} />
        <div className="row-main water-text">
          <span className="sub">Вода</span>
          <span className="water-amount">{liters(water.ml)} <span className="muted">/ {liters(water.goal_ml)} л</span></span>
          <span className="sub">{water.ml >= water.goal_ml ? 'Норма выполнена 💧' : `ещё ${liters(water.goal_ml - water.ml)} л`}</span>
        </div>
        {canEdit && water.ml > 0 && (
          <div className="water-mode" role="group" aria-label="Режим">
            <button aria-pressed={!remove} aria-label="Режим: добавлять" onClick={() => { setRemove(false); setCustom(null) }}>+</button>
            <button aria-pressed={remove} aria-label="Режим: убирать" onClick={() => { setRemove(true); setCustom(null) }}>−</button>
          </div>
        )}
      </div>
      {canEdit && (custom === null ? (
        <div className="water-chips">
          {PORTIONS.map((n) => (
            <button key={n} aria-label={`${remove ? 'Убрать' : 'Добавить'} ${n} мл`} disabled={remove && water.ml <= 0} onClick={() => change(n)}>
              {remove ? '−' : '+'}{n}
            </button>
          ))}
          <button aria-label={remove ? 'Убрать свой объём' : 'Свой объём'} onClick={() => setCustom('')}>Своё</button>
        </div>
      ) : (
        <div className="water-chips">
          <div className="input-wrap water-input">
            <input autoFocus inputMode="numeric" aria-label={remove ? 'Убрать, мл' : 'Объём, мл'} placeholder="мл" value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 4))}
              onKeyDown={(e) => { if (e.key === 'Enter' && customOk) change(ml) }} />
            <i>мл</i>
          </div>
          <button disabled={!customOk} onClick={() => change(ml)}>{remove ? 'Убрать' : 'Добавить'}</button>
          <button className="water-cancel" onClick={() => setCustom(null)}>Отмена</button>
        </div>
      ))}
    </section>
  )
}

export default function Home(props: {
  name: string
  level: number
  loading?: boolean // first open, nothing kept yet: placeholders instead of zeros
  boostUntil?: string | null
  streak: number
  targets?: Targets
  day: FoodDay
  program?: Program
  logs: WorkoutLog[]
  water: Water
  aiEnabled: boolean
  canEdit: boolean
  onFood: (intent: FoodIntent) => void
  onNutrition: () => void
  onWorkouts: () => void
  onWater: (delta: number) => void
  intro?: React.ReactNode
  quests?: React.ReactNode
  repeat?: { title: string; kcal: number; run: () => void } | null
}) {
  const { targets, day, water } = props
  const [waterOpen, setWaterOpen] = useState(false) // the glass with +/- and portions, under the day card
  const [today] = useState(() => {
    const s = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
    return s[0].toUpperCase() + s.slice(1)
  })
  const goal = targets?.calories ?? 2000
  const foodRatio = goal > 0 ? Math.max(0, day.totals.kcal / goal) : 0
  const foodProgress = foodRatio < 0.9 ? foodRatio : foodRatio <= 1.1 ? 1 : Math.max(0, 2.1 - foodRatio)
  const waterProgress = water.goal_ml > 0 ? Math.min(1, Math.max(0, water.ml / water.goal_ml)) : 0
  const progress = Math.round((foodProgress + waterProgress) * 50)
  const shownProgress = Math.round(useCountUp(props.loading ? 0 : progress))
  const shownKcal = useCountUp(day.totals.kcal)
  const next = props.program && nextDay(props.program, props.logs)

  return (
    <>
      <header className="home-head">
        <div>
          <p className="hello">{today}</p>
          <h1 className="home-title">Привет, {props.name}</h1>
        </div>
        <div className="home-chips" style={props.loading ? { visibility: 'hidden' } : undefined}>
          {props.boostUntil && ( // the server sends it only while the boost lasts
            <span className="pill pill-boost" title={`Бустер за победу в дуэли: ×1,5 XP до ${new Date(props.boostUntil).toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}>
              ⚡ ×1,5<span className="sr-only"> XP: бустер за победу в дуэли</span>
            </span>
          )}
          <span className="pill" title="Дней подряд">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--streak)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3c1 3 4 4.5 4 8.5A4 4 0 0 1 8 12c0-1.5.7-2.6 1.5-3.5C10 10 11 10.5 11 10.5 11 7 12 3 12 3z" /></svg>
            {props.streak}<span className="sr-only"> дней подряд</span>
          </span>
        </div>
      </header>

      {props.intro}

      {/* the day in one card: ring + calories + water */}
      <section className="card day-card" aria-busy={props.loading}>
        <div className="daily-progress-ring" role="img" aria-label={props.loading ? 'Загрузка' : `Прогресс дня: ${progress}%`}>
          <svg viewBox="0 0 200 200" aria-hidden="true"><circle className="daily-ring-track" cx="100" cy="100" r="86" />{!props.loading && shownProgress > 0 && <circle className={foodRatio > 1.1 ? 'daily-ring-value over' : 'daily-ring-value'} cx="100" cy="100" r="86" pathLength="100" strokeDasharray={`${shownProgress} 100`} />}</svg>
          <div className="daily-progress-center">{props.loading ? <span className="skeleton skeleton-num" /> : <><strong>{shownProgress}%</strong><span className="sub">день</span></>}</div>
        </div>
        <div className="day-stats">
          <button className="day-stat" onClick={props.onNutrition} aria-label="Питание: открыть дневник">
            <span className="sub">Питание</span>
            <span className="day-stat-value">{props.loading ? <span className="skeleton skeleton-line" /> : <>{fmt(shownKcal)} <small>/ {fmt(goal)} ккал</small></>}</span>
            {foodRatio > 1.1 && <span className="sub warn">на {fmt(day.totals.kcal - goal)} больше нормы</span>}
          </button>
          <button className="day-stat" aria-expanded={waterOpen} onClick={() => setWaterOpen(!waterOpen)} aria-label="Вода: подробнее">
            <span className="sub">Вода</span>
            <span className="day-stat-value water-value">{liters(water.ml)} <small>/ {liters(water.goal_ml)} л</small></span>
          </button>
        </div>
      </section>

      {waterOpen && <WaterCard water={water} canEdit={props.canEdit} onWater={props.onWater} />}

      {props.canEdit && (
        <div className="home-actions">
          <button className="btn btn-icon" onClick={() => props.onFood(props.aiEnabled ? 'photo' : 'search')}>
            {props.aiEnabled && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>}
            {props.aiEnabled ? 'Добавить еду' : '+ Добавить еду'}
          </button>
          <button className="btn btn-ghost btn-side water-quick" aria-label="Добавить стакан воды, 250 мл" onClick={() => props.onWater(250)}>+💧 250</button>
        </div>
      )}
      {props.repeat && (
        <button className="link repeat-link" onClick={props.repeat.run}>↻ {props.repeat.title.toLowerCase()} · {fmt(props.repeat.kcal)} ккал</button>
      )}

      <div className="card home-rows">
        <button className="home-row" onClick={props.onWorkouts}>
          <span className="home-row-icon" aria-hidden="true">🏋️</span>
          <span className="step-text"><b>{next ? `Сегодня: ${next.day_name}` : 'Выберите программу тренировок'}</b>
            <span className="sub">{next ? exercisesLabel(next.exercises.length) : 'Готовую или свою'}</span></span>
          <span className="step-go" aria-hidden="true">›</span>
        </button>
        {props.quests}
      </div>
    </>
  )
}
