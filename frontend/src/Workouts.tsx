import { useState } from 'react'
import type { Recommendation } from './profile'
import { api, postJson } from './telegram'
import { nextDay, type Program, type ProgramDay, type WorkoutLog } from './types'
import ProgramBuilder, { type ExerciseOption, type ProgramDraft } from './ProgramBuilder'

const LEVEL: Record<string, string> = { beginner: 'Новичок', intermediate: 'Средний', advanced: 'Продвинутый' }
const firstNumber = (s: string) => s.match(/\d+/)?.[0] ?? ''
const dateRu = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })

export default function Workouts({ programs, logs, programId, onSelectProgram, canEdit, onChanged, recommended = null, onProgramsChange }: {
  recommended?: Recommendation | null
  programs: Program[] | null
  logs: WorkoutLog[]
  programId: number | null
  onSelectProgram: (id: number | null) => void
  canEdit: boolean
  onChanged: (xp: number) => void
  onProgramsChange?: (programs: Program[]) => void
}) {
  const [personalList, setPersonalList] = useState(false)
  const [session, setSession] = useState<ProgramDay | null>(null)
  const [editing, setEditing] = useState<Program | 'new' | null>(null)
  const [exercises, setExercises] = useState<ExerciseOption[]>([])
  const [builderError, setBuilderError] = useState('')
  const program = programs?.find((p) => p.id === programId)
  const programsButton = <button className="programs-entry" aria-label="Программы" onClick={() => setPersonalList(true)}><span className="programs-entry-text"><strong>Программы</strong><span>{program ? `Выбрана: ${program.name}` : 'Программа не выбрана'}</span></span><span className="programs-entry-action">Открыть <span aria-hidden="true">→</span></span></button>

  async function openBuilder(p: Program | 'new') {
    try {
      const list = await api<ExerciseOption[]>('/api/exercises')
      setExercises(list ?? [])
      setEditing(p)
    } catch { setBuilderError('Не удалось загрузить упражнения. Попробуйте ещё раз.') }
  }
  async function saveProgram(draft: ProgramDraft) {
    const path = editing === 'new' ? '/api/programs' : `/api/programs/${(editing as Program).id}`
    const result = await api<Program>(path, { ...postJson(draft), method: editing === 'new' ? 'POST' : 'PUT' })
    if (!result) throw new Error('No account')
    onProgramsChange?.([...(programs ?? []).filter(p => p.id !== result.id), result])
    onSelectProgram(result.id)
    setEditing(null)
  }

  if (editing) return <ProgramBuilder exercises={exercises} initial={editing === 'new' ? undefined : editing} onSave={saveProgram} onCancel={() => setEditing(null)} onCreateExercise={async name => {
    const created = await api<ExerciseOption>('/api/exercises', postJson({ name }))
    if (!created) throw new Error('No account')
    setExercises(prev => [...prev.filter(e => e.id !== created.id), created])
    return created
  }} />

  if (programs === null) return <><h1>Тренировки</h1><p className="sub">Загружаем программы…</p></>

  if (session && program) {
    return <Session program={program} day={session} onExit={() => setSession(null)} onChanged={onChanged} />
  }

  if (personalList) return <div className="personal-programs">
    <div className="card-head programs-page-head"><h1>Программы</h1><button className="link" onClick={() => setPersonalList(false)}>Назад</button></div>
    <div className="personal-programs-list">
      <div className="programs-section-title"><h2>Мои программы</h2><span className="sub">{programs.filter(p => p.is_personal).length}</span></div>
      {!programs.some(p => p.is_personal) && <div className="programs-empty"><p>У вас пока нет своих программ</p><span className="sub">Создайте программу под свои тренировки</span></div>}
      {programs.filter(p => p.is_personal).map(p => <section className={p.id === programId ? 'card program-card is-selected' : 'card program-card'} key={p.id}>
        <div className="card-head"><h2>{p.name}</h2>{p.id === programId && <span className="program-selected">✓ Выбрана</span>}</div>
        <span className="sub">Тренировок: {p.days.length}</span>
        <div className="program-card-actions"><button className="program-select" onClick={() => { onSelectProgram(p.id); setPersonalList(false) }}>{p.id === programId ? 'Открыть' : 'Выбрать'}</button>{canEdit && <button className="link" onClick={() => openBuilder(p)}>Изменить</button>}</div>
      </section>)}
      {programs.some(p => !p.is_personal) && <div className="programs-section-title"><h2>Готовые программы</h2></div>}
      {programs.filter(p => !p.is_personal).sort((a, b) => Number(b.id === recommended?.program_id) - Number(a.id === recommended?.program_id)).map(p => <section className={p.id === programId ? 'card program-card is-selected' : 'card program-card'} key={p.id}>
        <div className="card-head"><h2>{p.name}</h2>{p.id === programId && <span className="program-selected">✓ Выбрана</span>}</div>
        {p.id === recommended?.program_id && <span className="chip chip-accent">★ Подходит вам</span>}
        <span className="sub">{LEVEL[p.level] ?? p.level} · {p.days_per_week} в неделю</span>
        {p.description && <span className="sub program-description">{p.description}</span>}
        <div className="program-card-actions"><button className="program-select" onClick={() => { onSelectProgram(p.id); setPersonalList(false) }}>{p.id === programId ? 'Открыть' : 'Выбрать'}</button></div>
      </section>)}
    </div>
    {canEdit && <button className="btn" onClick={() => openBuilder('new')}>Создать программу</button>}
    {builderError && <p className="error" role="alert">{builderError}</p>}
  </div>

  if (!program) return <><h1>Тренировки</h1>{programsButton}<p className="sub">Выберите программу, чтобы начать тренировки.</p></>

  const next = nextDay(program, logs)
  return (
    <>
      <h1>Тренировки</h1>
      {programsButton}
      {builderError && <p className="error" role="alert">{builderError}</p>}

      <section className="card workout-feature">
        <div className="card-head"><h2>Следующая тренировка</h2></div>
        <div className="workout-next-title">{next.day_name}</div>
        <div className="list">
          {next.exercises.map((e, i) => (
            <div className="row" key={i}>
              <div className="dot">{i + 1}</div>
              <div className="row-main"><div className="row-title">{e.superset ? `Суперсет ${e.superset} · ` : ''}{e.name}</div><div className="row-sub">{e.sets} × {e.reps}{e.unit === 'seconds' ? ' сек' : ''}</div></div>
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
    day.exercises.map((e) => Array.from({ length: e.sets }, (_, i) => ({ reps: firstNumber(e.reps), weight: e.planned_weights?.[i] == null ? '' : String(e.planned_weights[i]), saved: false }))),
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
    const timed = day.exercises[ei].unit === 'seconds' || /сек/i.test(day.exercises[ei].reps)
    const weight = s.weight ? Number(s.weight.replace(',', '.')) : 0
    if (!Number.isInteger(reps) || reps <= 0 || reps > (timed ? 86400 : 500)) return setError(timed ? 'Время: укажите секунды' : 'Повторы: целое число от 1 до 500')
    if (!Number.isFinite(weight) || weight < 0 || weight > 500) return setError('Вес: от 0 до 500 кг')
    setError('')
    setBusy(true)
    try {
      const id = await ensureLog()
      await api(`/api/workout-logs/${id}/sets`, postJson({ exercise_id: day.exercises[ei].exercise_id, set_number: si + 1, ...(timed ? { duration_seconds: reps } : { reps }), weight_kg: weight }))
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
        <section className="card session-exercise" key={ei}>
          <div className="session-exercise-title">
            <div className="row-title">{e.superset ? `Суперсет ${e.superset} · ` : ''}{e.name}</div>
            <div className="sub">План: {e.sets} × {e.reps}{e.unit === 'seconds' ? ' сек' : ''} · отдых {e.rest_seconds} с</div>
            {e.notes && <div className="sub">{e.notes}</div>}
          </div>
          <div className="session-set-labels" aria-hidden="true"><span>Подход</span><span>{e.unit === 'seconds' || /сек/i.test(e.reps) ? 'Время' : 'Повторы'}</span><span>Вес</span><span>Готово</span></div>
          {sets[ei].map((s, si) => (
            <div className="set-row" key={si}>
              <span className="sub">{si + 1}</span>
              <div className="input-wrap"><input inputMode="numeric" aria-label={`${e.name}, подход ${si + 1}, ${e.unit === 'seconds' || /сек/i.test(e.reps) ? 'секунды' : 'повторы'}`} value={s.reps}
                disabled={s.saved} onChange={(ev) => update(ei, si, { reps: ev.target.value })} /><i>{e.unit === 'seconds' || /сек/i.test(e.reps) ? 'сек' : 'повт'}</i></div>
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
