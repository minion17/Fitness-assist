// A PDF for a doctor, a dietitian or a coach: the bot draws it (backend/bot/report.py) and sends it to the chat as a file.
import { useState } from 'react'
import { api, postJson } from './telegram'

export default function ReportCard() {
  const [days, setDays] = useState(30)
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle')
  const [error, setError] = useState('')
  async function order() {
    setState('busy'); setError('')
    try { await api('/api/report', postJson({ days })); setState('sent') } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Не получилось. Попробуй ещё раз'); setState('error')
    }
  }
  return (
    <section className="card report-card">
      <h2>Отчёт для врача или тренера</h2>
      <p className="sub">Вес, обхваты, питание по дням, тренировки и сон в одном PDF. Придёт в чат с ботом.</p>
      <div className="seg seg-row">
        {[7, 30, 90].map((d) => <button key={d} aria-pressed={days === d} onClick={() => { setDays(d); setState('idle') }}>{d === 7 ? 'Неделя' : d === 30 ? 'Месяц' : '3 месяца'}</button>)}
      </div>
      {state === 'sent' ? <p className="xp-note">Готовим отчёт. Через несколько секунд он будет в чате с ботом.</p>
        : <button className="btn btn-ghost" disabled={state === 'busy'} onClick={order}>{state === 'busy' ? 'Отправляем…' : 'Прислать PDF в чат'}</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
