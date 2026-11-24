// Exercise library: ~880 exercises with photos, technique and the muscles they work. Browse by muscle (tap the body map),
// equipment and kind; or "Собрать тренировку": pick muscles, get 4–6 fitting exercises, swap any, save as a program.
import { plural } from './plural'
import { useEffect, useMemo, useState } from 'react'
import { getExerciseGuideImage } from './KettlebellExercise'
import MuscleMap from './MuscleMap'
import { MUSCLES, MUSCLE_GROUPS, type Muscle } from './muscles'
import type { ProfileData } from './profile'
import type { ProgramDraft } from './ProgramBuilder'
import { api, publicGet } from './telegram'
import { Sheet } from './ui'

export type LibExercise = {
  id: number; name: string; equipment: string[]; difficulty: string; description: string | null; is_bodyweight: boolean
  primary: string[]; secondary: string[]; images: string[]; category: string | null; mechanic: string | null; mine?: boolean
}

const LEVELS: Record<string, string> = { beginner: 'Новичок', intermediate: 'Средний', advanced: 'Продвинутый', expert: 'Продвинутый' }
const KINDS: Record<string, string> = { strength: 'Силовые', stretching: 'Растяжка', cardio: 'Кардио', plyometrics: 'Прыжки' }
const KIND_OF = (e: LibExercise) => (e.category === 'plyometrics' || e.category === 'cardio' || e.category === 'stretching' ? e.category : 'strength')
// "what I have" filter -> the equipment labels it covers (ours and the library's)
const GEAR: Record<string, string[]> = {
  none: [], dumbbells: ['Гантели', 'Гантель'], barbell: ['Штанга', 'EZ-гриф', 'Стойки'], bench: ['Скамья', 'Платформа'],
  kettlebell: ['Гиря', 'Гири'], bar: ['Турник', 'Брусья', 'Низкая перекладина'], band: ['Эспандер', 'Резина'],
  machine: ['Тренажёр', 'Блок', 'Римский стул'], ball: ['Фитбол', 'Медбол'], other: ['Петли TRX', 'Тумба', 'Скакалка', 'Ролик'],
}
const GEAR_NAMES: Record<string, string> = {
  none: 'Без инвентаря', dumbbells: 'Гантели', barbell: 'Штанга', bench: 'Скамья', kettlebell: 'Гиря', bar: 'Турник / брусья',
  band: 'Резина', machine: 'Тренажёры', ball: 'Мяч', other: 'TRX, тумба, ролик',
}
const FREE = ['Собственный вес', 'Коврик', 'Оборудование не указано']
/** Doable with the chosen equipment: everything it needs is among it ("Без инвентаря" covers exercises needing nothing). */
const doable = (e: LibExercise, gear: string[]) => {
  const need = e.equipment.filter((x) => !FREE.includes(x))
  return need.length ? need.every((x) => gear.some((g) => GEAR[g].includes(x))) : gear.includes('none')
}
// the questionnaire's equipment codes -> labels the user has
const HAVE: Record<string, string[]> = {
  bodyweight: ['Собственный вес', 'Коврик'], dumbbells: ['Гантели', 'Гантель'], barbell: ['Штанга', 'EZ-гриф', 'Стойки'], bench: ['Скамья'],
  pullup_bar: ['Турник', 'Брусья'], cable_machine: ['Блок', 'Тренажёр'], machine: ['Тренажёр', 'Римский стул'],
}
const PAGE = 40

const photo = (e: LibExercise, n = 0): string | null =>
  e.images[n] ? `/api/exercise-image/${encodeURIComponent(e.images[n].split('/')[0])}/${n}.webp` : n === 0 ? getExerciseGuideImage(e.name) : null

const norm = (s: string) => s.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')
const usesNoGear = (e: LibExercise) => e.is_bodyweight || e.equipment.every((x) => ['Собственный вес', 'Коврик', 'Оборудование не указано'].includes(x))

const RANK: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2, expert: 2 }
const exotic = (e: LibExercise) => e.equipment.includes('Другое оборудование')
/** The common exercises first: easier, ordinary equipment (not chains or a log), base before isolation, with a photo. */
function byUsefulness(a: LibExercise, b: LibExercise) {
  return (RANK[a.difficulty] ?? 1) - (RANK[b.difficulty] ?? 1) || Number(exotic(a)) - Number(exotic(b))
    || Number(b.mechanic === 'compound') - Number(a.mechanic === 'compound')
    || Number(Boolean(b.images.length || getExerciseGuideImage(b.name))) - Number(Boolean(a.images.length || getExerciseGuideImage(a.name)))
    || a.name.length - b.name.length
}

