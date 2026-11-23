// Intermittent fasting: a daily eating window and a timer since the last logged meal (the server picks the start).
// On Home only the timer (when a plan exists); in Food the timer plus the setup. The norm itself doesn't change.
import { useEffect, useState } from 'react'
import { haptic } from './haptics'
import { plural } from './plural'
import { api, putJson } from './telegram'

type Plan = { hours: number; eat_from: string; eat_to: string; remind: boolean }
type Status = { plan: null } | { plan: Plan; fast_start: string; kept: number; logged: number; series?: number }
const PROTOCOLS: [number, string][] = [[12, 'мягкий старт'], [14, 'золотая середина'], [16, 'самая популярная'], [18, 'для опытных']]

const mins = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
export const windowEnd = (from: string, hours: number) => {
  const m = (mins(from) + (24 - hours) * 60) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
export function inWindow(plan: Pick<Plan, 'eat_from' | 'eat_to'>, now: Date): boolean {
  const m = now.getHours() * 60 + now.getMinutes(), a = mins(plan.eat_from), b = mins(plan.eat_to)
  return a < b ? m >= a && m < b : m >= a || m < b
}
/** Minutes until hh:mm next comes round. */
const until = (hhmm: string, now: Date) => (mins(hhmm) - now.getHours() * 60 - now.getMinutes() + 1440) % 1440 || 1440
const dur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} ч ` : '') + `${m % 60} мин`
/** Protein in 2 meals for an 18:6 window, 3 otherwise — 0.3–0.4 g/kg a meal is what muscle uses best. */
export const proteinPerMeal = (protein: number, hours: number) => Math.round(protein / (hours >= 18 ? 2 : 3) / 5) * 5

export default function Fasting({ home = false, protein, refresh = 0 }: { home?: boolean; protein?: number; refresh?: number }) {
  const [s, setS] = useState<Status | null>(null)
  const [edit, setEdit] = useState(() => !home && new URLSearchParams(window.location.search).get('open') === 'fasting')
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { api<Status>('/api/fasting').then((r) => r && setS(r)).catch(() => {}) }, [refresh])
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t) }, [])
  if (!s || (home && !s.plan)) return null

  const save = (body: Plan | null) => {
    haptic('success')
    setEdit(false)
    const req = body ? api<Status>('/api/fasting', putJson({ ...body, safe: true })) : api<Status>('/api/fasting', { method: 'DELETE' })
    req.then((r) => r && setS(r)).catch(() => {})
  }
  if (!s.plan || edit) return <Setup plan={s.plan} open={edit} onOpen={() => setEdit(true)} onSave={save} onCancel={s.plan ? () => setEdit(false) : undefined} />

  const { plan } = s
  const eating = inWindow(plan, now)
  const fasted = Math.max(0, Math.floor((now.getTime() - Date.parse(s.fast_start)) / 60_000))
  const done = fasted >= plan.hours * 60
  return (
    <section className="card fasting" aria-label="Интервальное голодание">
      <div className="card-head">
        <h2>⏱ Голодание {plan.hours}:{24 - plan.hours}</h2>
        {!home && <button className="link" onClick={() => setEdit(true)}>Изменить</button>}
      </div>
      {eating && fasted < 6 * 60 ? <>
        <p className="fasting-big">Окно открыто до {plan.eat_to}</p>
        <p className="sub">Осталось {dur(until(plan.eat_to, now))}.{protein ? ` Белок — по ~${proteinPerMeal(protein, plan.hours)} г за приём, норма КБЖУ та же.` : ''}</p>
      </> : <>
        <p className="fasting-big">{dur(fasted)} <span className="sub">из {plan.hours} ч</span></p>
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(fasted / plan.hours / 0.6))}>
          <i style={{ width: `${Math.min(100, fasted / plan.hours / 0.6)}%`, background: 'var(--accent)' }} />
        </div>
        <p className="sub">{eating ? `Окно открыто до ${plan.eat_to} — можно есть, начни с белка.`
          : done ? `Цель достигнута 🎉 Окно откроется в ${plan.eat_from}.`
          : `Окно откроется в ${plan.eat_from}, через ${dur(until(plan.eat_from, now))}. Вода, чай и кофе без сахара — можно.`}</p>
      </>}
      {(s.series ?? 0) >= 2 && <p className="fasting-series">🔥 Серия в окне: {s.series} {plural(s.series!, 'день', 'дня', 'дней')} — считается сама по дневнику</p>}
      {!home && s.logged > 0 && <p className="sub">За неделю в окне: {s.kept} из {s.logged} дн.</p>}
    </section>
  )
}

function Setup({ plan, open, onOpen, onSave, onCancel }: { plan: Plan | null; open: boolean; onOpen: () => void; onSave: (p: Plan | null) => void; onCancel?: () => void }) {
  const [hours, setHours] = useState(plan?.hours ?? 16)
  const [from, setFrom] = useState(plan?.eat_from ?? '12:00')
  const [remind, setRemind] = useState(plan?.remind ?? true)
  const [safe, setSafe] = useState(!!plan)
  if (!open) return (
    <button className="card fasting-entry" onClick={onOpen}>
      <strong>⏱ Интервальное голодание</strong><small>Схема 16:8 и другие, таймер и напоминания в боте</small>
    </button>
  )
  return (
    <section className="card fasting" aria-label="Настройка голодания">
      <h2>⏱ Интервальное голодание</h2>
      <div className="fasting-protocols" role="radiogroup" aria-label="Схема">
        {PROTOCOLS.map(([h, note]) => (
          <button key={h} role="radio" aria-checked={hours === h} className="fasting-protocol" onClick={() => setHours(h)}>
            <b>{h}:{24 - h}</b><small>{note}</small>
          </button>
        ))}
      </div>
      <div className="fasting-row">
        <label className="time-field"><span>Окно питания с</span><input type="time" value={from} aria-label="Окно питания с" onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <span className="fasting-to">до <b>{windowEnd(from, hours)}</b></span>
      </div>
      <label className="fasting-check"><input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} /> Напоминать в боте, когда окно открывается и закрывается</label>
      <ul className="fasting-facts">
        <li>Голодание помогает не переедать, но жир сам по себе не сжигает: при тех же калориях результат как у обычной диеты.</li>
        <li>Норма КБЖУ остаётся прежней — её нужно съесть в окне. Белок раздели на 2–3 приёма.</li>
        <li>Тренируйся в окне или прямо перед первым приёмом пищи. Сложно — начни с 12:12.</li>
      </ul>
      <div className="fasting-warn">
        <b>Не подходит, если:</b> беременность или кормление грудью; тебе меньше 18; диабет на инсулине или таблетках, снижающих
        сахар; расстройство пищевого поведения сейчас или в прошлом. В этих случаях сначала обсуди с врачом.
        <label className="fasting-check"><input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} /> Ничего из этого не про меня</label>
      </div>
      <button className="btn" disabled={!safe} onClick={() => onSave({ hours, eat_from: from, eat_to: windowEnd(from, hours), remind })}>{plan ? 'Сохранить' : 'Начать'}</button>
      {onCancel && <div className="fasting-actions">
        <button className="link" onClick={onCancel}>Отмена</button>
        <button className="link danger" onClick={() => onSave(null)}>Выключить голодание</button>
      </div>}
    </section>
  )
}
