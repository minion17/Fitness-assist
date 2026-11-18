// Diary calendar: a month at a glance, each logged day coloured by how it went against the norm; a tap opens the day.
import { useEffect, useRef, useState } from 'react'
import { api } from './telegram'
import { Sheet, Chevron } from './ui'

type Month = { days: Record<string, number>; goal: number | null }
const WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const HISTORY_DAYS = 365

const iso = (d: Date) => d.toLocaleDateString('sv-SE')
const monthOf = (day: string) => day.slice(0, 7)
function addMonths(month: string, n: number): string {
  const d = new Date(`${month}-15T12:00:00`)
  d.setMonth(d.getMonth() + n)
  return iso(d).slice(0, 7)
}

/** In the norm (±10%), over it, or under: the same bands as the rest of the app. */
function dayState(kcal: number | undefined, goal: number | null): 'ok' | 'over' | 'under' | null {
  if (!kcal) return null
  if (!goal) return 'ok'
  return kcal > goal * 1.1 ? 'over' : kcal < goal * 0.9 ? 'under' : 'ok'
}

export default function Calendar({ value, onPick, onClose }: { value: string; onPick: (day: string) => void; onClose: () => void }) {
  const [{ today, min }] = useState(() => {
    const d = new Date(), t = iso(d)
    d.setDate(d.getDate() - HISTORY_DAYS)
    return { today: t, min: iso(d) }
  })
  const [month, setMonth] = useState(monthOf(value))
  const [data, setData] = useState<Record<string, Month>>({})
  const swipe = useRef<number | null>(null)

  useEffect(() => {
    if (data[month]) return
    let stale = false
    api<Month>(`/api/food-calendar?month=${month}`).then((r) => { if (!stale) setData((d) => ({ ...d, [month]: r ?? { days: {}, goal: null } })) }).catch(() => {})
    return () => { stale = true }
  }, [month, data])

  const m = data[month]
  const first = new Date(`${month}-01T12:00:00`)
  const offset = (first.getDay() + 6) % 7 // Monday first
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells = [...Array(offset).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)]
  const canPrev = monthOf(min) < month, canNext = month < monthOf(today)
  const go = (n: number) => { if (n < 0 ? canPrev : canNext) setMonth(addMonths(month, n)) }
  const logged = m ? Object.keys(m.days).length : 0
  const inNorm = m ? Object.values(m.days).filter((k) => dayState(k, m.goal) === 'ok').length : 0
  const title = first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '')

  return (
    <Sheet title="Дневник по дням" onClose={onClose}>
      <div className="cal-head">
        <button className="icon-btn" aria-label="Предыдущий месяц" disabled={!canPrev} onClick={() => go(-1)}><Chevron dir="left" /></button>
        <strong>{title[0].toUpperCase() + title.slice(1)}</strong>
        <button className="icon-btn" aria-label="Следующий месяц" disabled={!canNext} onClick={() => go(1)}><Chevron dir="right" /></button>
      </div>
      <div className="cal-grid" role="grid" aria-label={title} aria-busy={!m}
        onPointerDown={(e) => { swipe.current = e.clientX }}
        onPointerUp={(e) => { const x = swipe.current; swipe.current = null; if (x !== null && Math.abs(e.clientX - x) > 50) go(e.clientX > x ? -1 : 1) }}>
        {WEEK.map((w) => <span key={w} className="cal-week">{w}</span>)}
        {cells.map((day, i) => {
          if (!day) return <span key={`e${i}`} />
          const kcal = m?.days[day]
          const state = m ? dayState(kcal, m.goal) : null
          const off = day > today || day < min
          return (
            <button key={day} className={['cal-day', state ?? '', day === today ? 'today' : '', day === value ? 'picked' : ''].join(' ')}
              disabled={off} aria-pressed={day === value}
              aria-label={`${new Date(`${day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}${kcal ? `, ${Math.round(kcal)} ккал` : ''}`}
              onClick={() => { onPick(day); onClose() }}>
              <span>{Number(day.slice(8))}</span>
              <i aria-hidden="true" />
            </button>
          )
        })}
      </div>
      <div className="cal-legend">
        <span><i className="ok" />в норме</span><span><i className="under" />меньше</span><span><i className="over" />больше</span>
      </div>
      <p className="sub">{!m ? 'Загружаем…' : logged ? `Записано ${logged} ${logged % 10 === 1 && logged % 100 !== 11 ? 'день' : [2, 3, 4].includes(logged % 10) && ![12, 13, 14].includes(logged % 100) ? 'дня' : 'дней'}, в норме — ${inNorm}` : 'В этом месяце записей нет'}</p>
      {value !== today && <button className="btn btn-ghost" onClick={() => { onPick(today); onClose() }}>К сегодня</button>}
    </Sheet>
  )
}
