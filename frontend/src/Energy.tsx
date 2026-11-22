// Real expenditure from the user's own diary and weigh-ins, a forecast to the target weight, a plateau hint.
import { useEffect, useState } from 'react'
import { api, postJson } from './telegram'
import { Bar } from './ui'

type Energy = {
  ready: boolean; formula: number; days_logged: number; weighins: number; need_days: number; need_weighins: number
  target_weight_kg: number | null; kcal_override: number | null; goal: string
  tdee?: number; intake?: number; kg_per_week?: number; suggest?: number; weight?: number; in_30_days?: number
  eta?: string | null; plateau?: boolean; plateau_tips?: string[]; plateau_kcal?: number | null
}

const fmt = (n: number) => n.toLocaleString('ru-RU')
const kg = (n: number) => `${n > 0 ? '+' : ''}${String(n).replace('.', ',')} кг`
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })

export default function EnergyCard({ calories, onNormChanged }: { calories?: number; onNormChanged: () => void }) {
  const [e, setE] = useState<Energy | null>(null)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => api<Energy>('/api/insights/energy').then((r) => { if (r) { setE(r); setTarget(r.target_weight_kg ? String(r.target_weight_kg) : '') } }).catch(() => {})
  useEffect(() => { load() }, [])
  if (!e) return null

  async function saveTarget() {
    const v = Number(target.replace(',', '.'))
    await api('/api/profile/target-weight', postJson({ target_weight_kg: target.trim() && v >= 30 && v <= 300 ? v : null })).catch(() => {})
    load()
  }
  async function applyNorm(kcal: number | null) {
    setBusy(true)
    try { await api('/api/insights/energy/apply', postJson({ kcal })); onNormChanged(); await load() } finally { setBusy(false) }
  }

  const goalRow = (
    <label className="energy-target">
      <span>Цель по весу</span>
      <div className="input-wrap"><input inputMode="decimal" placeholder="—" aria-label="Цель по весу, кг" value={target}
        onChange={(ev) => setTarget(ev.target.value)} onBlur={saveTarget} /><i>кг</i></div>
    </label>
  )

  // Two flat weeks while losing or gaining: what to change, in order, and the new norm in one tap
  const plateau = e.plateau && e.plateau_tips?.length ? (
    <div className="energy-note">
      <b>Вес стоит две недели — что поменять:</b>
      <ol className="plateau-tips">{e.plateau_tips.map((t) => <li key={t}>{t}</li>)}</ol>
      {e.plateau_kcal && e.plateau_kcal !== calories && (
        <button className="btn btn-ghost" disabled={busy} onClick={() => applyNorm(e.plateau_kcal!)}>Сделать норму {fmt(e.plateau_kcal)} ккал</button>
      )}
    </div>
  ) : null

  if (!e.ready) {
    const done = Math.min(e.days_logged / e.need_days, 1) * 0.7 + Math.min(e.weighins / e.need_weighins, 1) * 0.3
    return (
      <section className="card energy">
        <div className="card-head"><h2>Реальный расход</h2><span className="sub">по формуле {fmt(e.formula)} ккал</span></div>
        <p className="sub">Посчитаем, сколько ты тратишь на самом деле — по твоему дневнику и весу, а не по формуле. Нужно {e.need_days} дней с полным дневником
          (есть {e.days_logged}) и {e.need_weighins} взвешивания за 10+ дней (есть {e.weighins}).</p>
        <Bar value={done * 100} goal={100} />
        {plateau}
        {goalRow}
      </section>
    )
  }

  const tdee = e.tdee!, suggest = e.suggest!, perWeek = e.kg_per_week!
  const differs = calories !== undefined && Math.abs(suggest - calories) >= 50
  return (
    <section className="card energy">
      <div className="card-head"><h2>Реальный расход</h2><span className="sub">за 4 недели</span></div>
      <div className="energy-main"><b>{fmt(tdee)}</b><span>ккал в день</span></div>
      <p className="sub">По формуле было {fmt(e.formula)}. Ты ел в среднем {fmt(e.intake!)} ккал, вес {perWeek === 0 ? 'не менялся' : `${kg(perWeek)} в неделю`}.</p>
      {plateau}
      <p className="energy-forecast">{e.eta ? <>Цель {String(e.target_weight_kg).replace('.', ',')} кг — примерно <b>к {date(e.eta)}</b></>
        : <>Через 30 дней — около <b>{String(e.in_30_days).replace('.', ',')} кг</b></>}</p>
      {goalRow}
      {differs && (
        <button className="btn" disabled={busy} onClick={() => applyNorm(suggest)}>
          Сделать норму {fmt(suggest)} ккал{e.goal.includes('loss') ? ' (−0,5 кг в неделю)' : e.goal.includes('gain') ? ' (+0,25 кг в неделю)' : ''}
        </button>
      )}
      {e.kcal_override && <button className="link" disabled={busy} onClick={() => applyNorm(null)}>Вернуть норму по формуле</button>}
    </section>
  )
}
