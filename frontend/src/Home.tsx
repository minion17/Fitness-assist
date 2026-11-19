// Daily overview with compact food and workout summaries.
import { Fragment, useRef, useState } from 'react'
import type { Targets } from './profile'
import { Sheet, Chevron } from './ui'
import { useCountUp } from './motion'
import { nextDay, type FoodDay, type Program, type WorkoutLog } from './types'
import { Icon, type IconName } from './icons'

export type Water = { ml: number; goal_ml: number }
export type WeekDay = { date: string; kcal: number; water_ml: number; workouts: number }
export type FoodIntent = 'photo' | 'text' | 'search'

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU')
const liters = (ml: number) => (ml / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const exercisesLabel = (n: number) => `${n} ${n % 100 >= 11 && n % 100 <= 14 ? 'упражнений' : n % 10 === 1 ? 'упражнение' : n % 10 >= 2 && n % 10 <= 4 ? 'упражнения' : 'упражнений'}`

const PORTIONS = [150, 250, 330, 500]

/** A glass that fills up to the day's goal, with a slow wave on top. */
function Glass({ frac }: { frac: number }) {
  const level = useCountUp(Math.max(0, Math.min(1, frac)))
  const top = 6 + (1 - level) * 54  // water surface: y=60 empty .. y=6 full
  return (
    <svg className="glass" width="46" height="64" viewBox="0 0 46 64" aria-hidden="true">
      <defs><clipPath id="glass-in"><path d="M5 4h36l-4 54a4 4 0 0 1-4 4H13a4 4 0 0 1-4-4z" /></clipPath></defs>
      <g clipPath="url(#glass-in)">
        <rect x="0" y="0" width="46" height="64" fill="var(--water-soft)" />
        {level > 0.01 && (
          <g style={{ transform: `translateY(${top}px)` }} className="glass-water">
            <path className="glass-wave" d="M-46 3 q5.75 -4 11.5 0 t11.5 0 t11.5 0 t11.5 0 t11.5 0 t11.5 0 t11.5 0 t11.5 0 V70 H-46z" fill="var(--water)" />
          </g>
        )}
      </g>
      <path d="M5 4h36l-4 54a4 4 0 0 1-4 4H13a4 4 0 0 1-4-4z" fill="none" stroke="color-mix(in srgb, var(--water) 55%, transparent)" strokeWidth="2" />
    </svg>
  )
}

const PORTION_KEY = 'setly-water-portion' // the quick button pours what the user picked last (a 330 ml can, a 500 ml bottle)
const savedPortion = () => { try { const n = Number(localStorage.getItem(PORTION_KEY)); return n >= 50 && n <= 1000 ? n : 250 } catch { return 250 } }

function WaterCard({ water, canEdit, onWater, onPortion }: { water: Water; canEdit: boolean; onWater: (delta: number) => void; onPortion: (ml: number) => void }) {
  const [remove, setRemove] = useState(false) // "Убрать": the same chips subtract (any amount, not only the last glass)
  const [custom, setCustom] = useState<string | null>(null)
  const ml = Number(custom)
  const sign = remove ? -1 : 1
  const customOk = Number.isInteger(ml) && ml >= 10 && ml <= (remove ? Math.min(1000, water.ml) : 1000)
  const change = (n: number) => {
    onWater(sign * Math.min(n, remove ? water.ml : n))
    if (!remove) onPortion(n)
    setCustom(null)
    if (remove) setRemove(false) // a correction is usually one tap; back to adding
  }

  return (
    <section className={`card water${remove ? ' water-removing' : ''}`}>
      <div className="water-row">
        <Glass frac={water.goal_ml > 0 ? water.ml / water.goal_ml : 0} />
        <div className="row-main water-text">
          <span className="sub">Вода</span>
          <span className="water-amount">{liters(water.ml)} <span className="muted">/ {liters(water.goal_ml)} л</span></span>
          <span className="sub">{water.ml >= water.goal_ml ? 'Норма выполнена 💧' : `ещё ${liters(water.goal_ml - water.ml)} л`}</span>
        </div>
        {canEdit && water.ml > 0 && (
          <div className="water-mode" role="group" aria-label="Режим">
            <button aria-pressed={!remove} aria-label="Режим: добавлять" onClick={() => { setRemove(false); setCustom(null) }}>+</button>
            <button aria-pressed={remove} aria-label="Режим: убирать" onClick={() => { setRemove(true); setCustom(null) }}>−</button>
          </div>
        )}
      </div>
      {canEdit && (custom === null ? (
        <div className="water-chips">
          {PORTIONS.map((n) => (
            <button key={n} aria-label={`${remove ? 'Убрать' : 'Добавить'} ${n} мл`} disabled={remove && water.ml <= 0} onClick={() => change(n)}>
              {remove ? '−' : '+'}{n}
            </button>
          ))}
          <button aria-label={remove ? 'Убрать свой объём' : 'Свой объём'} onClick={() => setCustom('')}>Своё</button>
        </div>
      ) : (
        <div className="water-chips">
          <div className="input-wrap water-input">
            <input autoFocus inputMode="numeric" aria-label={remove ? 'Убрать, мл' : 'Объём, мл'} placeholder="мл" value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 4))}
              onKeyDown={(e) => { if (e.key === 'Enter' && customOk) change(ml) }} />
            <i>мл</i>
          </div>
          <button disabled={!customOk} onClick={() => change(ml)}>{remove ? 'Убрать' : 'Добавить'}</button>
          <button className="water-cancel" onClick={() => setCustom(null)}>Отмена</button>
        </div>
      ))}
    </section>
  )
}

