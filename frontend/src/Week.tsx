// Прогресс: the current week as rings with calories under each; tap a day for its numbers.
import { useState } from 'react'
import type { WeekDay } from './Home'

const WEEKDAY = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const liters = (ml: number) => (ml / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })

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

const cap = (t: string) => t[0].toUpperCase() + t.slice(1)
const short = (kcal: number) => (kcal >= 1000 ? `${(kcal / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}к` : kcal > 0 ? String(Math.round(kcal)) : '—')

/** Seven days as rings with calories under each; tap a day for its numbers. */
export default function WeekCard({ week, goal, norm }: { week: WeekDay[]; goal: number; norm: number }) {
  const [picked, setPicked] = useState<number | null>(null)
  const d = picked === null ? null : week[picked]
  return (
    <section className="card">
      <div className="card-head">
        <h2>Неделя</h2>
        <span className="sub">{norm} из 7 дней в норме</span>
      </div>
      <div className="week">
        {week.map((w, i) => (
          <button key={w.date} className={`week-day${i === 6 ? ' today' : ''}${picked === i ? ' picked' : ''}`} aria-pressed={picked === i}
            aria-label={`${new Date(w.date + 'T12:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}: ${Math.round(w.kcal)} ккал`}
            onClick={() => setPicked(picked === i ? null : i)}>
            <MiniRing frac={w.kcal / goal} today={i === 6} />
            <span>{WEEKDAY[new Date(w.date + 'T12:00').getDay()]}</span>
            <span className="week-kcal">{short(w.kcal)}</span>
          </button>
        ))}
      </div>
      {d && (
        <p className="week-detail" role="status">
          <b>{cap(new Date(d.date + 'T12:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }))}</b>
          {' · '}{fmt(d.kcal)} ккал · вода {liters(d.water_ml)} л{d.workouts ? ` · тренировок: ${d.workouts}` : ''}
        </p>
      )}
    </section>
  )
}

