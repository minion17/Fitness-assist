import { useState } from 'react'
import { latestValues, MEASURES, weightTrend, type MeasureKey, type Measurement } from './types'
import { Sheet } from './ui'

const dateRu = (iso: string) => new Date(iso + 'T00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
const LIMITS: Record<MeasureKey, [number, number]> = {
  weight_kg: [30, 300], waist_cm: [30, 250], chest_cm: [40, 250], hips_cm: [40, 250], body_fat_pct: [2, 70],
}

export type MeasurementInput = Partial<Record<MeasureKey, number | null>>

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const w = 300, h = 60, min = Math.min(...values), max = Math.max(...values), span = max - min || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 4 - ((v - min) / span) * (h - 8)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img"
      aria-label={`График веса: от ${values[0]} до ${values[values.length - 1]} кг`}>
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export default function Body({ measurements, canEdit, onSave, onDelete }: {
  measurements: Measurement[]
  canEdit: boolean
  onSave: (m: MeasurementInput) => Promise<void>
  onDelete: (id: number) => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [confirm, setConfirm] = useState<number | null>(null)
  const trend = weightTrend(measurements)
  const latest = latestValues(measurements)
  const weights = measurements.filter((m) => m.weight_kg !== null).slice(0, 30).reverse().map((m) => m.weight_kg!)

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Вес</h2>
          {trend?.delta != null && <span className={trend.delta <= 0 ? 'sub pos' : 'sub'}>{trend.delta > 0 ? '+' : ''}{trend.delta} кг за 30 дней</span>}
        </div>
        {trend ? <div className="stat">{trend.latest}<small>кг</small></div> : <span className="sub">Пока нет замеров</span>}
        <Sparkline values={weights} />
      </section>

      <section className="card">
        <h2>Параметры тела</h2>
        <div className="list">
          {MEASURES.filter((m) => m.key !== 'weight_kg').map((m) => (
            <div className="row" key={m.key}>
              <div className="row-main row-title">{m.label}</div>
              <div className="row-end">{latest[m.key] ? `${latest[m.key]!.value} ${m.unit}` : '—'}</div>
            </div>
          ))}
        </div>
        {canEdit
          ? <button className="btn btn-ghost" onClick={() => setAdding(true)}>+ Добавить замер</button>
          : <span className="sub">Демо-режим: замеры сохраняются, только если открыть приложение из Telegram.</span>}
      </section>

      {measurements.length > 0 && (
        <section className="card">
          <h2>История замеров</h2>
          <div className="list">
            {measurements.slice(0, 10).map((m) => (
              <div className="row" key={m.id}>
                <div className="row-main">
                  <div className="row-title">{dateRu(m.measured_on)}</div>
                  <div className="row-sub">{MEASURES.filter((x) => m[x.key] !== null).map((x) => `${x.label} ${m[x.key]} ${x.unit}`).join(' · ')}</div>
                </div>
                {canEdit && (confirm === m.id ? (
                  <div className="confirm">
                    <button className="link danger" onClick={() => onDelete(m.id).finally(() => setConfirm(null))}>Удалить</button>
                    <button className="link" onClick={() => setConfirm(null)}>Отмена</button>
                  </div>
                ) : <button className="icon-btn" aria-label={`Удалить замер за ${dateRu(m.measured_on)}`} onClick={() => setConfirm(m.id)}>✕</button>)}
              </div>
            ))}
          </div>
        </section>
      )}

      {adding && <AddMeasurement measurements={measurements} onClose={() => setAdding(false)} onSave={onSave} />}
    </>
  )
}

function AddMeasurement({ measurements, onClose, onSave }: {
  measurements: Measurement[]
  onClose: () => void
  onSave: (m: MeasurementInput) => Promise<void>
}) {
  const [today] = useState(() => new Date().toLocaleDateString('sv-SE')) // YYYY-MM-DD in local time
  // Saving replaces today's entry, so start from it; otherwise from the latest known values.
  const base = measurements.find((m) => m.measured_on === today)
  const prev = latestValues(measurements)
  const [values, setValues] = useState<Record<MeasureKey, string>>(() =>
    Object.fromEntries(MEASURES.map(({ key }) => [key, String(base ? base[key] ?? '' : prev[key]?.value ?? '')])) as Record<MeasureKey, string>,
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const out: MeasurementInput = {}
    for (const { key, label } of MEASURES) {
      const raw = values[key].trim().replace(',', '.')
      if (!raw) { out[key] = null; continue }
      const n = Number(raw)
      const [min, max] = LIMITS[key]
      if (!Number.isFinite(n) || n < min || n > max) return setError(`${label}: от ${min} до ${max}`)
      out[key] = n
    }
    if (Object.values(out).every((v) => v === null)) return setError('Заполните хотя бы одно поле')
    setError('')
    setBusy(true)
    try {
      await onSave(out)
      onClose()
    } catch {
      setError('Не удалось сохранить. Проверьте соединение.')
      setBusy(false)
    }
  }

  return (
    <Sheet title="Замер на сегодня" onClose={onClose}>
      <span className="sub">{base ? 'Сегодняшний замер будет обновлён.' : 'Подставлены последние значения — поменяйте то, что изменилось.'}</span>
      <div className="grid2">
        {MEASURES.map(({ key, label, unit }) => (
          <label className="field" key={key}>
            <span>{label}</span>
            <div className="input-wrap">
              <input inputMode="decimal" value={values[key]} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} />
              <i>{unit}</i>
            </div>
          </label>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" disabled={busy} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
    </Sheet>
  )
}
