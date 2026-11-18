import { useEffect, useRef, useState } from 'react'
import type { ProfileData, Recommendation } from './profile'
import Library from './Library'
import { api, postJson, publicGet, tg } from './telegram'
import { lastLabel, nextDay, type Last, type Program, type ProgramDay, type PlannedExercise, type WorkoutLog } from './types'
import Empty from './Empty'
import translatedCatalog from '../../content/exercises/translated_exercises.json'
import exerciseCatalog from '../../content/exercises/exercises.json'
import KettlebellExercise, { getExerciseGuideImage, hasExerciseGuide } from './KettlebellExercise'
import ProgramBuilder, { type ExerciseOption, type ProgramDraft } from './ProgramBuilder'
import { nextWeight } from './progression'
import { Chevron } from './ui'

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

export default function Workouts({ programs, logs, programId, onSelectProgram, canEdit, onChanged, recommended = null, onProgramsChange, onRecord, profile = null }: {
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
  const [personalList, setPersonalList] = useState(false)
  const [guideExercise, setGuideExercise] = useState<PlannedExercise | null>(null)
  const [previewProgramId, setPreviewProgramId] = useState<number | null>(null)
  const [session, setSession] = useState<ProgramDay | null>(null)
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
    } catch { setBuilderError('Не удалось загрузить упражнения. Попробуйте ещё раз.') }
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
    return <Session program={program} day={session} onExit={() => setSession(null)} onChanged={onChanged} onRecord={onRecord} />
  }

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
          const info = <><ExerciseThumbnail name={exercise.name} index={index} /><span className="ready-exercise-main"><strong>{exercise.name}</strong><small>{exercise.sets} × {exercise.reps}{exercise.unit === 'seconds' ? ' с' : ' повт.'} · отдых {exercise.rest_seconds} с</small></span>{canOpen && <span className="ready-exercise-arrow" aria-hidden="true">→</span>}</>
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
      {!programs.some(p => p.is_personal) && <div className="programs-empty"><p>У вас пока нет своих программ</p><span className="sub">Создайте программу под свои тренировки</span></div>}
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
                {p.id === recommended?.program_id && <span className="chip chip-accent">★ Подходит вам</span>}
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
        <button className="card lib-entry" onClick={() => setLibrary('browse')}><span aria-hidden="true">📚</span><b>Упражнения</b><small>Техника и мышцы</small></button>
        <button className="card lib-entry" onClick={() => setLibrary('build')}><span aria-hidden="true">🎯</span><b>Собрать тренировку</b><small>На нужные мышцы</small></button>
      </div>

  if (!program) return <><h1>Тренировки</h1>{programsButton}{libraryEntries}<p className="sub">Выберите программу, чтобы начать тренировки.</p></>

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
        <div className="list">
          {next.exercises.map((e, i) => (
            <div className="row" key={i}>
              <ExerciseThumbnail name={e.name} index={i} />
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
        {logs.length === 0 ? <Empty art="workouts" title="Здесь будет история тренировок" text="Проведите первую — подходы и веса сохранятся, а в следующий раз подскажем, с чего начать." /> : (
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

type SessionTimer =
  | { phase: 'work'; exercise: number; set: number; start: number; stoppedSeconds?: number }
  | { phase: 'rest'; end: number; result: string }

const clockLabel = (seconds: number) =>
  `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
const timedExercise = (exercise: PlannedExercise) => exercise.unit === 'seconds' || /сек/i.test(exercise.reps)

type SetState = { reps: string; weight: string; saved: boolean }

type Rest = { until: number; total: number; next: string }

function Session({ program, day, onExit, onChanged, onRecord }: {
  program: Program
  day: ProgramDay
  onExit: () => void
  onChanged: (xp: number) => void
  onRecord?: (text: string) => void
}) {
  const [rest, setRest] = useState<Rest | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!rest) return
    const t = setInterval(() => {
      setNow(Date.now())
      if (Date.now() < rest.until) return
      // over while the app is open: buzz here and drop the Telegram message queued for the background case
      tg?.HapticFeedback?.notificationOccurred?.('success')
      try { navigator.vibrate?.([200, 100, 200]) } catch { /* not supported */ }
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
  const [logId, setLogId] = useState<number | null>(null)
  const [sets, setSets] = useState<SetState[][]>(() =>
    day.exercises.map((e) => Array.from({ length: e.sets }, (_, i) => ({ reps: firstNumber(e.reps), weight: e.planned_weights?.[i] == null ? '' : String(e.planned_weights[i]), saved: false }))),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [last, setLast] = useState<Last>({})
  const [cur, setCur] = useState(0)        // the exercise on screen ("player": one at a time)
  const [list, setList] = useState(false)  // or all of them as a list
  const [guideExercise, setGuideExercise] = useState<PlannedExercise | null>(null)
  const [timer, setTimer] = useState<SessionTimer | null>(null)
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
        const up = nextWeight(done, day.exercises[ei].reps) // every set hit the top of the plan last time: a bit heavier
        return !done?.length ? row : row.map((x, si) => x.saved || x.weight !== '' ? x
          : { ...x, weight: String(up ?? ((done[si] ?? done[done.length - 1]).weight_kg || '')) })
      }))
    }).catch(() => {})  // hint only: the workout works without it
    return () => { stale = true }
  }, [day])

  const savedCount = sets.flat().filter((s) => s.saved).length

  const update = (ei: number, si: number, patch: Partial<SetState>) =>
    setSets((prev) => prev.map((row, i) => (i !== ei ? row : row.map((s, j) => (j === si ? { ...s, ...patch } : s)))))

  async function ensureLog(): Promise<number> {
    if (logId) return logId
    const w = await api<{ id: number }>('/api/workout-logs', postJson({ program_day_id: day.id, title: `${day.day_name} · ${program.name}` }))
    setLogId(w!.id)
    return w!.id
  }

  async function saveSet(ei: number, si: number, measuredSeconds?: number) {
    if (busy || sets[ei][si].saved || (timer?.phase === 'work' && measuredSeconds === undefined)) return
    const s = sets[ei][si]
    const reps = measuredSeconds ?? Number(s.reps)
    const timed = timedExercise(day.exercises[ei])
    const weight = s.weight ? Number(s.weight.replace(',', '.')) : 0
    if (!Number.isInteger(reps) || reps <= 0 || reps > (timed ? 86400 : 500)) return setError(timed ? 'Время: укажите секунды' : 'Повторы: целое число от 1 до 500')
    if (!Number.isFinite(weight) || weight < 0 || weight > 500) return setError('Вес: от 0 до 500 кг')
    setError('')
    setBusy(true)
    try {
      const id = await ensureLog()
      const r = await api<{ record: { kind: string } | null }>(`/api/workout-logs/${id}/sets`, postJson({ exercise_id: day.exercises[ei].exercise_id, set_number: si + 1, ...(timed ? { duration_seconds: reps } : { reps }), weight_kg: weight }))
      update(ei, si, { saved: true, reps: String(reps) })
      const rest = day.exercises[ei].rest_seconds
      const time = Date.now()
      setNow(time)
      setTimer(rest > 0 ? { phase: 'rest', end: time + rest * 1000, result: `Подход ${si + 1} · ${reps} ${timed ? 'с' : 'повт.'}` } : null)
      if (weight) setSets(prev => prev.map((row, i) => i !== ei ? row : row.map((x, j) => j > si && !x.saved && x.weight === '' ? { ...x, weight: s.weight } : x)))
      if (r?.record) onRecord?.(`🏆 Личный рекорд: ${day.exercises[ei].name}`)
      const nextName = day.exercises[ei + 1]?.name ?? day.exercises[ei].name
      if (rest >= 10) startRest(rest, nextName)
      tg?.HapticFeedback?.impactOccurred?.('medium')
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
    } catch {
      setError('Не удалось сохранить подход. Проверьте соединение.')
    } finally {
      setBusy(false)
    }
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
      const r = await api<{ xp_awarded: number }>(`/api/workout-logs/${logId}/complete`, { method: 'POST' })
      onChanged(r?.xp_awarded ?? 0)
      onExit()
    } catch {
      setError('Не удалось завершить тренировку. Попробуйте ещё раз.')
      setBusy(false)
    }
  }

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
    tg?.HapticFeedback?.selectionChanged?.()
  }
  const shown = list ? day.exercises.map((e, ei) => [e, ei] as const) : total ? [[day.exercises[cur], cur] as const] : []
  const doneEx = (ei: number) => sets[ei].length > 0 && sets[ei].every((x) => x.saved)

  return (
    <>
      <div className="card-head">
        <h1 style={{ fontSize: 22 }}>{day.day_name}</h1>
        <button className="link" onClick={exit}>Назад</button>
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
        <div><small>{timer.result}</small><strong>{now < timer.end ? 'Отдых' : 'Отдых завершён'} <span role="timer">{clockLabel(Math.max(0, Math.ceil((timer.end - now) / 1000)))}</span></strong></div>
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
                disabled={s.saved} onChange={(ev) => update(ei, si, { reps: ev.target.value })} /><i>{timed ? 'сек' : 'повт'}</i></div>
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
            if (next >= 0 && next < total) { tg?.HapticFeedback?.selectionChanged?.(); setCur(next) }
          }}>
          {!list && total > 1 && <span className="sub">Упражнение {ei + 1} из {total}</span>}
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
            {nextWeight(last[e.exercise_id]?.sets, e.reps) && (
              <div className="session-up">📈 Все подходы были по {e.reps.match(/\d+/g)?.pop()} — сегодня попробуйте {String(nextWeight(last[e.exercise_id]?.sets, e.reps)).replace('.', ',')} кг</div>
            )}
          </div>
          {timed ? <>
            {nextSet >= 0 && timer?.phase !== 'work' &&
              <div className="session-start"><span>{e.superset ? 'Круг' : 'Подход'} {nextSet + 1} из {e.sets}</span>
                <button className="session-clock-action" disabled={busy} onClick={() => startWork(ei, nextSet)}>Засечь время</button></div>}
            {sets[ei].some(s => s.saved) && <div className="session-splits">{sets[ei].map((s, i) => s.saved &&
              <span key={i}>✓ {i + 1} · {clockLabel(Number(s.reps))}</span>)}</div>}
            <details className="session-manual"><summary>Вес и подходы</summary>{setTable}</details>
          </> : setTable}
          {!timed && !list && (() => {
            const si = sets[ei].findIndex((x) => !x.saved)
            if (si < 0) return null
            const s = sets[ei][si], timed = timedOf(ei)
            return (
              <>
                <div className="set-nudge" role="group" aria-label={`Подход ${si + 1}: поправить`}>
                  <button aria-label={timed ? 'Минус 5 секунд' : 'Минус повтор'} onClick={() => nudge(ei, si, 'reps', timed ? -5 : -1)}>−{timed ? '5 с' : '1'}</button>
                  <button aria-label={timed ? 'Плюс 5 секунд' : 'Плюс повтор'} onClick={() => nudge(ei, si, 'reps', timed ? 5 : 1)}>+{timed ? '5 с' : '1'}</button>
                  {!timed && <>
                    <button aria-label="Минус 2,5 кг" onClick={() => nudge(ei, si, 'weight', -2.5)}>−2,5 кг</button>
                    <button aria-label="Плюс 2,5 кг" onClick={() => nudge(ei, si, 'weight', 2.5)}>+2,5 кг</button>
                  </>}
                </div>
                <button className="btn set-go" disabled={busy} onClick={() => saveSet(ei, si)}>
                  ✓ Подход {si + 1}: {s.reps || '—'} {timed ? 'с' : 'повт'}{!timed && s.weight && s.weight !== '0' ? ` × ${s.weight} кг` : ''}
                </button>
              </>
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
      {savedCount > 0 && <button className="btn btn-ghost" disabled={busy || timer?.phase === 'work'} onClick={finish}>
        Завершить тренировку · {savedCount} подх.
      </button>}
    </>
  )
}
