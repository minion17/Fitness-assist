import { useState } from 'react'
import { api, postJson } from './telegram'
import { completedThisWeek, nextDay, type Program, type ProgramDay, type WorkoutLog } from './types'

const LEVEL: Record<string, string> = { beginner: 'Новичок', intermediate: 'Средний', advanced: 'Продвинутый' }
const firstNumber = (s: string) => s.match(/\d+/)?.[0] ?? ''
const dateRu = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })

export default function Workouts({ programs, logs, programId, onSelectProgram, canEdit, onChanged }: {
  programs: Program[] | null
  logs: WorkoutLog[]
  programId: number | null
  onSelectProgram: (id: number | null) => void
  canEdit: boolean
  onChanged: (xp: number) => void
}) {
  const [session, setSession] = useState<ProgramDay | null>(null)
  const program = programs?.find((p) => p.id === programId)

  if (programs === null) return <><h1>Тренировки</h1><p className="sub">Загружаем программы…</p></>

  if (session && program) {
    return <Session program={program} day={session} onExit={() => setSession(null)} onChanged={onChanged} />
  }

  if (!program) {
    return (
      <>
        <h1>Тренировки</h1>
        <p className="sub">Выберите программу — дальше приложение будет предлагать тренировки по порядку.</p>
        {programs.length === 0 && <p className="sub">Программы ещё не загружены.</p>}
        {programs.map((p) => (
          <section className="card" key={p.id}>
            <div className="card-head"><h2>{p.name}</h2><span className="chip">{LEVEL[p.level] ?? p.level}</span></div>
            <div className="sub">{p.goal} · {p.days_per_week} раза в неделю</div>
            {p.description && <div className="sub">{p.description}</div>}
            <button className="btn btn-ghost" onClick={() => onSelectProgram(p.id)}>Выбрать</button>
          </section>
        ))}
      </>
    )
  }

  const next = nextDay(program, logs)
  const done = completedThisWeek(logs)
  return (
    <>
      <h1>Тренировки</h1>
      <section className="card">
        <div className="card-head">
          <span className="chip">{done} / {program.days_per_week} за неделю</span>
          <button className="link" onClick={() => onSelectProgram(null)}>Сменить программу</button>
        </div>
        <div className="row-title">{program.name}</div>
        <div className="sub">{program.goal} · {LEVEL[program.level] ?? program.level}</div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Следующая тренировка</h2></div>
        <div className="row-title">{next.day_name}</div>
        <div className="list">
          {next.exercises.map((e, i) => (
            <div className="row" key={i}>
              <div className="dot">{i + 1}</div>
              <div className="row-main"><div className="row-title">{e.name}</div><div className="row-sub">{e.sets} × {e.reps}</div></div>
            </div>
          ))}
        </div>
        {canEdit
          ? <button className="btn" onClick={() => setSession(next)}>Начать тренировку</button>
          : <p className="sub">Демо-режим: чтобы записывать тренировки, откройте приложение из Telegram.</p>}
      </section>

      {canEdit && program.days.length > 1 && (
        <section className="card">
          <h2>Другие дни программы</h2>
          <div className="list">
            {program.days.filter((d) => d.id !== next.id).map((d) => (
              <button className="row row-btn" key={d.id} onClick={() => setSession(d)}>
                <div className="row-main"><div className="row-title">{d.day_name}</div><div className="row-sub">{d.exercises.length} упражнения</div></div>
                <div className="row-end">Начать</div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2>История</h2>
        {logs.length === 0 ? <span className="sub">Пока пусто — первая тренировка появится здесь.</span> : (
          <div className="list">
            {logs.slice(0, 10).map((l) => (
              <div className="row" key={l.id}>
                <div className="row-main"><div className="row-title">{l.title}</div><div className="row-sub">{dateRu(l.started_at)} · подходов: {l.sets}</div></div>
                <div className="row-end">{l.completed_at ? '✓' : 'не завершена'}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

type SetState = { reps: string; weight: string; saved: boolean }

function Session({ program, day, onExit, onChanged }: {
  program: Program
  day: ProgramDay
  onExit: () => void
  onChanged: (xp: number) => void
}) {
  // shortcut: unsaved inputs live in component state and are lost on tab switch; saved sets are on the server
  const [logId, setLogId] = useState<number | null>(null)
  const [sets, setSets] = useState<SetState[][]>(() =>
    day.exercises.map((e) => Array.from({ length: e.sets }, () => ({ reps: firstNumber(e.reps), weight: '', saved: false }))),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const savedCount = sets.flat().filter((s) => s.saved).length

  const update = (ei: number, si: number, patch: Partial<SetState>) =>
    setSets((prev) => prev.map((row, i) => (i !== ei ? row : row.map((s, j) => (j === si ? { ...s, ...patch } : s)))))

  async function ensureLog(): Promise<number> {
    if (logId) return logId
    const w = await api<{ id: number }>('/api/workout-logs', postJson({ program_day_id: day.id, title: `${day.day_name} · ${program.name}` }))
    setLogId(w!.id)
    return w!.id
  }

  async function saveSet(ei: number, si: number) {
    const s = sets[ei][si]
    const reps = Number(s.reps)
    const weight = s.weight ? Number(s.weight.replace(',', '.')) : 0
    if (!Number.isInteger(reps) || reps <= 0 || reps > 500) return setError('Повторы: целое число от 1 до 500')
    if (!Number.isFinite(weight) || weight < 0 || weight > 500) return setError('Вес: от 0 до 500 кг')
    setError('')
    setBusy(true)
    try {
      const id = await ensureLog()
      await api(`/api/workout-logs/${id}/sets`, postJson({ exercise_id: day.exercises[ei].exercise_id, set_number: si + 1, reps, weight_kg: weight }))
      update(ei, si, { saved: true })
    } catch {
      setError('Не удалось сохранить подход. Проверьте соединение.')
    } finally {
      setBusy(false)
    }
  }

  async function finish() {
    setBusy(true)
    try {
      const r = await api<{ xp_awarded: number }>(`/api/workout-logs/${logId}/complete`, { method: 'POST' })
      onChanged(r?.xp_awarded ?? 0)
      onExit()
    } catch {
      setError('Не удалось завершить тренировку. Попробуйте ещё раз.')
      setBusy(false)
    }
  }

  function exit() {
    if (savedCount > 0) onChanged(0) // refresh history: the unfinished workout is already on the server
    onExit()
  }

  return (
    <>
      <div className="card-head">
        <h1 style={{ fontSize: 22 }}>{day.day_name}</h1>
        <button className="link" onClick={exit}>Назад</button>
      </div>
      {day.exercises.map((e, ei) => (
        <section className="card" key={ei}>
          <div>
            <div className="row-title">{e.name}</div>
            <div className="sub">План: {e.sets} × {e.reps} · отдых {e.rest_seconds} с</div>
            {e.notes && <div className="sub">{e.notes}</div>}
          </div>
          {sets[ei].map((s, si) => (
            <div className="set-row" key={si}>
              <span className="sub">{si + 1}</span>
              <div className="input-wrap"><input inputMode="numeric" aria-label={`${e.name}, подход ${si + 1}, повторы`} value={s.reps}
                disabled={s.saved} onChange={(ev) => update(ei, si, { reps: ev.target.value })} /><i>повт</i></div>
              <div className="input-wrap"><input inputMode="decimal" aria-label={`${e.name}, подход ${si + 1}, вес`} value={s.weight}
                disabled={s.saved} placeholder="0" onChange={(ev) => update(ei, si, { weight: ev.target.value })} /><i>кг</i></div>
              <button className="check" aria-label={`Сохранить подход ${si + 1}`} aria-pressed={s.saved}
                disabled={s.saved || busy} onClick={() => saveSet(ei, si)}>✓</button>
            </div>
          ))}
        </section>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" disabled={savedCount === 0 || busy} onClick={finish}>
        {savedCount === 0 ? 'Отметьте хотя бы один подход' : `Завершить тренировку · ${savedCount} подх.`}
      </button>
    </>
  )
}
