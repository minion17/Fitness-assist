import { useState } from 'react'
import { api, ApiError } from './telegram'

type Summary = { text: string; created_at: string; cached: boolean }

export default function AiSummary() {
  const [period, setPeriod] = useState<'day' | 'week'>('day')
  const [data, setData] = useState<Partial<Record<'day' | 'week', Summary>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = data[period]

  async function load(refresh: boolean) {
    setBusy(true)
    setError('')
    try {
      const s = await api<Summary>(`/api/ai/summary?period=${period}${refresh ? '&refresh=true' : ''}`)
      if (s) setData((d) => ({ ...d, [period]: s }))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось связаться с сервером')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>✨ AI-итог</h2>
        <div className="seg seg-inline">
          {(['day', 'week'] as const).map((p) => (
            <button type="button" key={p} aria-pressed={period === p} onClick={() => { setPeriod(p); setError('') }}>
              {p === 'day' ? 'День' : 'Неделя'}
            </button>
          ))}
        </div>
      </div>
      {current
        ? <p className="summary">{current.text}</p>
        : <span className="sub">Короткий разбор питания, тренировок и веса с советом на завтра.</span>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn btn-ghost" disabled={busy} onClick={() => load(Boolean(current))}>
        {busy ? 'Анализируем…' : current ? 'Обновить' : `Получить итог ${period === 'day' ? 'дня' : 'недели'}`}
      </button>
    </section>
  )
}