let cache: LibExercise[] | null = null
/** All exercises: from the server (with the user's own), or the bundled files outside Telegram. */
async function loadLibrary(canEdit: boolean): Promise<LibExercise[]> {
  if (cache) return cache
  const list = canEdit ? await api<LibExercise[]>('/api/exercises') : await publicGet<LibExercise[]>('/api/exercises').catch(() => null)
  if (list?.length) return (cache = list)
  const [ours, lib] = await Promise.all([import('../../content/exercises/exercises.json'), import('../../content/exercises/translated_exercises.json')])
  type Raw = { name: string; equipment?: string[]; difficulty?: string; description?: string | null; is_bodyweight?: boolean
    primary_muscles?: string[]; secondary_muscles?: string[]; images?: string[]; category?: string | null; mechanic?: string | null }
  return (cache = [...(ours.default as Raw[]), ...(lib.default as Raw[])].map((e, i) => ({
    id: -100000 - i, name: e.name, equipment: e.equipment ?? [], difficulty: e.difficulty ?? 'beginner', description: e.description ?? null,
    is_bodyweight: Boolean(e.is_bodyweight), primary: e.primary_muscles ?? [], secondary: e.secondary_muscles ?? [], images: e.images ?? [],
    category: e.category ?? null, mechanic: e.mechanic ?? null,
  })))
}

/** Start and end photo in turn: the movement at a glance. */
function Motion({ e }: { e: LibExercise }) {
  const [frame, setFrame] = useState(0)
  const two = Boolean(photo(e, 1))
  useEffect(() => {
    if (!two) return
    const t = setInterval(() => setFrame((f) => 1 - f), 900)
    return () => clearInterval(t)
  }, [two])
  const first = photo(e, 0)
  if (!first) return null
  return (
    <div className="lib-motion">
      <img src={first} alt={e.name} />
      {two && <img src={photo(e, 1)!} alt="" aria-hidden="true" className={frame ? 'on' : ''} />}
    </div>
  )
}

export function ExerciseCard({ e, onClose, onAdd, onMuscle }: { e: LibExercise; onClose: () => void; onAdd?: () => void; onMuscle?: (m: Muscle) => void }) {
  const steps = (e.description ?? '').split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z])/).filter((s) => s.trim().length > 2)
  return (
    <Sheet title={e.name} onClose={onClose}>
      <Motion e={e} />
      <div className="lib-tags">
        {e.primary.map((m) => <button key={m} className="chip chip-accent" onClick={() => onMuscle?.(m as Muscle)}>{MUSCLES[m as Muscle] ?? m}</button>)}
        {e.secondary.map((m) => <button key={m} className="chip" onClick={() => onMuscle?.(m as Muscle)}>{MUSCLES[m as Muscle] ?? m}</button>)}
      </div>
      <MuscleMap primary={e.primary} secondary={e.secondary} compact />
      <p className="sub">{[LEVELS[e.difficulty], usesNoGear(e) ? 'без инвентаря' : e.equipment.filter((x) => x !== 'Оборудование не указано').join(', '),
        e.mechanic === 'compound' ? 'базовое' : e.mechanic === 'isolation' ? 'изолирующее' : ''].filter(Boolean).join(' · ')}</p>
      {steps.length > 0 && (
        <>
          <h3 className="lib-h">Техника</h3>
          <ol className="lib-steps">{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </>
      )}
      {onAdd && <button className="btn" onClick={() => { onAdd(); onClose() }}>Добавить в тренировку</button>}
    </Sheet>
  )
}

function Row({ e, onOpen, end }: { e: LibExercise; onOpen: () => void; end?: React.ReactNode }) {
  const img = photo(e)
  return (
    <div className="lib-row">
      <button className="lib-row-main" onClick={onOpen}>
        {img ? <img src={img} alt="" loading="lazy" /> : <span className="lib-noimg" aria-hidden="true">🏋️</span>}
        <span className="step-text"><b>{e.name}</b><span className="sub">{e.primary.map((m) => MUSCLES[m as Muscle] ?? m).join(', ') || '—'}</span></span>
      </button>
      {end}
    </div>
  )
}

