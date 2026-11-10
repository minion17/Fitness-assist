// Home: the user's own daily checks (sleep, steps, no sweets...). One tap ticks today; a tick keeps the streak.
import { useState } from 'react'
import { api, postJson, tg } from './telegram'

export type Habit = { id: number; title: string; emoji: string; done: boolean; streak: number; remind_at?: string | null }

const PRESETS = [
  { emoji: '😴', title: 'Сон 8 часов' }, { emoji: '👟', title: '10 000 шагов' }, { emoji: '🍬', title: 'Без сладкого' },
  { emoji: '💊', title: 'Витамины' }, { emoji: '🧘', title: 'Растяжка' }, { emoji: '📖', title: 'Чтение 20 минут' },
]
const MAX = 8

export default function Habits({ habits, onChange }: { habits: Habit[]; onChange: (list: Habit[]) => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')

  async function send(path: string, init: RequestInit) {
    setError('')
    try {
      const list = await api<Habit[]>(path, init)
      if (list) onChange(list)
      return true
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Не получилось. Попробуйте ещё раз.')
      return false
    }
  }

  function tick(h: Habit) {
    tg?.HapticFeedback?.impactOccurred?.('light')
    onChange(habits.map((x) => (x.id === h.id ? { ...x, done: !h.done } : x))) // instant; the server answer replaces it
    send(`/api/habits/${h.id}/check`, postJson({ done: !h.done })).then((ok) => { if (!ok) onChange(habits) })
  }

  const add = async (emoji: string, t: string) => { if (await send('/api/habits', postJson({ emoji, title: t }))) setTitle('') }
  const has = (t: string) => habits.some((h) => h.title.toLowerCase() === t.toLowerCase())
  const done = habits.filter((h) => h.done).length

  if (!habits.length && !editing) {
    return (
      <button className="home-row" onClick={() => setEditing(true)}>
        <span className="home-row-icon" aria-hidden="true">✅</span>
        <span className="step-text"><b>Привычки</b><span className="sub">Сон, шаги, без сладкого — отметка продлевает серию</span></span>
        <span className="step-go" aria-hidden="true">›</span>
      </button>
    )
  }

  return (
    <div className="habits">
      <div className="home-row habits-head">
        <span className="home-row-icon" aria-hidden="true">✅</span>
        <span className="step-text"><b>Привычки{habits.length ? ` · ${done} из ${habits.length}` : ''}</b>
          <span className="sub">{habits.length && done === habits.length ? 'Все отмечены сегодня' : 'Отметка за сегодня продлевает серию'}</span></span>
        <button className="link" onClick={() => { setEditing(!editing); setError('') }}>{editing ? 'Готово' : 'Изменить'}</button>
      </div>

      {!editing && (
        <div className="habit-chips" role="group" aria-label="Привычки на сегодня">
          {habits.map((h) => (
            <button key={h.id} className="habit-chip" aria-pressed={h.done} onClick={() => tick(h)}>
              <span aria-hidden="true">{h.done ? '✓' : h.emoji}</span> {h.title}
              {h.streak > 1 && <small> · {h.streak}</small>}
            </button>
          ))}
        </div>
      )}

      {editing && (
        <div className="habit-edit">
          {habits.length > 0 && <p className="sub">Время — бот напомнит, если привычка ещё не отмечена. Отметить можно прямо в чате.</p>}
          {habits.map((h) => (
            <div key={h.id} className="habit-line">
              <span aria-hidden="true">{h.emoji}</span><span className="habit-line-title">{h.title}</span>
              <input type="time" className="habit-time" aria-label={`Напоминание: ${h.title}`} value={h.remind_at ?? ''}
                onChange={(e) => send(`/api/habits/${h.id}`, { ...postJson({ remind_at: e.target.value || null }), method: 'PATCH' })} />
              <button className="link" aria-label={`Убрать «${h.title}»`} onClick={() => send(`/api/habits/${h.id}`, { method: 'DELETE' })}>✕</button>
            </div>
          ))}
          {habits.length < MAX && (
            <>
              <div className="habit-chips">
                {PRESETS.filter((p) => !has(p.title)).map((p) => (
                  <button key={p.title} className="habit-chip" onClick={() => add(p.emoji, p.title)}>+ {p.emoji} {p.title}</button>
                ))}
              </div>
              <form className="habit-new" onSubmit={(e) => { e.preventDefault(); if (title.trim()) add('✅', title.trim()) }}>
                <div className="input-wrap"><input aria-label="Своя привычка" placeholder="Своя привычка" maxLength={40} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
                <button className="btn btn-side" disabled={!title.trim()}>Добавить</button>
              </form>
            </>
          )}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}