function UsualCard({ meal, title, kcal, run }: { meal: string; title: string; kcal: number; run: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <button className="card usual-card" disabled={busy} onClick={() => { setBusy(true); run() }}>
      <span className="usual-icon" aria-hidden="true"><Icon name="repeat" /></span>
      <span className="step-text"><b>{meal} как обычно</b><span className="sub">{title} · {fmt(kcal)} ккал</span></span>
      <span className="usual-go">{busy ? '…' : 'Записать'}</span>
    </button>
  )
}

type Block = 'workout' | 'habits' | 'quests' | 'weight' | 'usual'
const BLOCKS: Record<Block, { icon: IconName; name: string; hint: string }> = {
  workout: { icon: 'dumbbell', name: 'Тренировка на сегодня', hint: 'Следующий день вашей программы' },
  habits: { icon: 'check', name: 'Привычки', hint: 'Отметки за день: сон, шаги, витамины' },
  quests: { icon: 'trophy', name: 'Задания недели', hint: 'Три задания и XP за них' },
  weight: { icon: 'scale', name: 'Вес', hint: 'Записать вес в два нажатия' },
  usual: { icon: 'repeat', name: 'Подсказка «как обычно»', hint: 'Ваш обычный завтрак, обед или ужин — одной кнопкой' },
}
const LAYOUT_KEY = 'setly-home-layout'
type Layout = { order: Block[]; hidden: Block[] }
const DEFAULT_LAYOUT: Layout = { order: ['workout', 'habits', 'quests', 'weight'], hidden: [] }
function savedLayout(): Layout {
  try {
    const l = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null') as Layout | null
    if (!l) return DEFAULT_LAYOUT
    const order = l.order.filter((b) => DEFAULT_LAYOUT.order.includes(b))
    return { order: [...order, ...DEFAULT_LAYOUT.order.filter((b) => !order.includes(b))], hidden: l.hidden.filter((b) => b in BLOCKS) }
  } catch { return DEFAULT_LAYOUT }
}