/** The library screen (browse), or the workout picker (build). */
export default function Library({ canEdit, profile, mode, onClose, onSaveWorkout }: {
  canEdit: boolean
  profile: ProfileData | null
  mode: 'browse' | 'build'
  onClose: () => void
  onSaveWorkout: (draft: ProgramDraft, names?: Map<number, string>) => Promise<void>
}) {
  const [all, setAll] = useState<LibExercise[] | null>(cache)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [muscles, setMuscles] = useState<Muscle[]>([])
  const [gear, setGear] = useState<string[]>([])
  const [kind, setKind] = useState<string>('strength')
  const [shown, setShown] = useState(PAGE)
  const [open, setOpen] = useState<LibExercise | null>(null)
  const [plan, setPlan] = useState<LibExercise[] | null>(null)
  useEffect(() => {
    if (all) return
    loadLibrary(canEdit).then(setAll).catch(() => setError('Нет связи. Упражнения загрузим, как только вернётся интернет'))
  }, [all, canEdit])

  const toggleMuscle = (m: Muscle) => { setMuscles((ms) => (ms.includes(m) ? ms.filter((x) => x !== m) : [...ms, m])); setShown(PAGE) }

  const list = useMemo(() => {
    if (!all) return []
    const words = norm(q).split(/\s+/).filter(Boolean)
    return all.filter((e) => (!words.length || words.every((w) => norm(e.name).includes(w)))
      && (!muscles.length || muscles.some((m) => e.primary.includes(m) || e.secondary.includes(m)))
      && (!gear.length || doable(e, gear))
      && (q || KIND_OF(e) === kind))
      // the chosen muscle as the main one first, then where it helps
      .sort((a, b) => Number(muscles.some((m) => b.primary.includes(m))) - Number(muscles.some((m) => a.primary.includes(m))) || byUsefulness(a, b))
  }, [all, q, muscles, gear, kind])

  if (plan) return <WorkoutPlan plan={plan} all={all ?? []} profile={profile} muscles={muscles} onBack={() => setPlan(null)} onSave={onSaveWorkout} />

  const build = mode === 'build'
  return (
    <div className="library">
      <div className="card-head"><h1>{build ? 'Собрать тренировку' : 'Упражнения'}</h1><button className="link" onClick={onClose}>Назад</button></div>
      {build && <p className="sub">Нажми на мышцы на схеме, и подберём упражнения под твоё оборудование и уровень.</p>}
      <MuscleMap primary={muscles} onPick={toggleMuscle} />
      <div className="lib-chips" role="group" aria-label="Мышцы">
        {MUSCLE_GROUPS.flatMap((g) => g.muscles).map((m) => (
          <button key={m} className="habit-chip" aria-pressed={muscles.includes(m)} onClick={() => toggleMuscle(m)}>{MUSCLES[m]}</button>
        ))}
      </div>
      {build ? (
        <button className="btn" disabled={!muscles.length || !all} onClick={() => setPlan(pickWorkout(all ?? [], muscles, profile))}>
          {muscles.length ? `Подобрать упражнения · ${muscles.map((m) => MUSCLES[m]).join(', ')}` : 'Выбери мышцы'}
        </button>
      ) : (
        <>
          <div className="input-wrap lib-search"><input placeholder="Поиск: жим, выпады, планка…" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE) }} aria-label="Поиск упражнений" /></div>
          <div className="lib-chips" role="group" aria-label="Вид">
            {Object.entries(KINDS).map(([k, t]) => <button key={k} className="habit-chip" aria-pressed={!q && kind === k} onClick={() => { setKind(k); setShown(PAGE) }}>{t}</button>)}
          </div>
          <span className="lib-label">Что есть под рукой</span>
          <div className="lib-chips" role="group" aria-label="Оборудование">
            {Object.entries(GEAR_NAMES).map(([k, t]) => <button key={k} className="habit-chip" aria-pressed={gear.includes(k)}
              onClick={() => { setGear(gear.includes(k) ? gear.filter((g) => g !== k) : [...gear, k]); setShown(PAGE) }}>{t}</button>)}
            {gear.length > 0 && <button className="link" onClick={() => setGear([])}>Сбросить</button>}
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          {!all && !error && <p className="sub">Загружаем упражнения…</p>}
          {all && <p className="sub">{list.length ? `Нашлось: ${list.length}` : 'Ничего не нашлось. Убери часть фильтров'}</p>}
          <div className="lib-list">{list.slice(0, shown).map((e) => <Row key={e.id} e={e} onOpen={() => setOpen(e)} />)}</div>
          {list.length > shown && <button className="btn btn-ghost" onClick={() => setShown(shown + PAGE)}>Показать ещё</button>}
        </>
      )}
      {open && <ExerciseCard e={open} onClose={() => setOpen(null)} onMuscle={(m) => { setOpen(null); setMuscles([m]); setQ('') }} />}
    </div>
  )
}

