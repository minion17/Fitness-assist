import { useState } from 'react'
import { GOALS, YEAR, type ProfileData } from './profile'

const SEX = { male: 'Мужской', female: 'Женский' }
const ACTIVITY = {
  low: 'Минимальная — сидячая работа',
  light: 'Лёгкая — 1–2 тренировки в неделю',
  moderate: 'Средняя — 3–4 тренировки',
  high: 'Высокая — 5–6 тренировок',
  very_high: 'Очень высокая — спорт + физическая работа',
}

const LIMITS = {
  birth_year: [YEAR - 100, YEAR - 12],
  height_cm: [120, 230],
  weight_kg: [30, 300],
} as const

function Choice<T extends string>({ label, options, value, onChange, column }: {
  label: string; options: Record<T, string>; value: T | undefined; onChange: (v: T) => void; column?: boolean
}) {
  return (
    <fieldset className="field">
      <legend>{label}</legend>
      <div className={column ? 'seg seg-col' : 'seg'}>
        {(Object.keys(options) as T[]).map((k) => (
          <button type="button" key={k} aria-pressed={value === k} onClick={() => onChange(k)}>{options[k]}</button>
        ))}
      </div>
    </fieldset>
  )
}

type Draft = Partial<Record<keyof ProfileData, string>>

export default function Questionnaire({ initial, onSave, onCancel }: {
  initial: ProfileData | null
  onSave: (p: ProfileData) => Promise<void>
  onCancel?: () => void
}) {
  const [d, setD] = useState<Draft>(() =>
    initial ? Object.fromEntries(Object.entries(initial).filter(([k]) => k !== 'targets').map(([k, v]) => [k, String(v)])) : {},
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: keyof ProfileData) => (v: string) => setD((p) => ({ ...p, [k]: v }))

  function validate(): ProfileData | string {
    if (!d.sex || !d.goal || !d.activity) return 'Выберите пол, цель и уровень активности'
    for (const [k, [min, max]] of Object.entries(LIMITS)) {
      const n = Number(d[k as keyof Draft]?.replace(',', '.'))
      if (!Number.isFinite(n) || n < min || n > max) {
        return { birth_year: 'Год рождения', height_cm: 'Рост', weight_kg: 'Вес' }[k] + `: от ${min} до ${max}`
      }
    }
    return {
      sex: d.sex as ProfileData['sex'],
      goal: d.goal as ProfileData['goal'],
      activity: d.activity as ProfileData['activity'],
      birth_year: Math.round(Number(d.birth_year)),
      height_cm: Math.round(Number(d.height_cm)),
      weight_kg: Number(d.weight_kg!.replace(',', '.')),
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const p = validate()
    if (typeof p === 'string') return setError(p)
    setError('')
    setBusy(true)
    try {
      await onSave(p)
    } catch {
      setError('Не удалось сохранить. Проверьте соединение и попробуйте ещё раз.')
    } finally {
      setBusy(false)
    }
  }

  const num = (k: keyof typeof LIMITS, label: string, unit: string, decimal = false) => (
    <label className="field">
      <span>{label}</span>
      <div className="input-wrap">
        <input inputMode={decimal ? 'decimal' : 'numeric'} value={d[k] ?? ''} onChange={(e) => set(k)(e.target.value)}
          placeholder={`${LIMITS[k][0]}–${LIMITS[k][1]}`} />
        <i>{unit}</i>
      </div>
    </label>
  )

  return (
    <form className="screen" onSubmit={submit} noValidate>
      <div>
        <h1>{initial ? 'Анкета' : 'Давайте знакомиться'}</h1>
        <p className="sub">По этим данным рассчитаем вашу дневную норму калорий и БЖУ.</p>
      </div>
      <section className="card">
        <Choice label="Пол" options={SEX} value={d.sex as keyof typeof SEX} onChange={set('sex')} />
        {num('birth_year', 'Год рождения', 'г.')}
        <div className="grid2">
          {num('height_cm', 'Рост', 'см')}
          {num('weight_kg', 'Вес', 'кг', true)}
        </div>
      </section>
      <section className="card">
        <Choice label="Цель" options={GOALS} value={d.goal as keyof typeof GOALS} onChange={set('goal')} column />
      </section>
      <section className="card">
        <Choice label="Активность" options={ACTIVITY} value={d.activity as keyof typeof ACTIVITY} onChange={set('activity')} column />
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
      {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Отмена</button>}
    </form>
  )
}
