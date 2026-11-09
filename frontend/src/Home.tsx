// Daily overview with compact food and workout summaries.
import { useState } from 'react'
import type { Targets } from './profile'
import { nextDay, type FoodDay, type Program, type WorkoutLog } from './types'

export type Water = { ml: number; goal_ml: number }
export type WeekDay = { date: string; kcal: number; water_ml: number; workouts: number }
export type FoodIntent = 'photo' | 'text' | 'search'

const WEEKDAY = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const liters = (ml: number) => (ml / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const exercisesLabel = (n: number) => `${n} ${n % 100 >= 11 && n % 100 <= 14 ? 'упражнений' : n % 10 === 1 ? 'упражнение' : n % 10 >= 2 && n % 10 <= 4 ? 'упражнения' : 'упражнений'}`

function MiniRing({ frac, today }: { frac: number; today: boolean }) {
  const r = 13
  const c = 2 * Math.PI * r
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
      <circle cx="17" cy="17" r={r} fill="none" stroke="var(--ring-track)" strokeWidth="5" />
      {frac > 0 && <circle cx="17" cy="17" r={r} fill="none" stroke={today ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 70%, transparent)'}
        strokeWidth="5" strokeLinecap="round" strokeDasharray={`${c * Math.min(1, frac)} ${c}`} transform="rotate(-90 17 17)" />}
    </svg>
  )
}

const PORTIONS = [150, 250, 330, 500]

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
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--water)" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" /></svg>
        <div className="row-title strong row-main">Вода · {liters(water.ml)} <span className="muted">/ {liters(water.goal_ml)} л</span></div>
        {canEdit && water.ml > 0 && (
          <div className="water-mode" role="group" aria-label="Режим">
            <button aria-pressed={!remove} aria-label="Режим: добавлять" onClick={() => { setRemove(false); setCustom(null) }}>+</button>
            <button aria-pressed={remove} aria-label="Режим: убирать" onClick={() => { setRemove(true); setCustom(null) }}>−</button>
          </div>
        )}
      </div>
      <div className="bar water-bar"><i style={{ width: `${Math.min(100, (water.ml / water.goal_ml) * 100)}%`, background: 'var(--water)' }} /></div>
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
  week: WeekDay[]
  aiEnabled: boolean
  canEdit: boolean
  onFood: (intent: FoodIntent) => void
  onNutrition: () => void
  onWorkouts: () => void
  onWater: (delta: number) => void
  summary: React.ReactNode
  intro?: React.ReactNode
  quests?: React.ReactNode
}) {
  const { targets, day, water, week } = props
  const [today] = useState(() => {
    const s = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
    return s[0].toUpperCase() + s.slice(1)
  })
  const goal = targets?.calories ?? 2000
  const foodRatio = goal > 0 ? Math.max(0, day.totals.kcal / goal) : 0
  const foodProgress = foodRatio < 0.9 ? foodRatio : foodRatio <= 1.1 ? 1 : Math.max(0, 2.1 - foodRatio)
  const waterProgress = water.goal_ml > 0 ? Math.min(1, Math.max(0, water.ml / water.goal_ml)) : 0
  const progress = Math.round((foodProgress + waterProgress) * 50)
  const next = props.program && nextDay(props.program, props.logs)
  const daysInNorm = week.filter((d) => d.kcal >= goal * 0.9 && d.kcal <= goal * 1.1).length

  return (
    <>
      <header className="home-head">
        <div>
          <p className="hello">{today}</p>
          <h1 className="home-title">Привет, {props.name}</h1>
        </div>
        <div className="home-chips" style={props.loading ? { visibility: 'hidden' } : undefined}>
          <span className="pill" title="Дней подряд">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--streak)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3c1 3 4 4.5 4 8.5A4 4 0 0 1 8 12c0-1.5.7-2.6 1.5-3.5C10 10 11 10.5 11 10.5 11 7 12 3 12 3z" /></svg>
            {props.streak}<span className="sr-only"> дней подряд</span>
          </span>
          {props.boostUntil && ( // the server sends it only while the boost lasts
            <span className="pill pill-boost" title={`Бустер за победу в дуэли: ×1,5 XP до ${new Date(props.boostUntil).toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}>
              ⚡ ×1,5<span className="sr-only"> XP: бустер за победу в дуэли</span>
            </span>
          )}
          <span className="pill pill-accent">Ур. {props.level}</span>
        </div>
      </header>

      {props.intro}

      <div className="home-today">
      <section className="daily-progress" aria-label={props.loading ? 'Загрузка' : `Прогресс дня: ${progress}%`} aria-busy={props.loading}>
        <div className="daily-progress-ring">
          <svg viewBox="0 0 200 200" aria-hidden="true"><circle className="daily-ring-track" cx="100" cy="100" r="86" />{!props.loading && progress > 0 && <circle className="daily-ring-value" cx="100" cy="100" r="86" pathLength="100" strokeDasharray={`${progress} 100`} />}</svg>
          <div className="daily-progress-center">{props.loading ? <span className="skeleton skeleton-num" /> : <strong>{progress}%</strong>}</div>
        </div>
        <p className="sub daily-progress-caption">Прогресс дня</p>
      </section>

      <div className="home-overview">
        <button className="card home-overview-card" onClick={props.onNutrition}>
          <span className="overview-link">Питание <span aria-hidden="true">→</span></span>
          <span className="overview-value">{props.loading ? <span className="skeleton skeleton-line" /> : fmt(day.totals.kcal)}</span>
          <span className="sub">из {fmt(goal)} ккал</span>
        </button>
        <button className="card home-overview-card" onClick={props.onWorkouts}>
          <span className="overview-link">Тренировка дня <span aria-hidden="true">→</span></span>
          <span className="overview-workout">{next ? next.day_name : 'Выберите программу'}</span>
          <span className="sub">{next ? exercisesLabel(next.exercises.length) : 'Перейти к тренировкам'}</span>
        </button>
      </div>

      </div>

      {props.canEdit && (
        <div className="home-actions">
          {props.aiEnabled ? (
            <>
              <button className="btn btn-icon" onClick={() => props.onFood('photo')}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
                Сфоткать еду
              </button>
              <button className="btn btn-ghost btn-side" onClick={() => props.onFood('search')}>Вручную</button>
            </>
          ) : (
            <button className="btn btn-ghost" onClick={() => props.onFood('search')}>+ Добавить еду</button>
          )}
        </div>
      )}

      <WaterCard water={water} canEdit={props.canEdit} onWater={props.onWater} />

      {props.quests}

      {week.length === 7 && (
        <section className="card">
          <div className="card-head">
            <h2>Неделя</h2>
            <span className="sub">{daysInNorm} из 7 дней в норме</span>
          </div>
          <div className="week">
            {week.map((d, i) => (
              <div key={d.date} className={i === 6 ? 'week-day today' : 'week-day'}>
                <MiniRing frac={d.kcal / goal} today={i === 6} />
                <span>{WEEKDAY[new Date(d.date + 'T12:00').getDay()]}</span>
              </div>
            ))}
          </div>
        </section>
      )}





      {props.summary}
    </>
  )
}