/** Exercises that fit: strength, the user's equipment and level, a known main muscle. */
function candidates(all: LibExercise[], muscle: Muscle, profile: ProfileData | null): LibExercise[] {
  const have = new Set((profile?.equipment ?? ['bodyweight']).flatMap((c) => HAVE[c] ?? []))
  const level = profile?.experience ?? 'beginner'
  const allowed = level === 'beginner' ? ['beginner'] : level === 'intermediate' ? ['beginner', 'intermediate'] : ['beginner', 'intermediate', 'expert', 'advanced']
  return all.filter((e) => KIND_OF(e) === 'strength' && e.primary.includes(muscle) && allowed.includes(e.difficulty)
    && (usesNoGear(e) || e.equipment.every((x) => have.has(x) || x === 'Скамья' && have.has('Штанга'))))
    .sort((a, b) => Number(Boolean(b.images.length || getExerciseGuideImage(b.name))) - Number(Boolean(a.images.length || getExerciseGuideImage(a.name)))
      || Number(b.mechanic === 'compound') - Number(a.mechanic === 'compound') || Number(Boolean(b.mine)) - Number(Boolean(a.mine)))
}

/** 4–6 exercises over the chosen muscles: a base (compound) one first for each, then isolation. */
function pickWorkout(all: LibExercise[], muscles: Muscle[], profile: ProfileData | null): LibExercise[] {
  const total = Math.min(6, Math.max(4, muscles.length * 2))
  const per = muscles.map((m) => candidates(all, m, profile))
  const out: LibExercise[] = []
  for (let round = 0; out.length < total && round < 6; round++) {
    for (const list of per) {
      const next = list.find((e) => !out.includes(e))
      if (next && out.length < total) out.push(next)
    }
  }
  return out
}

function WorkoutPlan({ plan: initial, all, profile, muscles, onBack, onSave }: {
  plan: LibExercise[]; all: LibExercise[]; profile: ProfileData | null; muscles: Muscle[]; onBack: () => void; onSave: (d: ProgramDraft, names?: Map<number, string>) => Promise<void>
}) {
  const [plan, setPlan] = useState(initial)
  const [open, setOpen] = useState<LibExercise | null>(null)
  const [name, setName] = useState(`Тренировка: ${muscles.map((m) => MUSCLES[m]).join(' + ')}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const strength = profile?.goal === 'muscle_gain' || profile?.goal === 'mass_gain'
  const reps = strength ? '8-12' : '10-15', rest = strength ? 90 : 60

  /** Another exercise on the same main muscle, not already in the plan. */
  function swap(i: number) {
    const e = plan[i]
    const muscle = (muscles.find((m) => e.primary.includes(m)) ?? e.primary[0]) as Muscle
    const list = candidates(all, muscle, profile).filter((x) => !plan.includes(x))
    if (!list.length) return setError('Других подходящих упражнений нет. Можно убрать это')
    const pos = list.findIndex((x) => x.id > e.id)
    setPlan(plan.map((x, j) => (j === i ? list[pos < 0 ? 0 : pos] : x)))
    setError('')
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      await onSave({ name: name.trim() || 'Моя тренировка', days: [{ name: name.trim() || 'Моя тренировка', exercises: plan.map((e) => ({ exercise_id: e.id, sets: 3, reps, rest_seconds: rest, unit: 'reps' as const })) }] }, new Map(plan.map((e) => [e.id, e.name])))
    } catch {
      setError('Не сохранилось: нет связи. Попробуй ещё раз')
      setBusy(false)
    }
  }

  return (
    <div className="library">
      <div className="card-head"><h1>Твоя тренировка</h1><button className="link" onClick={onBack}>Назад</button></div>
      <MuscleMap primary={muscles} secondary={[...new Set(plan.flatMap((e) => [...e.primary, ...e.secondary]))].filter((m) => !muscles.includes(m as Muscle))} compact />
      <p className="sub">{plan.length ? `${plan.length} ${plural(plan.length, 'упражнение', 'упражнения', 'упражнений')} · 3 подхода по ${reps} · отдых ${rest} с. Любое можно заменить или убрать.` : 'Под твоё оборудование упражнений нет. Отметь его в анкете или выбери другие мышцы.'}</p>
      <div className="lib-list">
        {plan.map((e, i) => (
          <Row key={e.id} e={e} onOpen={() => setOpen(e)} end={
            <span className="lib-row-actions">
              <button className="icon-btn" aria-label={`Заменить: ${e.name}`} onClick={() => swap(i)}>⇄</button>
              <button className="icon-btn" aria-label={`Убрать: ${e.name}`} onClick={() => setPlan(plan.filter((_, j) => j !== i))}>✕</button>
            </span>} />
        ))}
      </div>
      <label className="field"><span>Название</span><div className="input-wrap"><input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></div></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" disabled={busy || !plan.length} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить и выбрать'}</button>
      {open && <ExerciseCard e={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
