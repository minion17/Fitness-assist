import { useState } from 'react'
import type { Program } from './types'

const formatRest = (seconds: number) => seconds >= 60 ? `${Math.floor(seconds / 60)} мин${seconds % 60 ? ` ${seconds % 60} с` : ''}` : `${seconds} с`

export type ExerciseOption = { id: number; name: string }
export type ProgramDraft = { name: string; days: { id?: number; name: string; exercises: { exercise_id: number; sets: number; reps: string; rest_seconds: number; unit?: 'reps' | 'seconds'; superset?: number | null; planned_weights?: (number | null)[] | null }[] }[] }

export default function ProgramBuilder({ exercises, initial, onSave, onCancel, onCreateExercise }: {
  exercises: ExerciseOption[]; initial?: Program; onSave: (draft: ProgramDraft) => Promise<void>; onCancel: () => void; onCreateExercise?: (name: string) => Promise<ExerciseOption>
}) {
  const [draft, setDraft] = useState<ProgramDraft>(() => initial ? {
    name: initial.name, days: initial.days.map(d => ({ id: d.id, name: d.day_name, exercises: d.exercises.map(e => ({ exercise_id: e.exercise_id, sets: e.sets, reps: e.reps, rest_seconds: e.rest_seconds, unit: e.unit, superset: e.superset, planned_weights: e.planned_weights })) }))
  } : { name: '', days: [] })
  const [stage, setStage] = useState<'name' | 'days' | 'day' | 'preview'>(initial ? 'days' : 'name')
  const [editingItem, setEditingItem] = useState<number | null>(null)
  const [notice, setNotice] = useState(false)
  const [activeDay, setActiveDay] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [searches, setSearches] = useState<Record<string, string>>({})
  const closePicker = (key: string) => setSearches(current => { const next = { ...current }; delete next[key]; return next })
  const updateDay = (i: number, patch: Partial<ProgramDraft['days'][number]>) => setDraft(d => ({ ...d, days: d.days.map((day, n) => n === i ? { ...day, ...patch } : day) }))
  const updateExercise = (di: number, ei: number, patch: Partial<ProgramDraft['days'][number]['exercises'][number]>) => {
    const day = draft.days[di]
    updateDay(di, { exercises: day.exercises.map((e, n) => n === ei ? { ...e, ...patch } : e) })
  }
  async function save() {
    if (Object.keys(searches).length) {
      setError('Выберите упражнение из списка или добавьте своё.')
      return
    }
    if (!draft.name.trim() || !draft.days.length || draft.days.some(d => !d.name.trim() || !d.exercises.length || d.exercises.some(e => !e.reps.trim() || e.sets < 1 || e.sets > 50 || e.rest_seconds < 0 || e.rest_seconds > 3600 || (e.superset && d.exercises.filter(x => x.superset === e.superset).length < 2)))) {
      setError('Заполните название, добавьте упражнения и проверьте параметры.')
      return
    }
    setBusy(true); setError('')
    try { await onSave(draft) } catch { setError('Не удалось сохранить программу. Попробуйте ещё раз.') } finally { setBusy(false) }
  }
  return <div className={stage === 'name' ? 'program-builder program-builder-naming' : stage === 'days' && draft.days.length === 0 ? 'program-builder program-builder-empty' : stage === 'day' && editingItem === null && (draft.days[activeDay]?.exercises.length ?? 0) > 0 ? 'program-builder program-builder-day-ready' : 'program-builder'}>
    <div className="card-head"><h1>{stage === 'name' ? 'Новая программа' : stage === 'days' ? draft.name : 'Тренировка'}</h1><button className="link" onClick={() => stage === 'preview' ? setStage('day') : stage === 'day' ? (setEditingItem(null), setSearches({}), setStage('days')) : stage === 'days' ? setStage('name') : onCancel()}>{stage === 'name' ? 'Отмена' : 'Назад'}</button></div>
    {stage === 'name' && <div className="builder-name-content"><label className="builder-name">Название программы<input aria-label="Название программы" placeholder="Например, тренировки дома" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label><button className="btn" onClick={() => { if (draft.name.trim()) { setError(''); setStage('days') } else setError('Введите название программы') }}>Продолжить</button></div>}
    {stage === 'days' && <>{draft.days.map((d, i) => <button className="builder-day-entry" key={i} onClick={() => { setActiveDay(i); setStage('day') }}><span><strong>{d.name}</strong><small>{d.exercises.length} упр.</small></span><span className="builder-day-arrow" aria-hidden="true">→</span></button>)}<button className="btn btn-ghost builder-add-day" onClick={() => { setActiveDay(draft.days.length); setDraft(d => ({ ...d, days: [...d.days, { name: `Тренировка ${d.days.length + 1}`, exercises: [] }] })); setStage('day') }}>+ Добавить тренировку</button>{draft.days.some(d => d.exercises.length > 0) && <button className="btn" disabled={busy} onClick={save}>Сохранить программу</button>}</>}
    {stage === 'day' && draft.days.map((day, di) => di === activeDay && <section className={editingItem !== null ? "card builder-day builder-day-editing" : "card builder-day"} key={di}>
      {editingItem === null && <div className="builder-day-head"><label>Название<input aria-label={`Название тренировки ${di + 1}`} value={day.name} onChange={e => updateDay(di, { name: e.target.value })} /></label>
      {draft.days.length > 1 && <button className="link" onClick={() => { setSearches({}); setDraft(d => ({ ...d, days: d.days.filter((_, n) => n !== di) })) }}>Удалить</button>}</div>}
      {day.exercises.map((item, ei) => (editingItem === ei || (editingItem !== null && !!item.superset && item.superset === day.exercises[editingItem]?.superset)) && <div className="builder-exercise" key={ei}>
        <div className="builder-exercise-head">{item.superset && <span>Суперсет {item.superset} · Упражнение {ei + 1}</span>}<button className="link" onClick={() => { setSearches({}); setEditingItem(null); updateDay(di, { exercises: day.exercises.filter((_, n) => n !== ei) }) }}>Удалить</button></div>
        <div className="builder-picker">
          <label>Упражнение<input aria-label={`Упражнение ${ei + 1}`} placeholder="Выберите или введите название" value={searches[`${di}-${ei}`] ?? exercises.find(ex => ex.id === item.exercise_id)?.name ?? ''} onFocus={() => setSearches({ [`${di}-${ei}`]: '' })} onChange={e => setSearches({ [`${di}-${ei}`]: e.target.value })} onKeyDown={e => { if (e.key === 'Escape') closePicker(`${di}-${ei}`) }} /></label>
          {Object.hasOwn(searches, `${di}-${ei}`) && <div className="builder-options">
            {exercises.filter(ex => ex.name.toLowerCase().replaceAll('ё', 'е').includes(searches[`${di}-${ei}`].toLowerCase().replaceAll('ё', 'е'))).map(ex => <button key={ex.id} type="button" onClick={() => { updateExercise(di, ei, { exercise_id: ex.id }); closePicker(`${di}-${ei}`); setError('') }}>{ex.name}</button>)}
            {onCreateExercise && searches[`${di}-${ei}`].trim() && !exercises.some(ex => ex.name.toLowerCase() === searches[`${di}-${ei}`].trim().toLowerCase()) && <button type="button" className="builder-create" onClick={async () => { try { const ex = await onCreateExercise(searches[`${di}-${ei}`].trim()); updateExercise(di, ei, { exercise_id: ex.id }); closePicker(`${di}-${ei}`); setError('') } catch { setError('Не удалось добавить упражнение.') } }}>+ Добавить «{searches[`${di}-${ei}`].trim()}»</button>}
          </div>}
        </div>
        <div className="builder-params"><label>Подходы<input aria-label={`Подходы ${ei + 1}`} type="number" min="1" max="50" value={item.sets} onChange={e => updateExercise(di, ei, { sets: Number(e.target.value), ...(item.planned_weights ? { planned_weights: Array.from({ length: Math.max(0, Math.min(50, Number(e.target.value) || 0)) }, (_, i) => item.planned_weights?.[i] ?? null) } : {}) })} /></label>
        <label>Нагрузка<input aria-label={`${item.unit === 'seconds' ? 'Время' : 'Повторения'} ${ei + 1}`} value={item.reps} onChange={e => updateExercise(di, ei, { reps: e.target.value })} /></label>
        <label>Единица<select aria-label={`Тип нагрузки ${ei + 1}`} value={item.unit ?? 'reps'} onChange={e => updateExercise(di, ei, { unit: e.target.value as 'reps' | 'seconds' })}><option value="reps">Повт.</option><option value="seconds">Сек.</option></select></label>
        <label>Отдых, с<input aria-label={`Отдых ${ei + 1}`} type="number" min="0" max="3600" value={item.rest_seconds} onChange={e => updateExercise(di, ei, { rest_seconds: Number(e.target.value) })} />{item.rest_seconds >= 60 && <small className="rest-display">{formatRest(item.rest_seconds)}</small>}</label></div>
        <details className="planned-weights"><summary>{item.planned_weights?.some(w => w !== null) ? `Вес по подходам: ${item.planned_weights.map(w => w === null ? "—" : w).join(" / ")} кг` : "Указать вес по подходам"}</summary><div className="planned-weights-grid">{Array.from({ length: Math.max(0, Math.min(50, item.sets)) }, (_, si) => <label key={si}>Подход {si + 1}<input aria-label={`Упражнение ${ei + 1}, вес подхода ${si + 1}`} type="number" min="0" max="500" step="0.5" placeholder="—" value={item.planned_weights?.[si] ?? ''} onChange={e => { const weights = Array.from({ length: item.sets }, (_, n) => item.planned_weights?.[n] ?? null); weights[si] = e.target.value === '' ? null : Number(e.target.value); updateExercise(di, ei, { planned_weights: weights }) }} /></label>)}</div></details>
        {item.superset && day.exercises.findLastIndex(e => e.superset === item.superset) === ei && <button className="link" onClick={() => updateDay(di, { exercises: [...day.exercises.slice(0, ei + 1), { exercise_id: exercises[0].id, sets: 3, reps: '10', rest_seconds: 60, superset: item.superset }, ...day.exercises.slice(ei + 1)] })}>Добавить упражнение в суперсет</button>}
      </div>)}
      {editingItem !== null && <button className="btn" onClick={() => { if (Object.keys(searches).length) { setError('Выберите упражнение из списка или добавьте своё.'); return } const group = day.exercises.filter((e, i) => i === editingItem || (!!e.superset && e.superset === day.exercises[editingItem]?.superset)); if (group.some(e => !e.reps.trim() || e.sets < 1 || e.sets > 50 || e.rest_seconds < 0 || e.rest_seconds > 3600 || e.planned_weights?.some(w => w !== null && (!Number.isFinite(w) || w < 0 || w > 500)))) { setError('Проверьте параметры упражнения.'); return } setError(''); setEditingItem(null); setNotice(true); window.setTimeout(() => setNotice(false), 1600) }}>Добавить</button>}
      {notice && <div className="builder-added" role="status">✓ Добавлено</div>}
      {editingItem === null && <div className="builder-actions"><button className="link" disabled={!exercises.length} onClick={() => { setEditingItem(day.exercises.length); updateDay(di, { exercises: [...day.exercises, { exercise_id: exercises[0].id, sets: 3, reps: '10', rest_seconds: 60 }] }) }}><span aria-hidden="true">+ </span>Добавить упражнение</button>
      <button className="link" disabled={!exercises.length} onClick={() => { const group = Math.max(0, ...day.exercises.map(e => e.superset ?? 0)) + 1; setEditingItem(day.exercises.length); updateDay(di, { exercises: [...day.exercises, ...[1, 2].map(() => ({ exercise_id: exercises[0].id, sets: 3, reps: '10', rest_seconds: 60, superset: group }))] }) }}><span aria-hidden="true">+ </span>Добавить суперсет</button></div>}
    </section>)}
    {stage === 'day' && editingItem === null && (draft.days[activeDay]?.exercises.length ?? 0) > 0 && <button className="btn" onClick={() => { if (Object.keys(searches).length) { setError('Выберите упражнение из списка или добавьте своё.'); return } if (!draft.days[activeDay]?.exercises.length) { setError('Добавьте хотя бы одно упражнение.'); return } setError(''); setStage('preview') }}>Готово</button>}
    {stage === 'preview' && draft.days[activeDay] && <><section className="card"><h2>{draft.days[activeDay].name}</h2>{draft.days[activeDay].exercises.map((e, i) => <div className="row" key={i}><div className="row-main"><div className="row-title">{e.superset ? `Суперсет ${e.superset} · ` : ''}{exercises.find(x => x.id === e.exercise_id)?.name ?? 'Упражнение'}</div><div className="row-sub">{e.sets} × {e.reps}{e.unit === 'seconds' ? ' сек' : ' повт.'} · отдых {formatRest(e.rest_seconds)}{e.planned_weights?.some(w => w !== null) ? ` · вес: ${e.planned_weights.map(w => w === null ? '—' : w).join(' / ')} кг` : ''}</div></div><button className="link" onClick={() => { setEditingItem(i); setStage('day') }}>Изменить</button></div>)}</section><button className="btn btn-ghost" onClick={() => setStage('day')}>Редактировать</button><button className="btn" onClick={() => setStage('days')}>Сохранить</button></>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>
}
