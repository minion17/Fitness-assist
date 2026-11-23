import { useEffect, useRef, useState } from 'react'
import type { ProfileData, Recommendation } from './profile'
import Library from './Library'
import { api, postJson, publicGet } from './telegram'
import { lastLabel, nextDay, type Effort, type Last, type Program, type ProgramDay, type PlannedExercise, type WorkoutLog } from './types'
import Empty from './Empty'
import translatedCatalog from '../../content/exercises/translated_exercises.json'
import exerciseCatalog from '../../content/exercises/exercises.json'
import KettlebellExercise, { getExerciseGuideImage, hasExerciseGuide } from './KettlebellExercise'
import ProgramBuilder, { type ExerciseOption, type ProgramDraft } from './ProgramBuilder'
import { advice, nextWeight } from './progression'
import { Chevron, Sheet } from './ui'
import { plural } from './plural'
import { Icon } from './icons'
import { workoutMinutes } from './workoutTime'
import { loadActive, saveActive } from './activeWorkout'
import MuscleMap from './MuscleMap'
import PastWorkout from './PastWorkout'
import { MUSCLES, type Muscle } from './muscles'
import { haptic, sound } from './haptics'
import { morph } from './motion'
import { cancel, localId, real, sendOrQueue } from './offline'

const draftNames = new Map<number, string>() // demo mode: names of library exercises put into a local program
const LEVEL: Record<string, string> = { beginner: 'Новичок', intermediate: 'Средний', advanced: 'Продвинутый' }
const firstNumber = (s: string) => s.match(/\d+/)?.[0] ?? ''
const dateRu = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })

