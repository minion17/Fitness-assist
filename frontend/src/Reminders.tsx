// Bot reminder settings (Profile). Saved on every change; the bot reads them once a minute.
import { useEffect, useState } from 'react'
import { api, ApiError, postJson } from './telegram'
import { Chevron } from './ui'

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
  const [next, setNext] = useState<{ at: string; what: string; tomorrow: boolean } | null>(null)
  const [test, setTest] = useState<'idle' | 'wait' | 'ok' | 'fail'>('idle')
  useEffect(() => { api<Settings>('/api/reminders').then(setS).catch(() => setError('Не удалось загрузить напоминания')) }, [])
  useEffect(() => { if (expanded) api<typeof next>('/api/reminders/next').then(setNext).catch(() => {}) }, [expanded, s])

  /** A message through the bot now; if the bot doesn't pick it up in 20 s, it isn't running. */
  async function sendTest() {
    setTest('wait')
    try {
      const r = await api<{ id: number }>('/api/reminders/test', postJson({}))
      for (let i = 0; i < 10; i++) {
        await new Promise((ok) => setTimeout(ok, 2000))
        if ((await api<{ sent: boolean }>(`/api/reminders/test/${r!.id}`))?.sent) return setTest('ok')
      }
    } catch { /* below */ }
    setTest('fail')
  }
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
      <button className="reminders-toggle" aria-expanded={expanded} aria-controls="reminders-panel" onClick={() => setExpanded(v => !v)}><span>Напоминания в боте</span><span className="reminders-chevron" aria-hidden="true"><Chevron /></span></button>
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
      <div className="reminders-test">
        {next && <p className="sub">Ближайшее: {next.what} {next.tomorrow ? 'завтра' : 'сегодня'} в {next.at} — придёт, только если это ещё не сделано.</p>}
        <button className="btn btn-ghost" disabled={test === 'wait'} onClick={sendTest}>{test === 'wait' ? 'Отправляем…' : '🔔 Прислать пробное в чат'}</button>
        {test === 'ok' && <p className="sub" role="status">Отправлено — проверьте чат с ботом.</p>}
        {test === 'fail' && <p className="error" role="alert">Бот не ответил: он не запущен. Напоминания отправляет компьютер с сервером — он должен быть включён, а окно «FA бот» открыто.</p>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      </div></div>
    </section>
  )
}
