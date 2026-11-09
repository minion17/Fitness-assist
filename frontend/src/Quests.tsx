// Home: this week's three tasks. Progress comes from the diary; XP is paid by the server when a task is done.
import { useEffect, useState } from 'react'
import { api } from './telegram'
import { Bar } from './ui'

type Quest = { code: string; title: string; progress: number; target: number; xp: number; done: boolean }
type Week = { days_left: number; items: Quest[]; bonus: number; xp_awarded: number }

const ICON: Record<string, string> = {
  diary_days: '🍽', full_days: '🥗', norm_days: '🎯', workouts: '🏋️', weigh: '⚖️', water_days: '💧', active_days: '🔥',
}
const left = (n: number) => (n === 1 ? 'последний день' : `ещё ${n} ${[2, 3, 4].includes(n) ? 'дня' : 'дней'}`)

export default function Quests({ onAwarded }: { onAwarded: (xp: number) => void }) {
  const [week, setWeek] = useState<Week | null>(null)

  useEffect(() => {
    let stale = false
    api<Week>('/api/quests').then((w) => {
      if (stale || !w) return
      setWeek(w)
      if (w.xp_awarded > 0) onAwarded(w.xp_awarded)
    }).catch(() => {}) // tasks are extra: Home works without them
    return () => { stale = true }
  }, [onAwarded])

  if (!week?.items.length) return null
  const done = week.items.filter((q) => q.done).length
  return (
    <section className="card quests" aria-label="Задания недели">
      <div className="card-head">
        <h2>Задания недели</h2>
        <span className="sub">{done === week.items.length ? 'все выполнены' : left(week.days_left)}</span>
      </div>
      {week.xp_awarded > 0 && <p className="quests-paid" role="status">Задание выполнено — +{week.xp_awarded} XP</p>}
      <ul className="quest-list">
        {week.items.map((q) => (
          <li key={q.code} className={q.done ? 'done' : ''}>
            <span className="quest-icon" aria-hidden="true">{q.done ? '✓' : ICON[q.code] ?? '★'}</span>
            <div className="quest-main">
              <div className="quest-row"><b>{q.title}</b><span className="quest-xp">+{q.xp} XP</span></div>
              {!q.done && <><Bar value={q.progress} goal={q.target} /><span className="sub">{q.progress} из {q.target}</span></>}
            </div>
          </li>
        ))}
      </ul>
      <p className="sub quests-bonus">{done === week.items.length ? `Бонус +${week.bonus} XP получен` : `Все три — ещё +${week.bonus} XP`}</p>
    </section>
  )
}
