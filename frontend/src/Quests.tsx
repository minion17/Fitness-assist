import { useState } from 'react'
// Home: this week's three tasks (data from /api/bootstrap). Progress comes from the diary; the server pays the XP.
import { Bar } from './ui'

type Quest = { code: string; title: string; progress: number; target: number; xp: number; done: boolean }
export type QuestWeek = { days_left: number; items: Quest[]; bonus: number; xp_awarded: number }

const ICON: Record<string, string> = {
  diary_days: '🍽', full_days: '🥗', norm_days: '🎯', workouts: '🏋️', weigh: '⚖️', water_days: '💧', active_days: '🔥',
}
const left = (n: number) => (n === 1 ? 'последний день' : `ещё ${n} ${[2, 3, 4].includes(n) ? 'дня' : 'дней'}`)

export default function Quests({ week }: { week: QuestWeek }) {
  const [open, setOpen] = useState(false)
  if (!week.items.length) return null
  const done = week.items.filter((q) => q.done).length
  return (
    <>
      <button className="home-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="home-row-icon" aria-hidden="true">🏆</span>
        <span className="step-text"><b>Задания недели · {done} из {week.items.length}</b>
          <span className="sub">{done === week.items.length ? `Все выполнены, бонус +${week.bonus} XP получен` : `${left(week.days_left)} · все три — ещё +${week.bonus} XP`}</span></span>
        <span className={open ? 'step-go open' : 'step-go'} aria-hidden="true">›</span>
      </button>
      {open && (
        <ul className="quest-list" aria-label="Задания недели">
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
      )}
    </>
  )
}
