// A workout written in afterwards (no phone in the gym): a day of the program, today or yesterday, when and how long, and
// its sets prefilled from the plan. The server keeps it for progress and the coach; XP is half (backend past_workout).
import { useState } from 'react'
import { haptic } from './haptics'
import { plural } from './plural'
import { api, postJson } from './telegram'
import type { Program } from './types'

type Row = { reps: string; weight: string }
type Result = { xp_awarded: number; xp_note: string | null; tip: string | null }

const iso = (d: Date) => d.toLocaleDateString('sv-SE')
const firstNumber = (s: string) => s.match(/\d+/)?.[0] ?? ''
const num = (s: string) => Number(s.replace(',', '.')) || 0

export default function PastWorkout({ program, dayId, onDone, onClose }: { program: Program; dayId: number; onDone: (xp: number) => void; onClose: () => void }) {
  const [id, setId] = useState(dayId)
  const day = program.days.find((d) => d.id === id) ?? program.days[0]
  const plan = (d: typeof day) => d.exercises.map((e) => Array.from({ length: e.sets }, (_, i): Row => ({ reps: firstNumber(e.reps), weight: e.planned_weights?.[i] == null ? '' : String(e.planned_weights[i]) })))
  const [rows, setRows] = useState<Row[][]>(() => plan(day))
  const [yesterday, setYesterday] = useState(false)
  const [start, setStart] = useState(() => { const d = new Date(Date.now() - 90 * 60_000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` })
  const [minutes, setMinutes] = useState('60')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Result | null>(null)

  const pick = (newId: number) => { setId(newId); const d = program.days.find((x) => x.id === newId); if (d) setRows(plan(d)) }
  const edit = (ei: number, si: number, patch: Partial<Row>) => setRows(rows.map((r, i) => i !== ei ? r : r.map((x, j) => j === si ? { ...x, ...patch } : x)))
  const timed = (ei: number) => day.exercises[ei].unit === 'seconds' || /сек/i.test(day.exercises[ei].reps)
  const sets = rows.flatMap((r, ei) => r.filter((x) => num(x.reps) > 0).map((x, si) => ({
    exercise_id: day.exercises[ei].exercise_id, set_number: si + 1, weight_kg: num(x.weight),
    ...(timed(ei) ? { duration_seconds: Math.round(num(x.reps)) } : { reps: Math.round(num(x.reps)) }),
  })))

  async function save() {
    setBusy(true); setError('')
    try {
      const date = new Date(); if (yesterday) date.setDate(date.getDate() - 1)
      const r = await api<Result>('/api/workout-logs/past', postJson({ program_day_id: day.id, title: `${day.day_name} · ${program.name}`,
        day: iso(date), start, minutes: Math.round(num(minutes)), sets }))
      if (r) { haptic('success'); setResult(r); onDone(r.xp_awarded) }
    } catch (e) { setError(e instanceof Error && e.message ? e.message : 'Не сохранилось. Попробуй ещё раз') }
    setBusy(false)
  }

  if (result) return (
    <section className="card workout-summary" aria-live="polite">
      <div className="workout-summary-icon" aria-hidden="true">📝</div>
      <h1>Тренировка записана</h1>
      <p className="sub">{day.day_name} · {sets.length} {plural(sets.length, 'подход', 'подхода', 'подходов')}</p>
      {result.xp_awarded > 0 ? <p className="pos">+{result.xp_awarded} XP <span className="sub">(в плеере вдвое больше)</span></p>
        : result.xp_note && <p className="sub">{result.xp_note}</p>}
      {result.tip && <p className="workout-tip">⚡ {result.tip}</p>}
      <button className="btn" onClick={onClose}>Готово</button>
    </section>
  )

  return (
    <section className="past-workout">
      <div className="card-head"><h1>Записать после</h1><button className="link" onClick={onClose}>Отмена</button></div>
      <p className="sub">Внеси подходы, и прогресс посчитается. XP вдвое меньше, в дуэлях и рейтинге чатов такая тренировка не участвует.</p>
      {program.days.length > 1 && <label className="past-field"><span>Тренировка</span>
        <select value={day.id} onChange={(e) => pick(Number(e.target.value))}>{program.days.map((d) => <option key={d.id} value={d.id}>{d.day_name}</option>)}</select></label>}
      <div className="checkin-row" role="radiogroup" aria-label="Когда">
        <button className="chip" role="radio" aria-checked={!yesterday} onClick={() => setYesterday(false)}>Сегодня</button>
        <button className="chip" role="radio" aria-checked={yesterday} onClick={() => setYesterday(true)}>Вчера</button>
      </div>
      <div className="past-row">
        <label className="past-field"><span>Начало</span><input type="time" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} /></label>
        <label className="past-field"><span>Минут</span><input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, '').slice(0, 3))} /></label>
      </div>
      {day.exercises.map((e, ei) => (
        <div className="card past-exercise" key={ei}>
          <b>{e.name}</b>
          {rows[ei].map((x, si) => (
            <div className="past-set" key={si}>
              <span className="sub">{si + 1}</span>
              <label><input inputMode="numeric" aria-label={`${e.name}, подход ${si + 1}: ${timed(ei) ? 'секунды' : 'повторы'}`} value={x.reps} onChange={(ev) => edit(ei, si, { reps: ev.target.value.replace(/\D/g, '').slice(0, 4) })} /> {timed(ei) ? 'сек' : 'повт.'}</label>
              <label><input inputMode="decimal" aria-label={`${e.name}, подход ${si + 1}: вес`} value={x.weight} placeholder="0" onChange={(ev) => edit(ei, si, { weight: ev.target.value.replace(/[^\d.,]/g, '').slice(0, 5) })} /> кг</label>
              <button className="link" aria-label="Убрать подход" onClick={() => setRows(rows.map((r, i) => i === ei ? r.filter((_, j) => j !== si) : r))}>✕</button>
            </div>
          ))}
          <button className="link" onClick={() => setRows(rows.map((r, i) => i === ei ? [...r, r[r.length - 1] ?? { reps: firstNumber(e.reps), weight: '' }] : r))}>+ подход</button>
        </div>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" disabled={busy || !sets.length || !num(minutes)} onClick={save}>Сохранить · {sets.length} {plural(sets.length, 'подход', 'подхода', 'подходов')}</button>
    </section>
  )
}
