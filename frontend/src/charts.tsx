// Small SVG charts in the app's style: one series each (title names it, no legend), tap a mark to read its value.
import { useState } from 'react'

const W = 340
const shortDate = (iso: string) => new Date(iso + 'T12:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '')

export function BarChart({ data, color, goal, unit, height = 140 }: {
  data: { date: string; value: number }[]; color: string; goal?: number; unit: string; height?: number
}) {
  const [sel, setSel] = useState<number | null>(null)
  const max = Math.max(goal ?? 0, ...data.map((d) => d.value), 1) * 1.08
  const gap = data.length > 40 ? 1 : 2
  const bw = (W - gap * (data.length - 1)) / data.length
  const y = (v: number) => height - (v / max) * height
  const shown = sel ?? data.length - 1
  return (
    <figure className="chart">
      <figcaption className="chart-read">
        <b>{data[shown] ? Math.round(data[shown].value).toLocaleString('ru-RU') : '—'}</b> {unit}
        <span>{data[shown] && shortDate(data[shown].date)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${height + 18}`} role="img" aria-label={`График, ${unit}`} onMouseLeave={() => setSel(null)}>
        {data.map((d, i) => {
          const h = Math.max(d.value > 0 ? 3 : 0, height - y(d.value))
          const x = i * (bw + gap)
          return (
            <g key={d.date} onClick={() => setSel(i)} onMouseEnter={() => setSel(i)}>
              <rect x={x} y={0} width={bw + gap} height={height} fill="transparent" />
              {h > 0 && <path d={roundedTop(x, height - h, bw, h, Math.min(4, bw / 2))} fill={color} opacity={sel === null || sel === i ? 1 : 0.45} />}
            </g>
          )
        })}
        {goal ? (
          <g>
            <line x1={0} x2={W} y1={y(goal)} y2={y(goal)} stroke="var(--muted)" strokeDasharray="4 4" strokeWidth={1} />
            <text x={W} y={y(goal) - 4} textAnchor="end" fontSize="10" fill="var(--muted)">норма</text>
          </g>
        ) : null}
        <text x={0} y={height + 14} fontSize="10" fill="var(--muted)">{data[0] && shortDate(data[0].date)}</text>
        <text x={W} y={height + 14} fontSize="10" fill="var(--muted)" textAnchor="end">{data.length > 0 && shortDate(data[data.length - 1].date)}</text>
      </svg>
    </figure>
  )
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, h)
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`
}

export function LineChart({ points, color, unit, height = 140, digits = 1 }: {
  points: { date: string; value: number }[]; color: string; unit: string; height?: number; digits?: number
}) {
  const [sel, setSel] = useState<number | null>(null)
  if (points.length === 0) return null
  const vals = points.map((p) => p.value)
  let lo = Math.min(...vals), hi = Math.max(...vals)
  const pad = Math.max((hi - lo) * 0.15, 1)
  lo -= pad
  hi += pad
  const t0 = Date.parse(points[0].date), t1 = Date.parse(points[points.length - 1].date)
  const x = (iso: string) => (t1 === t0 ? W / 2 : 8 + ((Date.parse(iso) - t0) / (t1 - t0)) * (W - 16))
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * (height - 16)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const shown = sel ?? points.length - 1
  const fmt = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: digits })
  return (
    <figure className="chart">
      <figcaption className="chart-read">
        <b>{fmt(points[shown].value)}</b> {unit}<span>{shortDate(points[shown].date)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${height + 18}`} role="img" aria-label={`График, ${unit}`} onMouseLeave={() => setSel(null)}>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={W} y1={height * f} y2={height * f} stroke="var(--line)" strokeWidth={1} />)}
        <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <g key={p.date} onClick={() => setSel(i)} onMouseEnter={() => setSel(i)}>
            <circle cx={x(p.date)} cy={y(p.value)} r={14} fill="transparent" />
            <circle cx={x(p.date)} cy={y(p.value)} r={i === shown ? 5 : 3.5} fill={color} stroke="var(--card)" strokeWidth={2} />
          </g>
        ))}
        <text x={0} y={height + 14} fontSize="10" fill="var(--muted)">{shortDate(points[0].date)}</text>
        <text x={W} y={height + 14} fontSize="10" fill="var(--muted)" textAnchor="end">{shortDate(points[points.length - 1].date)}</text>
      </svg>
    </figure>
  )
}