/** "Главный экран": what to show and in which order; the screen behind updates as you go. Kept on the phone. */
function HomeSettings({ layout, onChange, onClose }: { layout: Layout; onChange: (l: Layout) => void; onClose: () => void }) {
  const move = (b: Block, d: number) => {
    const o = [...layout.order], i = o.indexOf(b), j = i + d
    if (j < 0 || j >= o.length) return
    ;[o[i], o[j]] = [o[j], o[i]]
    onChange({ ...layout, order: o })
  }
  const toggle = (b: Block) => onChange({ ...layout, hidden: layout.hidden.includes(b) ? layout.hidden.filter((x) => x !== b) : [...layout.hidden, b] })
  const row = (b: Block, i?: number) => {
    const on = !layout.hidden.includes(b), { icon, name, hint } = BLOCKS[b]
    return (
      <li key={b} className={on ? 'home-setting' : 'home-setting off'}>
        <span className="home-row-icon" aria-hidden="true"><Icon name={icon} /></span>
        <span className="step-text"><b>{name}</b><span className="sub">{on ? hint : 'Скрыто'}</span></span>
        {i !== undefined && (
          <span className="home-setting-move">
            <button className="icon-btn" aria-label={`${name}: выше`} disabled={i === 0} onClick={() => move(b, -1)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
            </button>
            <button className="icon-btn" aria-label={`${name}: ниже`} disabled={i === layout.order.length - 1} onClick={() => move(b, 1)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
          </span>
        )}
        <button role="switch" className="switch" aria-checked={on} aria-label={`Показывать: ${name}`} onClick={() => toggle(b)}><i /></button>
      </li>
    )
  }
  const changed = JSON.stringify(layout) !== JSON.stringify(DEFAULT_LAYOUT)
  return (
    <Sheet title="Главный экран" onClose={onClose}>
      <p className="sub">Включите то, что хотите видеть, и расставьте стрелками в удобном порядке. Главная за окном меняется сразу.</p>
      <div className="home-setting fixed">
        <span className="home-row-icon" aria-hidden="true"><Icon name="utensils" /></span>
        <span className="step-text"><b>Питание и вода</b><span className="sub">Всегда наверху</span></span>
      </div>
      <h3 className="home-settings-h">Блоки — сверху вниз</h3>
      <ul className="home-settings">{layout.order.map((b, i) => row(b, i))}</ul>
      <h3 className="home-settings-h">Подсказки</h3>
      <ul className="home-settings">{row('usual')}</ul>
      <div className="home-settings-foot">
        {changed && <button className="btn btn-ghost" onClick={() => onChange(DEFAULT_LAYOUT)}>Как было</button>}
        <button className="btn" onClick={onClose}>Готово</button>
      </div>
    </Sheet>
  )
}

export default function Home(props: {
  name: string
  level: number
  loading?: boolean // first open, nothing kept yet: placeholders instead of zeros
  boostUntil?: string | null
  streak: number
  targets?: Targets
  day: FoodDay
  program?: Program
  trainingDays?: number[] | null // from the questionnaire: other days are rest days
  logs: WorkoutLog[]
  water: Water
  aiEnabled: boolean
  canEdit: boolean
  onFood: (intent: FoodIntent) => void
  onNutrition: () => void
  onWorkouts: () => void
  onWater: (delta: number) => void
  intro?: React.ReactNode
  quests?: React.ReactNode
  habits?: React.ReactNode
  habitsDone?: [number, number] // done, total: they count in the day's ring
  weight?: React.ReactNode // quick weigh-in, below the day's main cards
  repeat?: { title: string; kcal: number; run: () => void } | null
  usual?: { meal: string; title: string; kcal: number; run: () => void } | null // "Как обычно": the usual meal in one tap
}) {
  const { targets, day, water } = props
  const [waterOpen, setWaterOpen] = useState(false) // the glass with +/- and portions, under the day card
  const [layout, setLayout] = useState(savedLayout)
  const [arranging, setArranging] = useState(false)
  const changeLayout = (l: Layout) => { setLayout(l); try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)) } catch { /* private mode */ } }
  const shows = (b: Block) => !layout.hidden.includes(b)
  const [portion, setPortion] = useState(savedPortion)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = useRef(false)
  const choosePortion = (ml: number) => { setPortion(ml); try { localStorage.setItem(PORTION_KEY, String(ml)) } catch { /* private mode */ } }
  const [today] = useState(() => {
    const s = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
    return s[0].toUpperCase() + s.slice(1)
  })
  const goal = targets?.calories ?? 2000
  const foodRatio = goal > 0 ? Math.max(0, day.totals.kcal / goal) : 0
  const foodProgress = foodRatio < 0.9 ? foodRatio : foodRatio <= 1.1 ? 1 : Math.max(0, 2.1 - foodRatio)
  const waterProgress = water.goal_ml > 0 ? Math.min(1, Math.max(0, water.ml / water.goal_ml)) : 0
  // the day's ring: food (in the norm = full; over it costs), water, habits (if any), a workout done today (rest days don't cost)
  const [hDone, hTotal] = props.habitsDone ?? [0, 0]
  const [todayIso] = useState(() => new Date().toLocaleDateString('sv-SE'))
  const trained = props.logs.some((l) => l.completed_at && new Date(l.completed_at).toLocaleDateString('sv-SE') === todayIso)
  const parts = [
    { label: 'Питание', value: foodProgress, note: foodRatio > 1.1 ? `на ${fmt(day.totals.kcal - goal)} ккал больше нормы` : foodRatio >= 0.9 ? 'в норме' : `ещё ${fmt(goal - day.totals.kcal)} ккал` },
    { label: 'Вода', value: waterProgress, note: water.ml >= water.goal_ml ? 'норма выполнена' : `ещё ${liters(water.goal_ml - water.ml)} л` },
    ...(hTotal ? [{ label: 'Привычки', value: hDone / hTotal, note: `${hDone} из ${hTotal}` }] : []),
    ...(trained ? [{ label: 'Тренировка', value: 1, note: 'сделана' }] : []),
  ]
  const progress = Math.round((parts.reduce((n, p) => n + p.value, 0) / parts.length) * 100)
  // in the evening the card opens with the day's summary: what is done and what can still be made up
  const [evening] = useState(() => new Date().getHours() >= 20)
  const [whyOpen, setWhyOpen] = useState(evening)
  const shownProgress = Math.round(useCountUp(props.loading ? 0 : progress))
  const shownKcal = useCountUp(day.totals.kcal)
  const shownWater = useCountUp(water.ml)
  const next = props.program && nextDay(props.program, props.logs)
  const [weekday] = useState(() => (new Date().getDay() + 6) % 7) // 0 = Mon, as in the questionnaire
  const days = props.trainingDays ?? []
  const restDay = !!next && days.length > 0 && !days.includes(weekday) && !trained
  const nextTraining = restDay ? ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'][days.find((d) => d > weekday) ?? days[0]] : null

  return (
    <>
      <header className="home-head">
        <div>
          <p className="hello">{today}</p>
          <h1 className="home-title">Привет, {props.name}</h1>
        </div>
        <div className="home-chips" style={props.loading ? { visibility: 'hidden' } : undefined}>
          {props.boostUntil && ( // the server sends it only while the boost lasts
            <span className="pill pill-boost" title={`Бустер за победу в дуэли: ×1,5 XP до ${new Date(props.boostUntil).toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}>
              ⚡ ×1,5<span className="sr-only"> XP: бустер за победу в дуэли</span>
            </span>
          )}
          <span className="pill" title="Дней подряд">
            <svg className={props.streak > 0 ? 'flame lit' : 'flame'} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--streak)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3c1 3 4 4.5 4 8.5A4 4 0 0 1 8 12c0-1.5.7-2.6 1.5-3.5C10 10 11 10.5 11 10.5 11 7 12 3 12 3z" /></svg>
            <span className="bump" key={props.streak}>{props.streak}</span><span className="sr-only"> дней подряд</span>
          </span>
        </div>
      </header>

      {props.intro}

      {/* the day in one card: ring + calories + water */}
      <section className="card day-card" aria-busy={props.loading}>
        <button className="daily-progress-ring" aria-expanded={whyOpen} aria-label={props.loading ? 'Загрузка' : `Прогресс дня: ${progress}%. Из чего он сложился`} onClick={() => setWhyOpen(!whyOpen)}>
          <svg viewBox="0 0 200 200" aria-hidden="true"><circle className="daily-ring-track" cx="100" cy="100" r="86" />{!props.loading && shownProgress > 0 && <circle className={foodRatio > 1.1 ? 'daily-ring-value over' : 'daily-ring-value'} cx="100" cy="100" r="86" pathLength="100" strokeDasharray={`${shownProgress} 100`} />}</svg>
          <div className="daily-progress-center">{props.loading ? <span className="skeleton skeleton-num" /> : <><strong>{shownProgress}%</strong><span className="sub day-why-hint">день <Chevron /></span></>}</div>
        </button>
        <div className="day-stats">
          <button className="day-stat" onClick={props.onNutrition} aria-label="Питание: открыть дневник">
            <span className="sub">Питание</span>
            <span className="day-stat-value">{props.loading ? <span className="skeleton skeleton-line" /> : <>{fmt(shownKcal)} <small>/ {fmt(goal)} ккал</small></>}</span>
            {foodRatio > 1.1 && <span className="sub warn">на {fmt(day.totals.kcal - goal)} больше нормы</span>}
          </button>
          <button className="day-stat" aria-expanded={waterOpen} onClick={() => setWaterOpen(!waterOpen)} aria-label="Вода: подробнее">
            <span className="sub">Вода</span>
            <span className="day-stat-value water-value">{liters(Math.round(shownWater / 10) * 10)} <small>/ {liters(water.goal_ml)} л</small></span>
          </button>
        </div>
        {whyOpen && !props.loading && (
          <ul className="day-why">
            {evening && <li className="day-why-title"><b>{progress >= 100 ? 'День закрыт 🎉' : 'Итог дня'}</b><span className="sub">{progress >= 100 ? 'Всё по плану — так держать' : 'Ещё можно успеть:'}</span></li>}
            {parts.map((p) => (
              <li key={p.label}><span>{p.label}</span><span className="sub">{p.note}</span><b className={p.value >= 1 ? 'full' : ''}>{Math.round(p.value * 100)}%</b></li>
            ))}
            {targets?.protein ? <li><span>Белок</span><span className="sub">{day.totals.protein_g >= targets.protein * 0.9 ? 'в норме' : `ещё ${fmt(targets.protein - day.totals.protein_g)} г`}</span><b className={day.totals.protein_g >= targets.protein * 0.9 ? 'full' : ''}>{fmt(day.totals.protein_g)} г</b></li> : null}
            {!trained && <li className="sub">Тренировка добавится в круг, когда вы её проведёте сегодня.</li>}
          </ul>
        )}
      </section>

      {waterOpen && <WaterCard water={water} canEdit={props.canEdit} onWater={props.onWater} onPortion={choosePortion} />}

      {props.canEdit && (
        <div className="home-actions">
          <button className="btn btn-icon" onClick={() => props.onFood(props.aiEnabled ? 'photo' : 'search')}>
            {props.aiEnabled && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>}
            {props.aiEnabled ? 'Добавить еду' : '+ Добавить еду'}
          </button>
          <button className="btn btn-ghost btn-side water-quick" aria-label={`Добавить воды, ${portion} мл`} title="Зажмите — другие порции"
            onPointerDown={() => { longPressed.current = false; pressTimer.current = setTimeout(() => { longPressed.current = true; navigator.vibrate?.(10); setWaterOpen(true) }, 450) }}
            onPointerUp={() => { if (pressTimer.current) clearTimeout(pressTimer.current) }} onPointerLeave={() => { if (pressTimer.current) clearTimeout(pressTimer.current) }}
            onContextMenu={(e) => e.preventDefault()}
            onClick={() => { if (!longPressed.current) props.onWater(portion) }}>+💧 {portion}</button>
        </div>
      )}
      {props.usual && shows('usual') && <UsualCard {...props.usual} />}
      {props.repeat && (
        <button className="link repeat-link" onClick={props.repeat.run}>↻ {props.repeat.title.toLowerCase()} · {fmt(props.repeat.kcal)} ккал</button>
      )}

      {/* the blocks in the user's order; neighbouring rows share one card, the weight is a card of its own */}
      {layout.order.filter(shows).reduce<Block[][]>((groups, b) => {
        const last = groups[groups.length - 1]
        if (b !== 'weight' && last && last[0] !== 'weight') last.push(b); else groups.push([b])
        return groups
      }, []).map((g) => g[0] === 'weight' ? <Fragment key="weight">{props.weight}</Fragment> : (
        <div className="card home-rows" key={g.join()}>
          {g.map((b) => b === 'workout' ? (
            <button key={b} className="home-row" onClick={props.onWorkouts}>
              <span className="home-row-icon" aria-hidden="true"><Icon name="dumbbell" /></span>
              {props.loading && !next ? <span className="step-text"><span className="skeleton skeleton-line" style={{ width: 180 }} /><span className="skeleton skeleton-line" style={{ width: 90, height: 14, marginTop: 6 }} /></span> // not "choose a program" before the program has loaded
                : <span className="step-text"><b>{restDay ? 'Сегодня отдых 😌' : next ? `Сегодня: ${next.day_name}` : 'Выберите программу тренировок'}</b>
                <span className="sub">{restDay ? `Следующая тренировка — ${nextTraining}: ${next!.day_name}` : next ? exercisesLabel(next.exercises.length) : 'Готовую или свою'}</span></span>}
              <span className="step-go" aria-hidden="true"><Chevron dir="right" /></span>
            </button>
          ) : <Fragment key={b}>{b === 'habits' ? props.habits : props.quests}</Fragment>)}
        </div>
      ))}
      {props.canEdit && <button className="link home-arrange" onClick={() => setArranging(true)}>⚙ Настроить главный экран</button>}
      {arranging && <HomeSettings layout={layout} onChange={changeLayout} onClose={() => setArranging(false)} />}
    </>
  )
}
