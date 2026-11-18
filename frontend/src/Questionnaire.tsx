// Registration questionnaire: one question per screen with explicit navigation. Besides the numbers for the norms it
// asks what the program needs: body now and the goal shape, a quick self-test (squats, push-ups, pull-ups), where and how
// often one trains. Ends with an honest plan summary. All calculations stay on the server.
import { useEffect, useState } from 'react'
import BodyFigure from './BodyFigure'
import MealRange from './MealRange'
import { NOW_LEVELS, TARGET_LEVELS, bodyAvatarSource, targetAvatar } from './bodyShape'
import { YEAR, type ProfileData } from './profile'

type Opt = Record<string, string>
const SEX: Opt = { male: '👨 Мужской', female: '👩 Женский' }
const GOALS: Opt = {
  weight_loss: '⚖️ Снизить вес',
  fat_loss: '🔥 Убрать жир, сохранить мышцы',
  maintenance: '🧘 Поддерживать форму',
  muscle_gain: '💪 Набрать мышцы',
  mass_gain: '🏋️ Набрать общую массу',
}
const EXPERIENCE: Opt = {
  beginner: 'Новичок — меньше 6 месяцев',
  intermediate: 'Средний — от 6 месяцев до 2 лет',
  advanced: 'Продвинутый — больше 2 лет',
}
const ACTIVITY: Opt = {
  low: '🪑 Сидячий образ жизни',
  light: '🚶 Лёгкая — 1–2 дня в неделю',
  moderate: '🏃 Умеренная — 3–5 дней в неделю',
  high: '⚡ Высокая — 6–7 дней в неделю',
  very_high: '🔨 Очень высокая — физический труд + спорт',
}
const PLACE: Opt = { home: '🏠 Дома', gym: '🏋️ В зале', outdoor: '🌳 На улице' }
const EQUIPMENT: Opt = {
  bodyweight: 'Собственный вес', dumbbells: 'Гантели', barbell: 'Штанга', bench: 'Скамья', pullup_bar: 'Турник / брусья',
  cable_machine: 'Блочный тренажёр', machine: 'Силовые тренажёры', treadmill: 'Беговая дорожка', exercise_bike: 'Велотренажёр',
}
// what the place usually has; one can change it on the next screen
const PLACE_EQUIPMENT: Record<string, string[]> = {
  home: ['bodyweight'],
  gym: ['bodyweight', 'dumbbells', 'barbell', 'bench', 'pullup_bar', 'cable_machine', 'machine', 'treadmill', 'exercise_bike'],
  outdoor: ['bodyweight', 'pullup_bar'],
}
const SQUATS: Opt = { lt15: 'Меньше 15', '15_30': '15–30', gt30: 'Больше 30', unknown: 'Не знаю' }
const PUSHUPS: Opt = { lt10: 'Меньше 10', '10_20': '10–20', gt20: 'Больше 20', unknown: 'Не знаю' }
const PULLUPS: Opt = { none: 'Ни одного', '1_5': '1–5', '6_10': '6–10', gt10: 'Больше 10', unknown: 'Не знаю' }
const FOCUS: Opt = { arms: 'Руки', chest: 'Грудь', belly: 'Живот', glutes: 'Ягодицы', legs: 'Ноги', back: 'Спина' }
const DAYS: Opt = {
  '1': '1 день в неделю', '2': '2 дня в неделю', '3': '3 дня в неделю', '4': '4 дня в неделю',
  '5': '5 дней в неделю', '6': '6 дней в неделю', '7': '7 дней в неделю',
}
const MINUTES: Opt = { '20': '20 мин', '30': '30 мин', '45': '45 мин', '60': '60 мин', '90': '90 мин' }
const ALLERGIES: Opt = { dairy: 'Молочное', eggs: 'Яйца', gluten: 'Глютен', nuts: 'Орехи', fish: 'Рыба' }
const MEALS: Opt = { '3': '3 раза', '4': '4 раза', '5': '5 раз' }
const STRESS: Opt = { low: 'Низкий', moderate: 'Умеренный', high: 'Высокий' }
const YES_NO: Opt = { no: 'Нет', yes: 'Да' }
const INJURY: Opt = { knees: 'Колени', back: 'Спина', shoulders: 'Плечи', other: 'Другое' }
const IMG = '/images/workout-guide/'

