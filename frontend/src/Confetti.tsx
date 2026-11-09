// A short burst of confetti over the screen for small wins (water goal, calories in the norm, a weekly task).
import { useState } from 'react'
import { animate } from './motion'

const COLORS = ['var(--accent)', 'var(--water)', 'var(--protein)', 'var(--fat)', 'var(--carbs)', 'var(--streak)']

export default function Confetti() {
  const [pieces] = useState(() => Array.from({ length: 36 }, (_, i) => ({
    left: Math.random() * 100, delay: Math.random() * 0.25, drift: (Math.random() - 0.5) * 140,
    spin: (Math.random() - 0.5) * 900, color: COLORS[i % COLORS.length], round: i % 3 === 0,
  })))
  if (!animate()) return null
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <i key={i} className={p.round ? 'round' : ''} style={{
          left: `${p.left}%`, background: p.color, animationDelay: `${p.delay}s`,
          '--drift': `${p.drift}px`, '--spin': `${p.spin}deg`,
        } as React.CSSProperties} />
      ))}
    </div>
  )
}
