// Step-by-step registration questionnaire. Questions follow the colleague's Logos engine (questionnaire.ts);
// all calculations stay on the server.
import { useState } from 'react'
import { YEAR, type ProfileData } from './profile'

type Opt = Record<string, string>
const SEX: Opt = { male: 'Мужской', female: 'Женский' }
const GOALS: Opt = {
  weight_loss: 'Снижение веса',
  fat_loss: 'Снижение процента жира',
  maintenance: 'Поддержание формы',
  muscle_gain: 'Набор мышечной массы',
  mass_gain: 'Набор общей массы',
}
const EXPERIENCE: Opt = {
  beginner: 'Новичок — меньше 6 месяцев',
  intermediate: 'Средний — от 6 месяцев до 2 лет',
  advanced: 'Продвинутый — больше 2 лет',
}
const ACTIVITY: Opt = {
  low: 'Сидячий образ жизни',
  light: 'Лёгкая — 1–2 дня в неделю',
  moderate: 'Умеренная — 3–5 дней в неделю',
  high: 'Высокая — 6–7 дней в неделю',
  very_high: 'Очень высокая — физический труд + спорт',
}
const EQUIPMENT: Opt = {
  bodyweight: 'Собственный вес', dumbbells: 'Гантели', barbell: 'Штанга', bench: 'Скамья', pullup_bar: 'Турник / брусья',
  cable_machine: 'Блочный тренажёр', machine: 'Силовые тренажёры', treadmill: 'Беговая дорожка', exercise_bike: 'Велотренажёр',
}
const DAYS: Opt = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [String(n), String(n)]))
const MINUTES: Opt = { '20': '20 мин', '30': '30 мин', '45': '45 мин', '60': '60 мин', '90': '90 мин' }
const ALLERGIES: Opt = { dairy: 'Молочное', eggs: 'Яйца', gluten: 'Глютен', nuts: 'Орехи', fish: 'Рыба' }
const MEALS: Opt = { '3': '3 раза', '4': '4 раза', '5': '5 раз' }
const STRESS: Opt = { low: 'Низкий', moderate: 'Умеренный', high: 'Высокий' }
const YES_NO: Opt = { no: 'Нет', yes: 'Да' }
const INJURY: Opt = { knees: 'Колени', back: 'Спина', shoulders: 'Плечи', other: 'Другое' }

const NUM = {
  birth_year: { label: 'Год рождения', unit: 'г.', min: YEAR - 100, max: YEAR - 12 },
  height_cm: { label: 'Рост', unit: 'см', min: 120, max: 230 },
  weight_kg: { label: 'Вес', unit: 'кг', min: 30, max: 300 },
  sleep_hours: { label: 'Сколько часов вы спите в среднем?', unit: 'ч', min: 3, max: 12 },
} as const
type NumKey = keyof typeof NUM

type Draft = {
  sex?: string; goal?: string; experience?: string; activity?: string
  birth_year?: string; height_cm?: string; weight_kg?: string; sleep_hours?: string
  equipment: string[]; allergies: string[]
  sessions_per_week?: string; session_minutes?: string; meals_per_day?: string
  stress?: string; has_injury?: string; injury?: string
}

function toDraft(p: ProfileData | null): Draft {
  if (!p) return { equipment: [], allergies: [] }
  const s = (v: unknown) => (v === null || v === undefined ? undefined : String(v))
  return {
    sex: p.sex, goal: p.goal, experience: s(p.experience), activity: p.activity,
    birth_year: s(p.birth_year), height_cm: s(p.height_cm), weight_kg: s(p.weight_kg), sleep_hours: s(p.sleep_hours),
    equipment: p.equipment ?? [], allergies: p.allergies ?? [],
    sessions_per_week: s(p.sessions_per_week), session_minutes: s(p.session_minutes), meals_per_day: s(p.meals_per_day),
    stress: s(p.stress), injury: s(p.injury),
    // only known if the extended part was answered before
    has_injury: p.experience ? (p.injury ? 'yes' : 'no') : undefined,
  }
}