const NUM = {
  birth_year: { label: 'Год рождения', unit: 'г.', min: YEAR - 100, max: YEAR - 12 },
  height_cm: { label: 'Рост', unit: 'см', min: 120, max: 230 },
  weight_kg: { label: 'Вес', unit: 'кг', min: 30, max: 300 },
  target_weight_kg: { label: 'Желаемый вес', unit: 'кг', min: 30, max: 300 },
  sleep_hours: { label: 'Сколько часов вы спите в среднем?', unit: 'ч', min: 3, max: 12 },
} as const
type NumKey = keyof typeof NUM

type Draft = {
  sex?: string; goal?: string; experience?: string; activity?: string
  birth_year?: string; height_cm?: string; weight_kg?: string; target_weight_kg?: string; sleep_hours?: string
  equipment: string[]; allergies: string[]; focus: string[]
  sessions_per_week?: string; session_minutes?: string; meals_per_day?: string
  stress?: string; has_injury?: string; injury?: string
  body_now?: number; body_target?: number; squats?: string; pushups?: string; pullups?: string; place?: string
  health?: boolean // health questions are asked only with the separate consent
}

function toDraft(p: ProfileData | null): Draft {
  if (!p) return { equipment: [], allergies: [], focus: [] }
  const s = (v: unknown) => (v === null || v === undefined ? undefined : String(v))
  return {
    sex: p.sex, goal: p.goal, experience: s(p.experience), activity: p.activity,
    birth_year: s(p.birth_year), height_cm: s(p.height_cm), weight_kg: s(p.weight_kg), sleep_hours: s(p.sleep_hours),
    target_weight_kg: s(p.target_weight_kg),
    equipment: p.equipment ?? [], allergies: p.allergies ?? [], focus: p.focus ?? [],
    sessions_per_week: s(p.sessions_per_week), session_minutes: s(p.session_minutes), meals_per_day: s(p.meals_per_day),
    stress: s(p.stress), injury: s(p.injury),
    body_now: p.body_now ?? undefined, body_target: p.body_target ?? undefined,
    squats: s(p.squats), pushups: s(p.pushups), pullups: s(p.pullups), place: s(p.place),
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

/** A sensible target to start from: −10% to lose, +5% to gain, the same to keep. */
function suggestTarget(d: Draft): string | undefined {
  const w = num(d.weight_kg)
  if (!w) return undefined
  const k = d.goal === 'weight_loss' || d.goal === 'fat_loss' ? 0.9 : d.goal === 'muscle_gain' || d.goal === 'mass_gain' ? 1.05 : 1
  return String(Math.round(w * k))
}

/** The goal says one direction, the target weight the other ("снизить вес" with a heavier target). */
function goalConflict(d: Draft): string | null {
  const w = num(d.weight_kg), t = num(d.target_weight_kg)
  if (!w || !t) return null
  if ((d.goal === 'weight_loss' || d.goal === 'fat_loss') && t > w) return 'Цель — снизить вес, а желаемый вес больше текущего. Проверьте.'
  if ((d.goal === 'muscle_gain' || d.goal === 'mass_gain') && t < w) return 'Цель — набрать, а желаемый вес меньше текущего. Проверьте.'
  return null
}

/** Weeks at a safe pace: losing 0.5–0.8 kg a week, gaining 0.25–0.5. */
function planWeeks(weight: number, target: number): [number, number] | null {
  const diff = target - weight
  if (Math.abs(diff) < 0.5) return null
  const [fast, slow] = diff < 0 ? [0.8, 0.5] : [0.5, 0.25]
  return [Math.max(1, Math.round(Math.abs(diff) / fast)), Math.max(1, Math.round(Math.abs(diff) / slow))]
}

type Screen = {
  key: string
  title: string
  hint?: string
  check?: (d: Draft) => string | null
  skip?: (d: Draft) => boolean // not asked (e.g. health questions without the consent)
}

const SCREENS: Screen[] = [
  { key: 'sex', title: 'Давайте знакомиться', check: (d) => (!d.sex ? 'Выберите пол' : null) },
  { key: 'about', title: 'Немного о вас', check: (d) => checkNum(d, 'birth_year') ?? checkNum(d, 'height_cm') ?? checkNum(d, 'weight_kg') },
  { key: 'goal', title: 'Какая у вас цель?', check: (d) => (!d.goal ? 'Выберите цель' : null) },
  { key: 'body_now', title: 'Каково ваше телосложение?', hint: 'Сдвиньте ползунок, чтобы фигура была похожа на вашу.', check: (d) => (!d.body_now ? 'Сдвиньте ползунок' : null) },
  { key: 'body_target', title: 'Какое телосложение — цель?', check: (d) => (!d.body_target ? 'Сдвиньте ползунок' : null) },
  { key: 'target', title: 'Желаемый вес', check: (d) => checkNum(d, 'target_weight_kg') },
  { key: 'body_summary', title: 'Ваш ориентир' },
  { key: 'experience', title: 'Как давно тренируетесь?', check: (d) => (!d.experience ? 'Выберите уровень подготовки' : null) },
  { key: 'squats', title: 'Сколько приседаний подряд вы сделаете?', check: (d) => (!d.squats ? 'Выберите ответ' : null) },
  { key: 'pushups', title: 'А отжиманий?', check: (d) => (!d.pushups ? 'Выберите ответ' : null) },
  { key: 'pullups', title: 'Сколько раз подтянетесь?', check: (d) => (!d.pullups ? 'Выберите ответ' : null) },
  { key: 'activity', title: 'Сколько вы двигаетесь в обычные дни?', check: (d) => (!d.activity ? 'Выберите уровень активности' : null) },
  { key: 'place', title: 'Где будете тренироваться?', check: (d) => (!d.place ? 'Выберите место' : null) },
  { key: 'equipment', title: 'Что есть под рукой?', check: (d) => (!d.equipment.length ? 'Отметьте доступное оборудование' : null) },
  { key: 'schedule', title: 'Сколько времени готовы уделять?', check: (d) => (!d.sessions_per_week ? 'Выберите количество дней' : !d.session_minutes ? 'Выберите длительность' : null) },
  { key: 'focus', title: 'На что сделать упор?', hint: 'Можно выбрать несколько или пропустить.' },
  { key: 'meals', title: 'Сколько раз в день вы едите?', check: (d) => (!d.meals_per_day ? 'Выберите число приёмов пищи' : null) },
  { key: 'recovery', title: 'Сон и стресс', check: (d) => checkNum(d, 'sleep_hours') ?? (!d.stress ? 'Выберите уровень стресса' : null) },
  {
    key: 'health', title: 'Здоровье', skip: (d) => !d.health,
    check: (d) => (!d.has_injury ? 'Укажите, есть ли травмы' : d.has_injury === 'yes' && !d.injury ? 'Выберите зону ограничения' : null),
  },
  { key: 'plan', title: 'Ваш план готов' },
]

function Cards({ label, options, value, onChange, multi, grid }: {
  label: string; options: Opt; value: string | string[] | undefined; onChange: (v: string) => void; multi?: boolean; grid?: boolean
}) {
  const on = (k: string) => (multi ? (value as string[]).includes(k) : value === k)
  return (
    <div className={grid ? 'q-cards q-grid' : 'q-cards'} role={multi ? 'group' : 'radiogroup'} aria-label={label}>
      {Object.entries(options).map(([k, text]) => (
        <button type="button" key={k} aria-pressed={on(k)} onClick={() => onChange(k)}>{text}</button>
      ))}
    </div>
  )
}

function Slider({ label, levels, value, onChange, left, right }: {
  label: string; levels: number; value: number; onChange: (v: number) => void; left: string; right: string
}) {
  return (
    <div className="q-slider">
      <MealRange label={label} min={1} max={levels} step={1} value={value} onChange={onChange}
        valueText={`${value} из ${levels}`} stops={Array.from({ length: levels }, (_, i) => i + 1)} />
      <div className="q-slider-ends"><span>{left}</span><span>{right}</span></div>
    </div>
  )
}

function OptionSlider({ label, options, value, onChange }: {
  label: string; options: Opt; value: string | undefined; onChange: (value: string) => void
}) {
  const entries = Object.entries(options)
  const cursor = entries.findIndex(([key]) => key === value)
  const caption = entries[cursor]?.[1] ?? 'Сдвиньте ползунок'
  return <div className="q-slider">
    <strong>{caption}</strong>
    <MealRange label={label} min={0} max={entries.length - 1} step={1} value={Math.max(0, cursor)}
      valueText={caption} stops={entries.map((_, i) => i)} onChange={index => onChange(entries[index][0])} />
  </div>
}

const sleepStops = [3, 4.5, 6, 7.5, 9, 10.5, 12]

function BodySummary({ draft, sex }: { draft: Draft; sex: 'male' | 'female' }) {
  const weight = num(draft.weight_kg)
  const target = num(draft.target_weight_kg)
  const difference = Math.round((target - weight) * 100) / 100
  const goal = GOALS[draft.goal ?? '']?.replace(/^\S+\s/, '')
  return <>
    <div className="q-body-summary-intro">
      <p className="sub">{goal}</p>
      <h2>{difference === 0 ? 'Сохранить текущий вес' : `${difference < 0 ? 'Снизить вес' : 'Набрать вес'} на ${Math.abs(difference).toLocaleString('ru-RU')} кг`}</h2>
    </div>
    <div className="q-body-summary">
      <div className="card">
        <span>Сейчас</span>
        <BodyFigure sex={sex} level={draft.body_now ?? Math.ceil(NOW_LEVELS / 2)} label="Текущее телосложение" />
        <strong>{weight.toLocaleString('ru-RU')} кг</strong>
      </div>
      <div className="card">
        <span>Цель</span>
        <BodyFigure sex={sex} level={targetAvatar(draft.body_target ?? 2)} label="Желаемое телосложение" />
        <strong>{target.toLocaleString('ru-RU')} кг</strong>
      </div>
    </div>
    {goalConflict(draft) && <p className="q-warn">{goalConflict(draft)}</p>}
    <p className="sub">Дальше уточним вашу подготовку, чтобы подобрать тренировки под эту цель.</p>
  </>
}

export default function Questionnaire({ initial, health = false, onSave, onCancel }: {
  initial: ProfileData | null
  health?: boolean
  onSave: (p: ProfileData) => Promise<void>
  onCancel?: () => void
}) {
  const [d, setD] = useState<Draft>(() => {
    const draft = toDraft(initial)
    return { ...draft, sessions_per_week: draft.sessions_per_week ?? '1', session_minutes: draft.session_minutes ?? '20', health }
  })
  const [at, setAt] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const screens = SCREENS.filter((s) => !s.skip?.(d))
  const screen = screens[Math.min(at, screens.length - 1)]
  const last = screen.key === 'plan'
  const progress = (at + 1) / screens.length

  const set = (k: keyof Draft) => (v: string | number) => { setError(''); setD((p) => ({ ...p, [k]: v })) }
  const toggle = (k: 'equipment' | 'allergies' | 'focus') => (v: string) => {
    setError('')
    setD((p) => ({ ...p, [k]: p[k].includes(v) ? p[k].filter((x) => x !== v) : [...p[k], v] }))
  }

  function go(step: number) {
    setError('')
    setAt((i) => Math.max(0, Math.min(screens.length - 1, i + step)))
    window.scrollTo(0, 0)
  }

  function next() {
    const problem = screen.check?.(d)
    if (problem) return setError(problem)
    // the target weight starts from a suggestion for the chosen goal
    if (screen.key === 'body_target' && !d.target_weight_kg) setD((p) => ({ ...p, target_weight_kg: suggestTarget(p) }))
    if (!last) return go(1)
    save()
  }

  function build(): ProfileData {
    return {
      sex: d.sex as ProfileData['sex'], goal: d.goal as ProfileData['goal'], activity: d.activity as ProfileData['activity'],
      birth_year: Math.round(num(d.birth_year)), height_cm: Math.round(num(d.height_cm)), weight_kg: num(d.weight_kg),
      experience: d.experience as ProfileData['experience'], equipment: d.equipment,
      sessions_per_week: Number(d.sessions_per_week), session_minutes: Number(d.session_minutes),
      allergies: health ? d.allergies : [], meals_per_day: Number(d.meals_per_day), sleep_hours: num(d.sleep_hours),
      stress: d.stress as ProfileData['stress'], injury: health && d.has_injury === 'yes' ? (d.injury as ProfileData['injury']) : null,
      body_now: d.body_now ?? null, body_target: d.body_target ?? null,
      squats: (d.squats ?? null) as ProfileData['squats'], pushups: (d.pushups ?? null) as ProfileData['pushups'],
      pullups: (d.pullups ?? null) as ProfileData['pullups'], place: (d.place ?? null) as ProfileData['place'],
      focus: d.focus, target_weight_kg: num(d.target_weight_kg) || null,
    }
  }

  async function save() {
    setBusy(true)
    try {
      await onSave(build())
    } catch {
      setError('Не удалось сохранить. Проверьте соединение и попробуйте ещё раз.')
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
  const sex = d.sex === 'female' ? 'female' : 'male'
  useEffect(() => {
    if (screen.key !== 'about') return
    for (let level = 1; level <= NOW_LEVELS; level++) {
      const avatar = new Image()
      avatar.src = bodyAvatarSource(sex, level)
    }
  }, [screen.key, sex])
  const photo = (file: string, alt: string) => <img className="q-photo" src={IMG + file} alt={alt} />
  const optionsSlider = (label: string, options: Opt, key: keyof Draft) =>
    <OptionSlider label={label} options={options} value={d[key] as string | undefined} onChange={set(key)} />
  function body() {
    switch (screen.key) {
      case 'sex': return <Cards label="Пол" options={SEX} value={d.sex} onChange={set('sex')} grid />
      case 'about': return <>{numField('birth_year')}<div className="grid2">{numField('height_cm')}{numField('weight_kg', true)}</div></>
      case 'goal': return <Cards label="Основная цель" options={GOALS} value={d.goal} onChange={goal => {
        setError('')
        setD(p => p.goal === goal ? p : { ...p, goal, target_weight_kg: undefined })
      }} />
      case 'body_now': return <>
        <BodyFigure sex={sex} level={d.body_now ?? Math.ceil(NOW_LEVELS / 2)} label={`Телосложение: ${d.body_now ?? '—'} из ${NOW_LEVELS}`} />
        <Slider label="Телосложение сейчас" levels={NOW_LEVELS} value={d.body_now ?? Math.ceil(NOW_LEVELS / 2)} onChange={set('body_now')} left="Меньше жира" right="Больше жира" />
      </>
      case 'body_target': return <>
        <BodyFigure sex={sex} level={targetAvatar(d.body_target ?? 2)} label={`Цель: ${d.body_target ?? '—'} из ${TARGET_LEVELS}`} />
        <Slider label="Целевое телосложение" levels={TARGET_LEVELS} value={d.body_target ?? 2} onChange={set('body_target')}
          left={sex === 'female' ? 'Стройное и подтянутое' : 'Стройное и атлетичное'} right={sex === 'female' ? 'Спортивное и рельефное' : 'Сильное и массивное'} />
      </>
      case 'target': {
        const w = num(d.weight_kg), t = num(d.target_weight_kg)
        // ±40 kg around the current weight: on 30–300 kg one pixel of a phone slider was ~1 kg
        const lo = Math.max(NUM.target_weight_kg.min, Math.round((w || 70) - 40)), hi = Math.min(NUM.target_weight_kg.max, Math.round((w || 70) + 40))
        return <>
          <div className="q-slider">
            <strong>{(t || 70).toLocaleString('ru-RU')} кг</strong>
            <MealRange label="Желаемый вес" min={lo} max={hi}
              step={0.5} value={t || 70} valueText={`${t || 70} кг`} stops={[lo, Math.round((lo + hi) / 2), hi]}
              onChange={value => set('target_weight_kg')(String(value))} />
            <div className="q-slider-ends"><span>{lo} кг</span><span>{hi} кг</span></div>
          </div>
          {w > 0 && t > 0 && <p className="sub">{t < w ? `Минус ${(w - t).toLocaleString('ru-RU')} кг` : t > w ? `Плюс ${(t - w).toLocaleString('ru-RU')} кг` : 'Сохранить текущий вес'} · сейчас {w.toLocaleString('ru-RU')} кг</p>}
          {goalConflict(d) && <p className="q-warn">{goalConflict(d)}</p>}
        </>
      }
      case 'body_summary': return <BodySummary draft={d} sex={sex} />
      case 'experience': return optionsSlider('Уровень подготовки', EXPERIENCE, 'experience')
      case 'squats': return <>{photo('bodyweight_squat.jpg', 'Приседания')}<Cards label="Приседания" options={SQUATS} value={d.squats} onChange={set('squats')} grid /></>
      case 'pushups': return <>{photo('pushup_floor.webp', 'Отжимания от пола')}<Cards label="Отжимания" options={PUSHUPS} value={d.pushups} onChange={set('pushups')} grid /></>
      case 'pullups': return <>{photo('pullup.webp', 'Подтягивания')}<Cards label="Подтягивания" options={PULLUPS} value={d.pullups} onChange={set('pullups')} grid /></>
      case 'activity': return <Cards label="Повседневная активность" options={ACTIVITY} value={d.activity} onChange={set('activity')} />
      case 'place': return <Cards label="Место тренировок" options={PLACE} value={d.place}
        onChange={place => {
          setError('')
          setD(p => ({ ...p, place, equipment: p.place === place && p.equipment.length ? p.equipment : PLACE_EQUIPMENT[place] }))
        }} />
      case 'equipment': return <Cards label="Доступное оборудование" options={EQUIPMENT} value={d.equipment} onChange={toggle('equipment')} multi grid />
      case 'schedule': return <>
        {optionsSlider('Дней в неделю', DAYS, 'sessions_per_week')}
        {optionsSlider('Длительность тренировки', MINUTES, 'session_minutes')}
      </>
      case 'focus': return <Cards label="Упор" options={FOCUS} value={d.focus} onChange={toggle('focus')} multi grid />
      case 'meals': return optionsSlider('Приёмов пищи в день', MEALS, 'meals_per_day')
      case 'recovery': return <>
        <fieldset className="field">
          <legend>Сон, часов</legend>
          <div className="q-slider">
            <strong>{(num(d.sleep_hours) || 8).toLocaleString('ru-RU')} ч</strong>
            <MealRange label="Сон, часов" min={NUM.sleep_hours.min} max={NUM.sleep_hours.max}
              step={0.5} value={num(d.sleep_hours) || 8} stops={sleepStops}
              onChange={value => set('sleep_hours')(String(value))} />
            <div className="q-slider-ends"><span>3 ч</span><span>12 ч</span></div>
          </div>
        </fieldset>
        <fieldset className="field"><legend>Уровень стресса</legend>{optionsSlider('Уровень стресса', STRESS, 'stress')}</fieldset>
      </>
      case 'health': return <>
        <fieldset className="field">
          <legend>Аллергии и непереносимость</legend>
          <p className="q-allergy-help">Если их нет, пропустите этот вопрос.</p>
          <Cards label="Аллергии" options={ALLERGIES} value={d.allergies} onChange={toggle('allergies')} multi grid />
        </fieldset>
        <fieldset className="field"><legend>Есть ли травмы или ограничения?</legend><Cards label="Травмы" options={YES_NO} value={d.has_injury} onChange={set('has_injury')} grid /></fieldset>
        {d.has_injury === 'yes' && <fieldset className="field"><legend>Какая зона?</legend><Cards label="Зона" options={INJURY} value={d.injury} onChange={set('injury')} grid /></fieldset>}
      </>
      case 'plan': return <Plan d={d} />
    }
    return null
  }

  return (
    <div className="screen questionnaire">
      <div className="q-top">
        {at > 0 || onCancel
          ? <button type="button" className="q-back" aria-label={at > 0 ? 'Назад' : 'Отмена'} onClick={() => (at > 0 ? go(-1) : onCancel?.())}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          : <span />}
        <svg className="q-ring" viewBox="0 0 36 36" role="img" aria-label={`Вопрос ${at + 1} из ${screens.length}`}>
          <circle cx="18" cy="18" r="15" pathLength="100" />
          <circle cx="18" cy="18" r="15" pathLength="100" strokeDasharray={`${progress * 100} 100`} />
        </svg>
      </div>
      <div className="questionnaire-heading" key={`h${screen.key}`}>
        <h1>{screen.title}</h1>
        {screen.hint && <p className="sub">{screen.hint}</p>}
      </div>
      <section className={`q-body q-${screen.key}`} key={screen.key}>{body()}</section>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="q-foot">
        <button type="button" className="btn" disabled={busy} onClick={next}>
          {busy ? 'Сохраняем…' : last ? 'Сохранить и начать' : screen.key === 'focus' && !d.focus.length ? 'Пропустить' : 'Продолжить'}
        </button>
      </div>
    </div>
  )
}

/** The summary before saving: from the answers, at a safe pace; no promises. */
function Plan({ d }: { d: Draft }) {
  const w = num(d.weight_kg), t = num(d.target_weight_kg) || w
  const weeks = planWeeks(w, t)
  const days = Number(d.sessions_per_week) || 0
  const goal = GOALS[d.goal ?? '']?.replace(/^\S+\s/, '') ?? ''
  const pathY = (x: number) => (t < w ? 18 + 64 * (1 - Math.pow(1 - x, 2)) : t > w ? 82 - 64 * (1 - Math.pow(1 - x, 2)) : 50)
  const curve = Array.from({ length: 21 }, (_, i) => `${i ? 'L' : 'M'}${(14 + i * 13.6).toFixed(1)},${pathY(i / 20).toFixed(1)}`).join(' ')
  return (
    <div className="q-plan">
      <div className="card q-plan-goal">
        <div className="q-plan-row"><span className="sub">Цель</span><b>{goal}</b></div>
        {weeks && <div className="q-plan-row"><span className="sub">Срок при безопасном темпе</span><b>{weeks[0] === weeks[1] ? weeks[0] : `${weeks[0]}–${weeks[1]}`} нед.</b></div>}
        <svg viewBox="0 0 300 100" className="q-plan-curve" aria-hidden="true">
          <path d={curve} />
          <circle cx="14" cy={pathY(0)} r="6" className="from" /><circle cx="286" cy={pathY(1)} r="6" className="to" />
        </svg>
        <div className="q-plan-ends"><span><b>{w.toLocaleString('ru-RU')} кг</b><small>сейчас</small></span><span><b>{t.toLocaleString('ru-RU')} кг</b><small>цель</small></span></div>
      </div>
      <div className="q-plan-pair">
        <div className="card"><b className="q-big">{d.session_minutes}</b><span className="sub">минут на тренировку</span></div>
        <div className="card"><b className="q-big">{days}</b><span className="sub">{days === 1 ? 'тренировка' : days < 5 ? 'тренировки' : 'тренировок'} в неделю</span>
          <span className="q-week" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <i key={i} className={i < days ? 'on' : ''} />)}</span></div>
      </div>
      <div className="card q-plan-list">
        <b>Что дальше</b>
        <span>✓ Подберём программу под вашу форму и место</span>
        <span>✓ Рассчитаем калории и белок под цель</span>
        <span>✓ Будем вести вес и замеры, подстроим норму по факту</span>
      </div>
      <p className="sub">Сроки — ориентир при снижении 0,5–0,8 кг или наборе 0,25–0,5 кг в неделю, а не обещание.</p>
    </div>
  )
}
