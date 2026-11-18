import { useState, type CSSProperties } from 'react'
import './MealRange.css'

type Props = {
  label: string; value: number; min: number; max: number; step: number
  valueText?: string; stops?: readonly number[]; onChange: (value: number) => void
}

export default function MealRange({ label, value, min, max, step, valueText, stops, onChange }: Props) {
  const [dragValue, setDragValue] = useState<number | null>(null)
  const fraction = (n: number) => Math.max(0, Math.min(1, (n - min) / (max - min)))
  const position = fraction(dragValue ?? value)
  const snap = (raw: number) => Math.min(max, Math.max(min, min + Math.round((raw - min) / step) * step))
  return <div className="meal-range" data-dragging={dragValue !== null}
    style={{ '--position': position } as CSSProperties}>
    <span className="meal-range-rail" aria-hidden="true"><i />
      {stops?.map(stop => <span className="meal-range-stop" key={stop} style={{ left: `${fraction(stop) * 100}%` }} />)}
      <b /></span>
    <input type="range" aria-label={label} aria-valuetext={valueText ?? String(value)}
      min={min} max={max} step="any" value={dragValue ?? value}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setDragValue(value) }}
      onPointerUp={e => {
        if (stops) onChange(snap(e.currentTarget.valueAsNumber))
        setDragValue(null)
      }}
      onLostPointerCapture={() => setDragValue(null)}
      onBlur={() => setDragValue(null)}
      onChange={e => {
        const raw = e.currentTarget.valueAsNumber
        if (dragValue !== null) setDragValue(raw)
        onChange(snap(raw))
      }}
      onKeyDown={e => {
        const steps: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 }
        if (!(e.key in steps) && e.key !== 'Home' && e.key !== 'End') return
        e.preventDefault()
        onChange(e.key === 'Home' ? min : e.key === 'End' ? max : snap(value + steps[e.key] * step))
      }} />
  </div>
}
