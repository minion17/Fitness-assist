// Прогресс: which muscles got work this week (sets: main muscle 1, helper ½) and which were left out.
import { useEffect, useState } from 'react'
import MuscleMap from './MuscleMap'
import { MUSCLES, type Muscle } from './muscles'
import { api } from './telegram'

const TARGET = 10 // sets a week that make a muscle "full" on the map (a common hypertrophy guideline)
const MAJOR: Muscle[] = ['chest', 'lats', 'middle back', 'shoulders', 'biceps', 'triceps', 'abdominals', 'glutes', 'quadriceps', 'hamstrings', 'calves']

export default function MuscleWeek() {
  const [sets, setSets] = useState<Record<string, number> | null>(null)
  useEffect(() => { api<{ sets: Record<string, number> }>('/api/muscles/week').then((r) => setSets(r?.sets ?? {})).catch(() => setSets(null)) }, [])
  if (!sets) return null
  const heat = Object.fromEntries(Object.entries(sets).map(([m, v]) => [m, v / TARGET]))
  const worked = Object.entries(sets).slice(0, 5)
  const rested = MAJOR.filter((m) => !sets[m])
  return (
    <section className="card muscle-week">
      <div className="card-head"><h2>Мышцы за неделю</h2><span className="sub">подходы за 7 дней</span></div>
      {worked.length ? (
        <>
          <MuscleMap heat={heat} compact />
          <div className="lib-tags">{worked.map(([m, v]) => <span key={m} className="chip chip-accent">{MUSCLES[m as Muscle] ?? m} · {String(v).replace('.', ',')}</span>)}</div>
          {rested.length > 0 && <p className="sub">Не нагружали: {rested.map((m) => MUSCLES[m].toLowerCase()).join(', ')}.</p>}
        </>
      ) : <p className="sub">За неделю тренировок не было — схема заполнится, когда отметишь подходы.</p>}
    </section>
  )
}
