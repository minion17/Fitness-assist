// Home, variant A from the design canvas: a "control panel" with the day's calorie ring in the centre.
import { useState } from 'react'
import type { Targets } from './profile'
import { nextDay, type FoodDay, type Program, type WorkoutLog } from './types'

export type Water = { ml: number; goal_ml: number }
export type WeekDay = { date: string; kcal: number; water_ml: number; workouts: number }
export type FoodIntent = 'photo' | 'text' | 'search'

const R = 110
const C = 2 * Math.PI * R
const WEEKDAY = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const liters = (ml: number) => (ml / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })

function CalorieRing({ eaten, goal }: { eaten: number; goal: number }) {
  const frac = goal > 0 ? Math.min(1, eaten / goal) : 0
  return (
    <div className="hero-ring">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-disk" aria-hidden="true" />
      <svg width="260" height="260" viewBox="0 0 260 260" role="img" aria-label={`Съедено ${fmt(eaten)} из ${fmt(goal)} ккал`}>
        <circle className="ring-track" cx="130" cy="130" r={R} fill="none" />
        {frac > 0 && <circle className="ring-value" cx="130" cy="130" r={R} fill="none" strokeLinecap="round"
          strokeDasharray={`${C * frac} ${C}`} transform="rotate(-90 130 130)" />}
      </svg>
      <div className="hero-center">
        <span className="hero-num">{fmt(eaten)}</span>
        <span className="sub">из {fmt(goal)} ккал</span>
      </div>
    </div>
  )
}

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
  const [added, setAdded] = useState<number[]>([]) // this session's additions, so "undo" removes exactly the last one
  const [custom, setCustom] = useState<string | null>(null)
  const ml = Number(custom)
  const customOk = Number.isInteger(ml) && ml >= 10 && ml <= 1000
  const add = (n: number) => { setAdded((a) => [...a, n]); onWater(n) }
  const undo = () => { const n = added.at(-1) ?? 250; setAdded((a) => a.slice(0, -1)); onWater(-Math.min(n, water.ml)) }

  return (
    <section className="card water">
      <div className="water-row">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--water)" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" /></svg>
        <div className="row-title strong row-main">Вода · {liters(water.ml)} <span className="muted">/ {liters(water.goal_ml)} л</span></div>
        {canEdit && water.ml > 0 && (
          <button className="water-undo" aria-label={`Убрать последние ${added.at(-1) ?? 250} мл`} onClick={undo}>↶ {added.at(-1) ?? 250}</button>
        )}
      </div>
      <div className="bar water-bar"><i style={{ width: `${Math.min(100, (water.ml / water.goal_ml) * 100)}%`, background: 'var(--water)' }} /></div>
      {canEdit && (custom === null ? (
        <div className="water-chips">
          {PORTIONS.map((n) => <button key={n} aria-label={`Добавить ${n} мл`} onClick={() => add(n)}>+{n}</button>)}
          <button aria-label="Свой объём" onClick={() => setCustom('')}>Своё</button>
        </div>
      ) : (
        <div className="water-chips">
          <div className="input-wrap water-input">
            <input autoFocus inputMode="numeric" aria-label="Объём, мл" placeholder="мл" value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 4))}
              onKeyDown={(e) => { if (e.key === 'Enter' && customOk) { add(ml); setCustom(null) } }} />
            <i>мл</i>
          </div>
          <button disabled={!customOk} onClick={() => { add(ml); setCustom(null) }}>Добавить</button>
          <button className="water-cancel" onClick={() => setCustom(null)}>Отмена</button>
        </div>
      ))}
    </section>
  )
}

export default function Home(props: {
  name: string
  level: number
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
  onWorkouts: () => void
  onWater: (delta: number) => void
  summary: React.ReactNode
}) {
  const { targets, day, water, week } = props
  const [today] = useState(() => {
    const s = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
    return s[0].toUpperCase() + s.slice(1)
  })
  const goal = targets?.calories ?? 2000
  const left = goal - day.totals.kcal
  const next = props.program && nextDay(props.program, props.logs)
  const macros = [
    { label: 'Белки', v: day.totals.protein_g, g: targets?.protein ?? 120, color: 'var(--protein)' },
    { label: 'Жиры', v: day.totals.fat_g, g: targets?.fat ?? 70, color: 'var(--fat)' },
    { label: 'Углеводы', v: day.totals.carbs_g, g: targets?.carbs ?? 230, color: 'var(--carbs)' },
  ]
  const daysInNorm = week.filter((d) => d.kcal >= goal * 0.9 && d.kcal <= goal * 1.1).length

  return (
    <>
      <header className="home-head">
        <div>
          <p className="hello">{today}</p>
          <h1 className="home-title">Привет, {props.name}</h1>
        </div>
        <div className="home-chips">
          <span className="pill" title="Дней подряд">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--streak)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3c1 3 4 4.5 4 8.5A4 4 0 0 1 8 12c0-1.5.7-2.6 1.5-3.5C10 10 11 10.5 11 10.5 11 7 12 3 12 3z" /></svg>
            {props.streak}
            <span className="sr-only"> дней подряд</span>
          </span>
          <span className="pill pill-accent">Ур. {props.level}</span>
        </div>
      </header>

      <CalorieRing eaten={day.totals.kcal} goal={goal} />
      <p className="hero-left">{left >= 0 ? `Осталось ${fmt(left)} ккал` : `Сверх нормы на ${fmt(-left)} ккал`}</p>

      <div className="macro-tiles">
        {macros.map((m) => (
          <div className="tile" key={m.label}>
            <span className="sub">{m.label}</span>
            <span className="tile-num">{fmt(m.v)}<span> / {fmt(m.g)}</span></span>
            <div className="bar thin"><i style={{ width: `${Math.min(100, (m.v / m.g) * 100)}%`, background: m.color }} /></div>
          </div>
        ))}
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
            <button className="btn" onClick={() => props.onFood('search')}>+ Добавить еду</button>
          )}
        </div>
      )}

      <button className="card card-row" onClick={props.onWorkouts}>
        <div className="row-main">
          <span className="sub">Тренировка дня</span>
          <div className="row-title strong">{next ? next.day_name : 'Выберите программу'}</div>
          {next && <span className="sub">{next.exercises.length} упражнения · {props.program!.name}</span>}
        </div>
        <span className="round-btn" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </span>
      </button>

      <WaterCard water={water} canEdit={props.canEdit} onWater={props.onWater} />

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
