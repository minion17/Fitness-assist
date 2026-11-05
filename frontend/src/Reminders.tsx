// Bot reminder settings (Profile). Saved on every change; the bot reads them once a minute.
import { useEffect, useState } from 'react'
import { api, ApiError } from './telegram'

type Settings = {
  meals: boolean; water: boolean; streak: boolean; weekly: boolean
  breakfast_at: string; lunch_at: string; dinner_at: string; streak_at: string; weekly_at: string
}

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return <button role="switch" aria-checked={on} aria-label={label} className="switch" onClick={() => onChange(!on)}><i /></button>
}

function Time({ value, label, onChange }: { value: string; label: string; onChange: (v: string) => void }) {
  return (
    <label className="time-field">
      <span>{label}</span>
      <input type="time" value={value} aria-label={`${label}, время`} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </label>
  )
}

export default function Reminders() {
  const [s, setS] = useState<Settings | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { api<Settings>('/api/reminders').then(setS).catch(() => setError('Не удалось загрузить напоминания')) }, [])
  if (!s) return error ? <p className="error">{error}</p> : null

  async function save(patch: Partial<Settings>) {
    const next = { ...s!, ...patch }
    setS(next)
    setError('')
    try {
      await api('/api/reminders', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не сохранилось — проверьте соединение')
    }
  }

  return (
    <section className="card reminders-card">
      <button className="reminders-toggle" aria-expanded={expanded} aria-controls="reminders-panel" onClick={() => setExpanded(v => !v)}><span>Напоминания в боте</span><span className="reminders-chevron" aria-hidden="true">⌄</span></button>
      <div className="reminders-panel" id="reminders-panel" data-open={expanded} inert={!expanded}><div className="reminders-inner"><div className="list">
        <div className="row">
          <div className="row-main">
            <div className="row-title">Приёмы пищи</div>
            <div className="row-sub">Если приём ещё не записан</div>
          </div>
          <Switch on={s.meals} label="Напоминать о приёмах пищи" onChange={(v) => save({ meals: v })} />
        </div>
        {s.meals && (
          <div className="time-row">
            <Time label="Завтрак" value={s.breakfast_at} onChange={(v) => save({ breakfast_at: v })} />
            <Time label="Обед" value={s.lunch_at} onChange={(v) => save({ lunch_at: v })} />
            <Time label="Ужин" value={s.dinner_at} onChange={(v) => save({ dinner_at: v })} />
          </div>
        )}
        <div className="row">
          <div className="row-main">
            <div className="row-title">Вода</div>
            <div className="row-sub">В 12, 16 и 19 ч, если отстаёте</div>
          </div>
          <Switch on={s.water} label="Напоминать о воде" onChange={(v) => save({ water: v })} />
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">Серия дней 🔥</div>
            <div className="row-sub">Если сегодня ещё ничего не записано</div>
          </div>
          <Switch on={s.streak} label="Напоминать о серии" onChange={(v) => save({ streak: v })} />
        </div>
        {s.streak && <div className="time-row"><Time label="Вечером в" value={s.streak_at} onChange={(v) => save({ streak_at: v })} /></div>}
        <div className="row">
          <div className="row-main">
            <div className="row-title">Итоги недели 📊</div>
            <div className="row-sub">По воскресеньям: карточка недели и совет</div>
          </div>
          <Switch on={s.weekly} label="Присылать итоги недели" onChange={(v) => save({ weekly: v })} />
        </div>
        {s.weekly && <div className="time-row"><Time label="В воскресенье в" value={s.weekly_at} onChange={(v) => save({ weekly_at: v })} /></div>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      </div></div>
    </section>
  )
}