function ExerciseThumbnail({ name, index }: { name: string; index: number }) {
  const image = getExerciseGuideImage(name)
  return <span className={image ? 'exercise-thumbnail' : 'exercise-thumbnail is-empty'} aria-hidden="true">
    {image && <img src={image} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none' }} />}
    <span>{index + 1}</span>
  </span>
}

export default function Workouts({ programs, logs, programId, onSelectProgram, canEdit, onChanged, recommended = null, onProgramsChange, onRecord, profile = null, onMinimize }: {
  onMinimize?: () => void // leave a workout open and go to Home
  onRecord?: (text: string) => void // a personal record: confetti in the app
  profile?: ProfileData | null // equipment and level for "Собрать тренировку"
  recommended?: Recommendation | null
  programs: Program[] | null
  logs: WorkoutLog[]
  programId: number | null
  onSelectProgram: (id: number | null) => void
  canEdit: boolean
  onChanged: (xp: number) => void
  onProgramsChange?: (programs: Program[]) => void
}) {
  const [historyLog, setHistoryLog] = useState<WorkoutLog | null>(null)
  const [historySets, setHistorySets] = useState<{ id: number; name: string; set_number: number; reps: number | null; duration_seconds: number | null; weight_kg: number }[] | null>(null)
  const [historyError, setHistoryError] = useState(false)
  const [personalList, setPersonalList] = useState(false)
  const [past, setPast] = useState<number | null>(null) // a program day being written in afterwards
  useEffect(() => {
    if (!historyLog) return
    let active = true
    setHistorySets(null); setHistoryError(false)
    api<{ sets: { id: number; name: string; set_number: number; reps: number | null; duration_seconds: number | null; weight_kg: number }[] }>(`/api/workout-logs/${historyLog.id}`)
      .then(data => { if (active) { if (data) setHistorySets(data.sets); else setHistoryError(true) } })
      .catch(() => { if (active) setHistoryError(true) })
    return () => { active = false }
  }, [historyLog])
  const [guideExercise, setGuideExercise] = useState<PlannedExercise | null>(null)
  const [previewProgramId, setPreviewProgramId] = useState<number | null>(null)
  // a workout left to log food comes back where it was (activeWorkout.ts)
  const [session, setSession] = useState<ProgramDay | null>(() => {
    const a = loadActive()
    return a ? programs?.find((p) => p.id === a.programId)?.days.find((d) => d.id === a.dayId) ?? null : null
  })
  const [editing, setEditing] = useState<Program | 'new' | null>(null)
  const [exercises, setExercises] = useState<ExerciseOption[]>([])
  const [builderError, setBuilderError] = useState('')
  const [library, setLibrary] = useState<'browse' | 'build' | null>(null)
  const program = programs?.find((p) => p.id === programId)
  const programsButton = <button className="programs-entry" aria-label="Программы" onClick={() => setPersonalList(true)}><span className="programs-entry-text"><strong>Программы</strong><span>{program ? `Выбрана: ${program.name}` : 'Программа не выбрана'}</span></span><span className="programs-entry-action">Открыть <span aria-hidden="true">→</span></span></button>

  async function openBuilder(p: Program | 'new') {
    try {
      const list = canEdit
        ? await api<ExerciseOption[]>('/api/exercises')
        : await publicGet<ExerciseOption[]>('/api/exercises').catch(() => (programs ?? []).flatMap(program => program.days.flatMap(day => day.exercises.map(exercise => ({ id: exercise.exercise_id, name: exercise.name })))))

      const localExercises = canEdit ? [] : [...exerciseCatalog, ...translatedCatalog].map((exercise, index) => ({
        id: -100000 - index, name: exercise.name, equipment: exercise.equipment, is_bodyweight: exercise.is_bodyweight,
      }))
      const existingNames = new Set((list ?? []).map(exercise => exercise.name.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')))
      const previousExercises = (programs ?? []).flatMap(program => program.days.flatMap(day => day.exercises.map(exercise => ({ id: exercise.exercise_id, name: exercise.name }))))
      setExercises([...new Map([...previousExercises, ...(list ?? []), ...localExercises.filter(exercise => !existingNames.has(exercise.name.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')))].map(exercise => [exercise.id, exercise])).values()])
      setEditing(p)
    } catch { setBuilderError('Нет связи — упражнения загрузим, как только вернётся интернет') }
  }
  async function saveProgram(draft: ProgramDraft, target: Program | 'new' | null = editing) {
    if (!canEdit) {
      const id = target === 'new' ? -Date.now() : (target as Program).id
      const result: Program = {
        id, name: draft.name, goal: 'custom', level: 'beginner', days_per_week: draft.days.length, description: null, is_personal: true,
        days: draft.days.map((day, index) => ({
          id: day.id ?? -(index + 1), day_name: day.name, day_order: index,
          exercises: day.exercises.map(exercise => ({ ...exercise, name: exercises.find(item => item.id === exercise.exercise_id)?.name ?? draftNames.get(exercise.exercise_id) ?? 'Упражнение', notes: null }))
        }))
      }
      onProgramsChange?.([...(programs ?? []).filter(program => program.id !== id), result])
      onSelectProgram(id)
      setEditing(null)
      return
    }
    const path = target === 'new' ? '/api/programs' : `/api/programs/${(target as Program).id}`
    const result = await api<Program>(path, { ...postJson(draft), method: target === 'new' ? 'POST' : 'PUT' })
    if (!result) throw new Error('No account')
    onProgramsChange?.([...(programs ?? []).filter(p => p.id !== result.id), result])
    onSelectProgram(result.id)
    setEditing(null)
  }

  if (editing) return <ProgramBuilder exercises={exercises} initial={editing === 'new' ? undefined : editing} onSave={saveProgram} onCancel={() => setEditing(null)} onCreateExercise={async name => {
    if (!canEdit) {
      const created = { id: -Date.now(), name }
      setExercises(prev => [...prev, created])
      return created
    }
    const created = await api<ExerciseOption>('/api/exercises', postJson({ name }))
    if (!created) throw new Error('No account')
    setExercises(prev => [...prev.filter(e => e.id !== created.id), created])
    return created
  }} />

  if (library) return <Library canEdit={canEdit} profile={profile} mode={library} onClose={() => setLibrary(null)}
    onSaveWorkout={async (draft, names) => { names?.forEach((n, id) => draftNames.set(id, n)); await saveProgram(draft, 'new'); setLibrary(null) }} />

  if (programs === null) return <><h1>Тренировки</h1><p className="sub">Загружаем программы…</p></>

  if (session && program) {
    return <Session program={program} day={session} onExit={() => morph(() => { saveActive(null); setSession(null) })} onChanged={onChanged} onRecord={onRecord} onMinimize={onMinimize} />
  }

  if (past !== null && program) return <PastWorkout program={program} dayId={past} onDone={onChanged} onClose={() => setPast(null)} />

  if (personalList && previewProgramId !== null) {
    const preview = programs.find(item => item.id === previewProgramId)
    if (preview) return <div className="ready-program-page">
      <div className="card-head"><h1>{preview.name}</h1><button className="link" onClick={() => setPreviewProgramId(null)}>Назад</button></div>
      <span className="sub">{LEVEL[preview.level] ?? preview.level}</span>
      {preview.name.startsWith('Гиря · ') && preview.description && <p className="sub">{preview.description}</p>}
      {preview.days.map(day => <details className="card ready-program-day" key={day.id}>
        <summary><strong>{day.day_name}</strong><span>{day.exercises.length} упр. <Chevron /></span></summary>
        <div>{day.exercises.map((exercise, index) => {
          const canOpen = hasExerciseGuide(exercise.name)
          const info = <><ExerciseThumbnail name={exercise.name} index={index} /><span className="ready-exercise-main"><strong>{exercise.name}</strong><small>{exercise.sets} × {exercise.reps}{exercise.unit === 'seconds' ? ' с' : ' повт.'} · отдых {exercise.rest_seconds} с</small></span>{canOpen && <span className="ready-exercise-arrow" aria-hidden="true"><Chevron dir="right" /></span>}</>
          return canOpen
            ? <button className="ready-exercise-row" key={index} onClick={() => setGuideExercise(exercise)} aria-label={`Открыть ${exercise.name}`}>{info}</button>
            : <div className="ready-exercise-row" key={index}>{info}</div>
        })}</div>
      </details>)}
      {guideExercise && <KettlebellExercise exercise={guideExercise} onClose={() => setGuideExercise(null)} />}
      <button className="btn" onClick={() => { onSelectProgram(preview.id); setPreviewProgramId(null); setPersonalList(false) }}>{preview.id === programId ? 'Открыть программу' : 'Выбрать программу'}</button>
    </div>
  }

  if (personalList) return <div className="personal-programs">
    <div className="card-head programs-page-head"><h1>Программы</h1><button className="link" onClick={() => setPersonalList(false)}>Назад</button></div>
    <div className="personal-programs-list">
      <div className="programs-section-title"><h2>Мои программы</h2><span className="sub">{programs.filter(p => p.is_personal).length}</span></div>
      {!programs.some(p => p.is_personal) && <div className="programs-empty"><p>У тебя пока нет своих программ</p><span className="sub">Создай программу под свои тренировки</span></div>}
      {programs.filter(p => p.is_personal).map(p => <section className={p.id === programId ? 'card program-card is-selected' : 'card program-card'} key={p.id}>
        <div className="card-head"><h2>{p.name}</h2>{p.id === programId && <span className="program-selected">✓ Выбрана</span>}</div>
        <span className="sub">Тренировок: {p.days.length}</span>
        <div className="program-card-actions"><button className="program-select" onClick={() => { onSelectProgram(p.id); setPersonalList(false) }}>{p.id === programId ? 'Открыть' : 'Выбрать'}</button>{(canEdit || p.id < 0) && <button className="link" onClick={() => openBuilder(p)}>Изменить</button>}</div>
      </section>)}
      {programs.some(p => !p.is_personal) && <div className="programs-section-title"><h2>Готовые программы</h2></div>}
      {(() => {
        const ready = programs.filter(p => !p.is_personal)
        const groups = [
          { key: 'beginner', title: 'Для новичков' },
          { key: 'intermediate', title: 'Средний уровень' },
          { key: 'advanced', title: 'Для опытных' },
          ...(ready.some(p => !['beginner', 'intermediate', 'advanced'].includes(p.level)) ? [{ key: 'other', title: 'Другие программы' }] : []),
        ]
        return groups.map(group => {
          const items = ready.filter(p => group.key === 'other' ? !['beginner', 'intermediate', 'advanced'].includes(p.level) : p.level === group.key)
            .sort((a, b) => Number(b.id === recommended?.program_id) - Number(a.id === recommended?.program_id))
          if (!items.length) return null // an empty level is just a dead row to tap
          return <details className="program-level-group" key={group.key}>
            <summary><strong>{group.title}</strong><span className="program-level-meta">{items.length}<Chevron /></span></summary>
            <div className="program-level-content">
              {items.length === 0 && <p className="sub">Программ пока нет</p>}
              {items.map(p => <section className={p.id === programId ? 'card program-card is-selected' : 'card program-card'} key={p.id}>
                <div className="card-head"><h2>{p.name}</h2>{p.id === programId && <span className="program-selected">✓ Выбрана</span>}</div>
                {p.id === recommended?.program_id && <span className="chip chip-accent">★ Подходит тебе</span>}
                <div className="program-card-actions"><button className="link" onClick={() => setPreviewProgramId(p.id)}>Посмотреть тренировки</button><button className="program-select" onClick={() => { onSelectProgram(p.id); setPersonalList(false) }}>{p.id === programId ? 'Открыть' : 'Выбрать'}</button></div>
              </section>)}
            </div>
          </details>
        })
      })()}
    </div>
    <button className="btn" onClick={() => openBuilder('new')}>Создать программу</button>
    {!canEdit && <p className="sub">В деморежиме программа доступна до обновления страницы.</p>}
    {builderError && <p className="error" role="alert">{builderError}</p>}
  </div>

  const libraryEntries = <div className="lib-entries">
        <button className="card lib-entry" onClick={() => setLibrary('browse')}><span className="lib-entry-icon" aria-hidden="true"><Icon name="book" size={22} /></span><b>Упражнения</b><small>Техника и мышцы</small></button>
        <button className="card lib-entry" onClick={() => setLibrary('build')}><span className="lib-entry-icon" aria-hidden="true"><Icon name="target" size={22} /></span><b>Собрать тренировку</b><small>На нужные мышцы</small></button>
      </div>

  if (!program) return <><h1>Тренировки</h1>{programsButton}{libraryEntries}<p className="sub">Выбери программу, чтобы начать тренировки.</p></>

  const next = nextDay(program, logs)
  return (
    <>
      <h1>Тренировки</h1>
      {programsButton}
      {libraryEntries}
      {builderError && <p className="error" role="alert">{builderError}</p>}

      <section className="card workout-feature">
        <div className="card-head"><h2>Следующая тренировка</h2></div>
        <div className="workout-next-title">{next.day_name}</div>
        <WorkoutPreview day={next} />
        <div className="list">
          {next.exercises.map((e, i) => (
            <div className="row" key={i}>
              <ExerciseThumbnail name={e.name} index={i} />
              <div className="row-main"><div className="row-title">{e.superset ? `Суперсет ${e.superset} · ` : ''}{e.name}</div><div className="row-sub">{e.sets} × {e.reps}{e.unit === 'seconds' ? ' сек' : ''}</div></div>
            </div>
          ))}
        </div>
        {canEdit
          ? <><button className="btn" onClick={() => morph(() => setSession(next))}>Начать тренировку</button>
            <button className="link past-entry" onClick={() => setPast(next.id)}>Тренировался без телефона? Записать после</button></>
          : <p className="sub">Демо-режим: чтобы записывать тренировки, открой приложение из Telegram.</p>}
      </section>

      {canEdit && program.days.length > 1 && (
        <section className="card">
          <h2>Другие дни программы</h2>
          <div className="list">
            {program.days.filter((d) => d.id !== next.id).map((d) => (
              <button className="row row-btn" key={d.id} onClick={() => morph(() => setSession(d))}>
                <div className="row-main"><div className="row-title">{d.day_name}</div><div className="row-sub">{d.exercises.length} {plural(d.exercises.length, 'упражнение', 'упражнения', 'упражнений')}</div></div>
                <div className="row-end row-go">Начать</div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2>История</h2>
        {logs.length === 0 ? <Empty art="workouts" title="Здесь будет история тренировок" text="Проведи первую — подходы и веса сохранятся, а в следующий раз подскажем, с чего начать." /> : (
          <div className="list">
            {logs.slice(0, 10).map((l) => (
              <button className="row row-btn history-entry" key={l.id} onClick={() => setHistoryLog(l)}>
                <div className="row-main"><div className="row-title">{l.title.replace(/^(День\s+\d+)\s*:[^·]+·\s*/i, '$1 · ')}</div><div className="row-sub">{dateRu(l.started_at)} · подходов: {l.sets}{l.after ? ' · записано после' : ''}</div></div>
                <div className="row-end">{l.completed_at ? '✓' : 'не завершена'}</div>
              </button>
            ))}
          </div>
        )}
      </section>
      {historyLog && <Sheet title="Тренировка" onClose={() => setHistoryLog(null)}>
        <h2>{historyLog.title}</h2><p className="sub">{dateRu(historyLog.started_at)} · подходов: {historyLog.sets}</p>
        {historyError ? <p className="error" role="alert">Не удалось загрузить подходы.</p> : !historySets ? <p className="sub">Загрузка…</p> : historySets.length === 0 ? <p className="sub">Подходы не записаны.</p> : <div className="list">{historySets.map(item => <div className="row" key={item.id}><div className="row-main"><div className="row-title">{item.name}</div><div className="row-sub">Подход {item.set_number}</div></div><span className="row-end">{item.duration_seconds != null ? `${item.duration_seconds} сек` : `${item.reps ?? '—'} повт.`}{item.weight_kg ? ` · ${item.weight_kg} кг` : ''}</span></div>)}</div>}
      </Sheet>}
    </>
  )
}

type SessionTimer =
  | { phase: 'work'; exercise: number; set: number; start: number; stoppedSeconds?: number }
  | { phase: 'rest'; end: number; result: string; ei: number; si: number }

const clockLabel = (seconds: number) =>
  `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
const timedExercise = (exercise: PlannedExercise) => exercise.unit === 'seconds' || /сек/i.test(exercise.reps)

type SetState = { reps: string; weight: string; saved: boolean; id?: number }

type Rest = { until: number; total: number; next: string }

function Session({ program, day, onExit, onChanged, onRecord, onMinimize }: {
  program: Program
  day: ProgramDay
  onExit: () => void
  onMinimize?: () => void // to another tab; the workout stays open (activeWorkout.ts)
  onChanged: (xp: number) => void
  onRecord?: (text: string) => void
}) {
  const [kept] = useState(() => { const a = loadActive(); return a && a.programId === program.id && a.dayId === day.id ? a : null })
  const [rest, setRest] = useState<Rest | null>(() => kept?.rest && kept.rest.until > Date.now() ? kept.rest : null)
  const [now, setNow] = useState(() => Date.now())
  const [startedAt] = useState(() => kept?.startedAt ?? Date.now())
  const [records, setRecords] = useState<string[]>(kept?.records ?? [])
  const [summary, setSummary] = useState<{ minutes: number; sets: number; tonnage: number; xp: number; note?: string | null; tip?: string | null } | null>(null)
  useEffect(() => { // the clock in the header ticks every second
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => { // the tab bar hides for the workout: more room, no stray taps
    document.body.classList.add('in-session')
    return () => document.body.classList.remove('in-session')
  }, [])
  useEffect(() => {
    if (!rest) return
    const t = setInterval(() => {
      setNow(Date.now())
      if (Date.now() < rest.until) return
      // over while the app is open: buzz here and drop the Telegram message queued for the background case
      haptic('success')
      sound('chime')
      if (document.visibilityState === 'visible') api('/api/rest-timer', { method: 'DELETE' }).catch(() => {})
      setRest(null)
    }, 250)
    return () => clearInterval(t)
  }, [rest])

  function startRest(seconds: number, next: string) {
    setRest({ until: Date.now() + seconds * 1000, total: seconds, next })
    setNow(Date.now())
    api('/api/rest-timer', postJson({ seconds, next })).catch(() => {}) // a message if they leave the app meanwhile
  }
  function skipRest() {
    setRest(null)
    api('/api/rest-timer', { method: 'DELETE' }).catch(() => {})
  }
  // shortcut: unsaved inputs live in component state and are lost on tab switch; saved sets are on the server
  const [logId, setLogId] = useState<number | null>(kept?.logId ?? null)
  const [sets, setSets] = useState<SetState[][]>(() => kept?.sets ?? 
    day.exercises.map((e) => Array.from({ length: e.sets }, (_, i) => ({ reps: firstNumber(e.reps), weight: e.planned_weights?.[i] == null ? '' : String(e.planned_weights[i]), saved: false }))),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [last, setLast] = useState<Last>({})
  const [cur, setCur] = useState(kept?.cur ?? 0) // the exercise on screen ("player": one at a time)
  const [list, setList] = useState(false)  // or all of them as a list
  const [guideExercise, setGuideExercise] = useState<PlannedExercise | null>(null)
  const [timer, setTimer] = useState<SessionTimer | null>(() => kept?.restClock && kept.restClock.end > Date.now() ? { phase: 'rest', ...kept.restClock } : null)
  useEffect(() => {
    if (!timer || (timer.phase === 'work' && timer.stoppedSeconds !== undefined)) return
    const id = window.setInterval(() => {
      const time = Date.now()
      setNow(time)
      if (timer.phase === 'rest' && time >= timer.end) window.clearInterval(id)
    }, 200)
    return () => window.clearInterval(id)
  }, [timer])
  function startWork(exercise: number, set: number) {
    if (busy || timer?.phase === 'work' || set < 0) return
    const start = Date.now()
    setError('')
    setNow(start)
    setTimer({ phase: 'work', start, exercise, set })
  }

  useEffect(() => {
    let stale = false
    api<Last>(`/api/exercises/last?ids=${day.exercises.map((e) => e.exercise_id).join(',')}`).then((r) => {
      if (stale || !r) return
      setLast(r)
      // empty weight fields take last time's weight for the same set (or the last set done)
      setSets((prev) => prev.map((row, ei) => {
        const done = r[day.exercises[ei].exercise_id]?.sets
        const up = nextWeight(done, day.exercises[ei].reps, r[day.exercises[ei].exercise_id]?.effort) // every set hit the top last time: a bit heavier
        return !done?.length ? row : row.map((x, si) => x.saved || x.weight !== '' ? x
          : { ...x, weight: String(up ?? ((done[si] ?? done[done.length - 1]).weight_kg || '')) })
      }))
    }).catch(() => {})  // hint only: the workout works without it
    return () => { stale = true }
  }, [day])

  const savedCount = sets.flat().filter((s) => s.saved).length

  const update = (ei: number, si: number, patch: Partial<SetState>) =>
    setSets((prev) => prev.map((row, i) => (i !== ei ? row : row.map((s, j) => (j === si ? { ...s, ...patch } : s)))))

  // Without a connection the workout goes on: it gets a local id, and it and its sets wait on the phone (offline.ts)
  const [offline, setOffline] = useState(false)
  const send = <T,>(path: string, init: RequestInit) => api<T>(path, init)

  async function ensureLog(): Promise<number> {
    if (logId) return real(logId)
    const local = localId()
    const body = { program_day_id: day.id, title: `${day.day_name} · ${program.name}`, started_at: new Date(startedAt).toISOString() }
    const r = await sendOrQueue<{ id: number }>({ path: '/api/workout-logs', body, local, kind: 'workout', name: day.day_name }, send)
    const id = r.queued ? local : r.value!.id
    if (r.queued) setOffline(true)
    setLogId(id)
    return id
  }

  async function saveSet(ei: number, si: number, measuredSeconds?: number) {
    if (busy || sets[ei][si].saved || (timer?.phase === 'work' && measuredSeconds === undefined)) return
    const s = sets[ei][si]
    const reps = measuredSeconds ?? Number(s.reps)
    const timed = timedExercise(day.exercises[ei])
    const weight = s.weight ? Number(s.weight.replace(',', '.')) : 0
    if (!Number.isInteger(reps) || reps <= 0 || reps > (timed ? 86400 : 500)) return setError(timed ? 'Время: укажи секунды' : 'Повторы: целое число от 1 до 500')
    if (!Number.isFinite(weight) || weight < 0 || weight > 500) return setError('Вес: от 0 до 500 кг')
    setError('')
    setBusy(true)
    try {
      const id = await ensureLog()
      const local = localId()
      const sent = await sendOrQueue<{ id: number; record: { kind: string } | null }>({ path: `/api/workout-logs/${id}/sets`, local, kind: 'workout',
        name: day.exercises[ei].name, body: { exercise_id: day.exercises[ei].exercise_id, set_number: si + 1, ...(timed ? { duration_seconds: reps } : { reps }), weight_kg: weight } }, send)
      const r = sent.queued ? null : sent.value
      setOffline(sent.queued)
      update(ei, si, { saved: true, reps: String(reps), id: sent.queued ? local : r?.id })
      const rest = day.exercises[ei].rest_seconds
      const time = Date.now()
      setNow(time)
      setTimer({ phase: 'rest', end: time + rest * 1000, result: `Подход ${si + 1} · ${reps} ${timed ? 'с' : 'повт.'}`, ei, si })
      if (weight) setSets(prev => prev.map((row, i) => i !== ei ? row : row.map((x, j) => j > si && !x.saved && x.weight === '' ? { ...x, weight: s.weight } : x)))
      if (r?.record) { onRecord?.(`🏆 Личный рекорд: ${day.exercises[ei].name}`); setRecords((x) => x.includes(day.exercises[ei].name) ? x : [...x, day.exercises[ei].name]) }
      const nextName = day.exercises[ei + 1]?.name ?? day.exercises[ei].name
      if (rest >= 10) startRest(rest, nextName)
      haptic('save'); sound('click')
      const group = day.exercises[ei].superset
      if (group && !list && ei === cur) {
        const members = day.exercises.map((exercise, index) => exercise.superset === group ? index : -1).filter(index => index >= 0)
        const later = members.filter(index => index > ei && sets[index][si] && !sets[index][si].saved)
        const earlier = members.filter(index => index <= ei && sets[index][si + 1] && !sets[index][si + 1].saved)
        const next = later[0] ?? earlier[0] ?? (Math.max(...members) + 1 < day.exercises.length ? Math.max(...members) + 1 : undefined)
        if (next !== undefined) setCur(next)
      } else if (!list && ei === cur && cur < day.exercises.length - 1 && sets[ei].every((x, j) => j === si || x.saved)) {
        setCur(ei + 1)
      }
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Подход не сохранился — попробуй ещё раз')
    } finally {
      setBusy(false)
    }
  }

  /** A set saved by mistake: off the server, back to the inputs. */
  async function undoSet(ei: number, si: number) {
    const id = sets[ei][si].id
    if (!logId || !id || busy) return
    setBusy(true)
    try {
      // still on the phone: just taken out of the queue; otherwise deleted (or queued to be)
      if (!(id < 0 && real(id) === id && cancel(id))) await sendOrQueue({ path: `/api/workout-logs/${logId}/sets/${id}`, method: 'DELETE', kind: 'workout' }, send)
      update(ei, si, { saved: false, id: undefined })
      if (rest) skipRest()
      setTimer(null)
      setCur(ei)
    } catch { setError('Не получилось отменить подход — попробуй ещё раз') }
    setBusy(false)
  }

  function stopWork() {
    if (timer?.phase !== 'work' || busy) return
    const seconds = timer.stoppedSeconds ?? Math.max(1, Math.floor((Date.now() - timer.start) / 1000))
    setTimer({ ...timer, stoppedSeconds: seconds })
    void saveSet(timer.exercise, timer.set, seconds)
  }

  async function finish() {
    if (rest) skipRest()
    setBusy(true)
    try {
      const sent = await sendOrQueue<{ xp_awarded: number; xp_note?: string | null; tip?: string | null }>({ path: `/api/workout-logs/${logId}/complete`, kind: 'workout',
        name: day.day_name, body: { completed_at: new Date().toISOString() } }, send)
      const r = sent.queued ? { xp_awarded: 0, xp_note: 'Нет связи — тренировка сохранена на телефоне и отправится сама, XP придёт тогда же' } : sent.value
      if (!sent.queued) onChanged(r?.xp_awarded ?? 0)
      const done = sets.flat().filter((x) => x.saved)
      const tonnage = sets.reduce((n, row, ei) => n + (timedExercise(day.exercises[ei]) ? 0
        : row.filter((x) => x.saved).reduce((m, x) => m + Number(x.reps) * (Number(x.weight.replace(',', '.')) || 0), 0)), 0)
      saveActive(null)
      setSummary({ minutes: Math.max(1, Math.round((Date.now() - startedAt) / 60000)), sets: done.length, tonnage: Math.round(tonnage), xp: r?.xp_awarded ?? 0, note: r?.xp_note ?? null, tip: sent.queued ? null : sent.value?.tip ?? null })
      setBusy(false)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Тренировка не завершилась — попробуй ещё раз')
      setBusy(false)
    }
  }

  useEffect(() => { // kept on the phone as it goes; cleared on «Назад» and at the summary
    if (summary) return
    const restClock = timer?.phase === 'rest' ? { end: timer.end, result: timer.result, ei: timer.ei, si: timer.si } : null
    saveActive({ programId: program.id, dayId: day.id, title: day.day_name, logId, startedAt, cur, sets, records, rest, restClock })
  }, [program.id, day.id, day.day_name, logId, startedAt, cur, sets, records, rest, timer, summary])

  function exit() {
    if (rest) skipRest()
    if (savedCount > 0) onChanged(0) // refresh history: the unfinished workout is already on the server
    onExit()
  }

  const total = day.exercises.length
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const timedOf = (ei: number) => day.exercises[ei].unit === 'seconds' || /сек/i.test(day.exercises[ei].reps)
  /** ± on the current set without the keyboard: reps by 1 (seconds by 5), weight by 2.5 kg. */
  const nudge = (ei: number, si: number, field: 'reps' | 'weight', d: number) => {
    const v = Number(String(sets[ei][si][field]).replace(',', '.')) || 0
    update(ei, si, { [field]: String(Math.max(0, Math.round((v + d) * 10) / 10)).replace('.', ',') })
    haptic('select')
  }
  const shown = list ? day.exercises.map((e, ei) => [e, ei] as const) : total ? [[day.exercises[cur], cur] as const] : []
  const doneEx = (ei: number) => sets[ei].length > 0 && sets[ei].every((x) => x.saved)

  const totalSets = sets.flat().length
  if (summary) return (
    <section className="card workout-summary" aria-live="polite">
      <div className="workout-summary-icon" aria-hidden="true">🏁</div>
      <h1>Тренировка завершена</h1>
      <p className="sub">{day.day_name}</p>
      <div className="workout-summary-grid">
        <div><b>{summary.minutes}</b><span>мин</span></div>
        <div><b>{summary.sets}</b><span>{plural(summary.sets, 'подход', 'подхода', 'подходов')}</span></div>
        <div><b>{summary.tonnage.toLocaleString('ru-RU')}</b><span>кг поднято</span></div>
      </div>
      {records.length > 0 && <ul className="workout-records">{records.map((r) => <li key={r}>🏆 Личный рекорд: {r}</li>)}</ul>}
      {summary.xp > 0 && <p className="pos">+{summary.xp} XP</p>}
      {!summary.xp && summary.note && <p className="sub">{summary.note}</p>}
      {summary.tip && <p className="workout-tip">⚡ {summary.tip}</p>}
      {logId && <EffortPick logId={logId} />}
      <button className="btn" onClick={onExit}>Готово</button>
    </section>
  )

  return (
    <>
      <div className="card-head">
        <h1 className="session-title" title={day.day_name}>{day.day_name}</h1>
        {onMinimize && <button className="link" onClick={onMinimize} aria-label="Свернуть тренировку и открыть Главную">Свернуть</button>}
        <button className="link" onClick={exit}>Выйти</button>
      </div>
      <div className="session-progress" aria-label={`Сделано ${savedCount} из ${totalSets} подходов`}>
        <div className="bar thin"><i style={{ width: `${totalSets ? (savedCount / totalSets) * 100 : 0}%`, background: 'var(--accent)' }} /></div>
        <span className="sub"><span>{clockLabel(Math.floor((now - startedAt) / 1000))}</span> · {savedCount} из {totalSets} {plural(totalSets, 'подхода', 'подходов', 'подходов')}</span>
      </div>
      {total > 1 && (
        <div className="player-top">
          <div className="player-dots" role="tablist" aria-label="Упражнения">
            {day.exercises.map((e, ei) => (
              <button key={ei} role="tab" aria-selected={!list && ei === cur} aria-label={`${ei + 1}. ${e.name}`}
                className={doneEx(ei) ? 'done' : ''} onClick={() => { setList(false); setCur(ei) }} />
            ))}
          </div>
          <button className="link" onClick={() => setList(!list)}>{list ? 'По одному' : 'Все упражнения'}</button>
        </div>
      )}
      {timer?.phase === 'work' && <div className="session-clock">
        <div><small>{day.exercises[timer.exercise].name} · подход {timer.set + 1}</small>
          <strong role="timer">{clockLabel(timer.stoppedSeconds ?? Math.max(0, Math.floor((now - timer.start) / 1000)))}</strong></div>
        <button className="session-clock-action" onClick={stopWork} disabled={busy}>
          {busy ? 'Сохраняем…' : timer.stoppedSeconds !== undefined ? 'Сохранить подход' : 'Завершить подход'}</button>
        {timer.stoppedSeconds !== undefined && !busy && <button className="link" onClick={() => setTimer(null)}>Сбросить</button>}
      </div>}
      {timer?.phase === 'rest' && <div className="session-clock rest-clock">
        <div><small><span>{timer.result}</span>{sets[timer.ei]?.[timer.si]?.id && <> · <button className="link inline-undo" disabled={busy} onClick={() => undoSet(timer.ei, timer.si)}>Отменить</button></>}</small><strong>{now < timer.end ? 'Отдых' : 'Отдых завершён'} <span role="timer">{clockLabel(Math.max(0, Math.ceil((timer.end - now) / 1000)))}</span></strong></div>
        <button className="link" onClick={() => { skipRest(); setTimer(null) }}>{now < timer.end ? 'Пропустить' : 'Готово'}</button>
      </div>}
      {shown.map(([e, ei]) => {
        const nextSet = sets[ei].findIndex(s => !s.saved)
        const timed = timedExercise(e)
        const setTable = (
          <>
          <div className="session-set-labels" aria-hidden="true"><span>Подход</span><span>{timed ? 'Время' : 'Повторы'}</span><span>Вес</span><span>Готово</span></div>
          {sets[ei].map((s, si) => (
            <div className={si === nextSet ? 'set-row current' : 'set-row'} key={si}>
              <span className="sub">{si + 1}</span>
              <div className="input-wrap"><input inputMode="numeric" aria-label={`${e.name}, подход ${si + 1}, ${timed ? 'секунды' : 'повторы'}`} value={s.reps}
                disabled={s.saved} onChange={(ev) => update(ei, si, { reps: ev.target.value })} /><i>{timed ? 'сек' : 'повт.'}</i></div>
              <div className="input-wrap"><input inputMode="decimal" aria-label={`${e.name}, подход ${si + 1}, вес`} value={s.weight}
                disabled={s.saved} placeholder="0" onChange={(ev) => update(ei, si, { weight: ev.target.value })} /><i>кг</i></div>
              <button className="check" aria-label={`Сохранить подход ${si + 1}`} aria-pressed={s.saved}
                disabled={s.saved || busy || timer?.phase === 'work'} onClick={() => saveSet(ei, si)}>✓</button>
            </div>
          ))}
          </>
        )
        return <section className={list ? 'session-exercise compact-session' : 'session-exercise compact-session player'} key={ei}
          onPointerDown={(ev) => { swipe.current = list ? null : { x: ev.clientX, y: ev.clientY } }}
          onPointerUp={(ev) => {
            const start = swipe.current
            swipe.current = null
            if (!start) return
            const dx = ev.clientX - start.x
            if (Math.abs(dx) < 60 || Math.abs(dx) < 2 * Math.abs(ev.clientY - start.y)) return
            const next = cur + (dx < 0 ? 1 : -1)
            if (next >= 0 && next < total) { haptic('select'); setCur(next) }
          }}>
          {!list && total > 1 && <span className="sr-only">Упражнение {ei + 1} из {total}</span> /* the dots above show it */}
          <div className="session-exercise-title">
            {hasExerciseGuide(e.name)
              ? <button className="session-guide-trigger" onClick={() => setGuideExercise(e)} aria-label={`Как выполнять ${e.name}`}>
                  <ExerciseThumbnail name={e.name} index={ei} />
                  <span className="row-title">{e.name}<small>Как выполнять →</small></span>
                </button>
              : <div className="row-title">{e.name}</div>}
            {e.superset && !timed && <small className="sub">{program.name.startsWith('Гиря ·') ? 'Круг' : 'Суперсет'} {e.superset}</small>}
            <dl className="session-prescription">
              <div><dt>Подходы</dt><dd>{e.sets} × {e.reps}{timed && !/сек/i.test(e.reps) ? ' с' : ''}</dd></div>
              {e.rest_seconds > 0 && <div><dt>Отдых</dt><dd>{e.rest_seconds} с</dd></div>}
            </dl>
            {e.notes && <details className="session-note"><summary>Подсказка</summary><p>{e.notes}</p></details>}
            {last[e.exercise_id]?.sets.length ? (
              <div className="sub session-last">В прошлый раз ({new Date(last[e.exercise_id].date + 'T12:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}): {lastLabel(last[e.exercise_id].sets)}</div>
            ) : null}
            {nextWeight(last[e.exercise_id]?.sets, e.reps, last[e.exercise_id]?.effort) ? (
              <div className="session-up">📈 Все подходы были по {e.reps.match(/\d+/g)?.pop()} — сегодня попробуй {String(nextWeight(last[e.exercise_id]?.sets, e.reps, last[e.exercise_id]?.effort)).replace('.', ',')} кг</div>
            ) : advice(last[e.exercise_id], e.reps) && <div className="session-up">💡 {advice(last[e.exercise_id], e.reps)}</div>}
          </div>
          {timed ? <>
            {nextSet >= 0 && timer?.phase !== 'work' &&
              <div className="session-start"><span>{e.superset ? 'Круг' : 'Подход'} {nextSet + 1} из {e.sets}</span>
                <button className="session-clock-action" disabled={busy} onClick={() => startWork(ei, nextSet)}>Засечь время</button></div>}
            {sets[ei].some(s => s.saved) && <div className="session-splits">{sets[ei].map((s, i) => s.saved &&
              <span key={i}>✓ {i + 1} · {clockLabel(Number(s.reps))}</span>)}</div>}
            <details className="session-manual"><summary>Вес и подходы</summary>{setTable}</details>
          </> : list ? setTable : <>
            {sets[ei].some(s => s.saved) && <div className="session-splits">{sets[ei].map((s, i) => s.saved &&
              <span key={i}>✓ {i + 1} · {s.reps}{s.weight && s.weight !== '0' ? ` × ${s.weight}` : ''}</span>)}</div>}
            <details className="session-manual"><summary>Все подходы — поправить</summary>{setTable}</details>
          </>}
          {!timed && !list && (() => {
            const si = sets[ei].findIndex((x) => !x.saved)
            if (si < 0) return null
            const s = sets[ei][si], timed = timedOf(ei)
            return (
              <div className="session-dock">
                <div className="set-nudge" role="group" aria-label={`Подход ${si + 1}: поправить`}>
                  <button aria-label={timed ? 'Минус 5 секунд' : 'Минус повтор'} onClick={() => nudge(ei, si, 'reps', timed ? -5 : -1)}>−{timed ? '5 с' : '1'}</button>
                  <button aria-label={timed ? 'Плюс 5 секунд' : 'Плюс повтор'} onClick={() => nudge(ei, si, 'reps', timed ? 5 : 1)}>+{timed ? '5 с' : '1'}</button>
                  {!timed && <>
                    <button aria-label="Минус 2,5 кг" onClick={() => nudge(ei, si, 'weight', -2.5)}>−2,5 кг</button>
                    <button aria-label="Плюс 2,5 кг" onClick={() => nudge(ei, si, 'weight', 2.5)}>+2,5 кг</button>
                  </>}
                </div>
                <button className="btn set-go" disabled={busy} onClick={() => saveSet(ei, si)}>
                  ✓ Подход {si + 1}: {s.reps || '—'} {timed ? 'с' : 'повт.'}{!timed && s.weight && s.weight !== '0' ? ` × ${s.weight} кг` : ''}
                </button>
              </div>
            )
          })()}
        </section>
      })}
      {!list && total > 1 && (
        <div className="player-nav">
          <button className="link" disabled={cur === 0} onClick={() => setCur(cur - 1)}>← Назад</button>
          {cur < total - 1 && <button className="link" onClick={() => setCur(cur + 1)}>{doneEx(cur) ? 'Следующее →' : 'Дальше →'}</button>}
        </div>
      )}
      {guideExercise && <KettlebellExercise exercise={guideExercise} onClose={() => setGuideExercise(null)} />}
      {error && <p className="error" role="alert">{error}</p>}
      {offline && <p className="queued" role="status">📴 Нет связи — подходы сохраняются на телефоне и отправятся сами</p>}
      {savedCount > 0 && <button className="btn btn-ghost" disabled={busy || timer?.phase === 'work'} onClick={finish}>
        Завершить тренировку · {savedCount} подх.
      </button>}
    </>
  )
}

// main muscles by exercise name, from the bundled catalogs (the same names the programs use)
const MUSCLES_BY_NAME = new Map<string, string[]>(
  [...exerciseCatalog, ...translatedCatalog].map((e) => [e.name.toLocaleLowerCase('ru-RU'), (e as { primary_muscles?: string[] }).primary_muscles ?? []]))

/** Before the start: about how long, how many sets, and which muscles work. */
function WorkoutPreview({ day }: { day: ProgramDay }) {
  const primary = [...new Set(day.exercises.flatMap((e) => MUSCLES_BY_NAME.get(e.name.toLocaleLowerCase('ru-RU')) ?? []))]
  const sets = day.exercises.reduce((n, e) => n + e.sets, 0)
  return (
    <div className="workout-preview">
      <div className="workout-preview-facts">
        <span><Icon name="clock" size={16} /> ≈ {workoutMinutes(day)} мин</span>
        <span>{sets} {plural(sets, 'подход', 'подхода', 'подходов')}</span>
        {primary.length > 0 && <span>{primary.slice(0, 3).map((m) => MUSCLES[m as Muscle] ?? m).join(', ')}{primary.length > 3 ? '…' : ''}</span>}
      </div>
      {primary.length > 0 && <MuscleMap primary={primary} compact />}
    </div>
  )
}

/** "Как ощущения?" after a workout: next time an easy one goes up sooner, a hard one keeps the weight. */
function EffortPick({ logId }: { logId: number }) {
  const [picked, setPicked] = useState<Effort | null>(null)
  const choose = (e: Effort) => {
    setPicked(e)
    haptic('select')
    sendOrQueue({ path: `/api/workout-logs/${logId}/effort`, body: { effort: e }, kind: 'workout' }, (p, i) => api(p, i)).catch(() => setPicked(null))
  }
  if (picked) return <p className="sub effort-done">{{ easy: 'Понял: в следующий раз прибавим.', ok: 'Отлично, держим темп.', hard: 'Понял: в следующий раз держим вес.' }[picked]}</p>
  return (
    <div className="effort">
      <p className="sub">Как ощущения?</p>
      <div className="effort-row">
        <button className="chip" onClick={() => choose('easy')}>😌 Легко</button>
        <button className="chip" onClick={() => choose('ok')}>🙂 Норм</button>
        <button className="chip" onClick={() => choose('hard')}>😮‍💨 Тяжело</button>
      </div>
    </div>
  )
}