const num = (v?: string) => Number((v ?? '').replace(',', '.'))

function checkNum(d: Draft, k: NumKey): string | null {
  const { label, min, max } = NUM[k]
  const n = num(d[k])
  return !d[k] || !Number.isFinite(n) || n < min || n > max ? `${label.replace(/\?$/, '')}: от ${min} до ${max}` : null
}

const STEPS: { title: string; hint: string; check: (d: Draft) => string | null }[] = [
  {
    title: 'О себе', hint: 'Нужно для расчёта нормы калорий.',
    check: (d) => (!d.sex ? 'Выберите пол' : checkNum(d, 'birth_year') ?? checkNum(d, 'height_cm') ?? checkNum(d, 'weight_kg')),
  },
  { title: 'Цель', hint: 'От цели зависит калорийность и белок.', check: (d) => (!d.goal ? 'Выберите цель' : null) },
  {
    title: 'Опыт и активность', hint: 'Подберём нагрузку под ваш уровень.',
    check: (d) => (!d.experience ? 'Выберите уровень подготовки' : !d.activity ? 'Выберите уровень активности' : null),
  },
  {
    title: 'Тренировки', hint: 'По этим ответам подберём программу.',
    check: (d) => (!d.equipment.length ? 'Отметьте доступное оборудование'
      : !d.sessions_per_week ? 'Выберите количество дней' : !d.session_minutes ? 'Выберите длительность' : null),
  },
  { title: 'Питание', hint: 'Аллергии можно не отмечать, если их нет.', check: (d) => (!d.meals_per_day ? 'Выберите число приёмов пищи' : null) },
  {
    title: 'Восстановление', hint: 'Сон и стресс влияют на результат не меньше тренировок.',
    check: (d) => checkNum(d, 'sleep_hours') ?? (!d.stress ? 'Выберите уровень стресса'
      : !d.has_injury ? 'Укажите, есть ли травмы' : d.has_injury === 'yes' && !d.injury ? 'Выберите зону ограничения' : null),
  },
]

function Choice({ label, options, value, onChange, column, multi, compact }: {
  label: string; options: Opt; value: string | string[] | undefined; onChange: (v: string) => void
  column?: boolean; multi?: boolean; compact?: boolean
}) {
  const on = (k: string) => (multi ? (value as string[]).includes(k) : value === k)
  return (
    <fieldset className="field">
      <legend>{label}</legend>
      <div className={column ? 'seg seg-col' : compact ? 'seg seg-row' : 'seg'} role={multi ? 'group' : 'radiogroup'}>
        {Object.entries(options).map(([k, text]) => (
          <button type="button" key={k} aria-pressed={on(k)} onClick={() => onChange(k)}>{text}</button>
        ))}
      </div>
    </fieldset>
  )
}

export default function Questionnaire({ initial, onSave, onCancel }: {
  initial: ProfileData | null
  onSave: (p: ProfileData) => Promise<void>
  onCancel?: () => void
}) {
  const [d, setD] = useState<Draft>(() => toDraft(initial))
  const [step, setStep] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: keyof Draft) => (v: string) => { setError(''); setD((p) => ({ ...p, [k]: v })) }
  const toggle = (k: 'equipment' | 'allergies') => (v: string) => {
    setError('')
    setD((p) => ({ ...p, [k]: p[k].includes(v) ? p[k].filter((x) => x !== v) : [...p[k], v] }))
  }
  const last = step === STEPS.length - 1

  function build(): ProfileData {
    return {
      sex: d.sex as ProfileData['sex'], goal: d.goal as ProfileData['goal'], activity: d.activity as ProfileData['activity'],
      birth_year: Math.round(num(d.birth_year)), height_cm: Math.round(num(d.height_cm)), weight_kg: num(d.weight_kg),
      experience: d.experience as ProfileData['experience'], equipment: d.equipment,
      sessions_per_week: Number(d.sessions_per_week), session_minutes: Number(d.session_minutes),
      allergies: d.allergies, meals_per_day: Number(d.meals_per_day), sleep_hours: num(d.sleep_hours),
      stress: d.stress as ProfileData['stress'], injury: d.has_injury === 'yes' ? (d.injury as ProfileData['injury']) : null,
    }
  }

  async function next(e: React.FormEvent) {
    e.preventDefault()
    const problem = STEPS[step].check(d)
    if (problem) return setError(problem)
    setError('')
    if (!last) { setStep(step + 1); window.scrollTo(0, 0); return }
    setBusy(true)
    try {
      await onSave(build())
    } catch {
      setError('Не удалось сохранить. Проверьте соединение и попробуйте ещё раз.')
    } finally {
      setBusy(false)
    }
  }

  const numField = (k: NumKey, decimal = false) => (
    <label className="field">
      <span>{NUM[k].label}</span>
      <div className="input-wrap">
        <input inputMode={decimal ? 'decimal' : 'numeric'} value={d[k] ?? ''} onChange={(e) => set(k)(e.target.value)}
          placeholder={`${NUM[k].min}–${NUM[k].max}`} />
        <i>{NUM[k].unit}</i>
      </div>
    </label>
  )

  return (
    <form className="screen" onSubmit={next} noValidate>
      <div className="steps" aria-label={`Шаг ${step + 1} из ${STEPS.length}`}>
        {STEPS.map((_, i) => <i key={i} className={i <= step ? 'on' : ''} />)}
      </div>
      <div>
        <p className="hello">Шаг {step + 1} из {STEPS.length}</p>
        <h1>{step === 0 && !initial ? 'Давайте знакомиться' : STEPS[step].title}</h1>
        <p className="sub">{STEPS[step].hint}</p>
      </div>

      <section className="card" key={step}>
        {step === 0 && (
          <>
            <Choice label="Пол" options={SEX} value={d.sex} onChange={set('sex')} />
            {numField('birth_year')}
            <div className="grid2">{numField('height_cm')}{numField('weight_kg', true)}</div>
          </>
        )}
        {step === 1 && <Choice label="Основная цель" options={GOALS} value={d.goal} onChange={set('goal')} column />}
        {step === 2 && (
          <>
            <Choice label="Уровень подготовки" options={EXPERIENCE} value={d.experience} onChange={set('experience')} column />
            <Choice label="Повседневная активность" options={ACTIVITY} value={d.activity} onChange={set('activity')} column />
          </>
        )}
        {step === 3 && (
          <>
            <Choice label="Доступное оборудование" options={EQUIPMENT} value={d.equipment} onChange={toggle('equipment')} multi />
            <Choice label="Дней в неделю" options={DAYS} compact value={d.sessions_per_week} onChange={set('sessions_per_week')} />
            <Choice label="Длительность тренировки" options={MINUTES} compact value={d.session_minutes} onChange={set('session_minutes')} />
          </>
        )}
        {step === 4 && (
          <>
            <Choice label="Аллергии и непереносимость" options={ALLERGIES} value={d.allergies} onChange={toggle('allergies')} multi />
            <Choice label="Приёмов пищи в день" options={MEALS} compact value={d.meals_per_day} onChange={set('meals_per_day')} />
          </>
        )}
        {step === 5 && (
          <>
            {numField('sleep_hours', true)}
            <Choice label="Уровень стресса" options={STRESS} compact value={d.stress} onChange={set('stress')} />
            <Choice label="Есть ли травмы или ограничения?" options={YES_NO} value={d.has_injury} onChange={set('has_injury')} />
            {d.has_injury === 'yes' && <Choice label="Какая зона?" options={INJURY} value={d.injury} onChange={set('injury')} />}
          </>
        )}
      </section>

      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" disabled={busy}>{busy ? 'Сохраняем…' : last ? 'Готово' : 'Далее'}</button>
      {step > 0
        ? <button type="button" className="btn btn-ghost" onClick={() => { setStep(step - 1); setError('') }}>Назад</button>
        : onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Отмена</button>}
    </form>
  )
}
