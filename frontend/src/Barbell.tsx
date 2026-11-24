// «Штанга дня»: the day as a bar loaded with Olympic-coloured plates — food 25 kg (red), workout 20 (blue), water 15
// (yellow), habits 10 (green). A plate fills from the bottom as its goal fills and slides onto the collar when done.
// Mirrored on both sides, like a real bar. Setly's one loud visual; everything around it stays quiet.
export type Plate = { key: string; label: string; value: number; ghost?: boolean; over?: boolean }

const KG: Record<string, { color: string; h: number; w: number }> = {
  food: { color: 'var(--plate-red)', h: 108, w: 19 },
  workout: { color: 'var(--plate-blue)', h: 98, w: 17 },
  water: { color: 'var(--plate-yellow)', h: 86, w: 15 },
  habits: { color: 'var(--plate-green)', h: 74, w: 13 },
}
const W = 300, H = 116, CY = H / 2, COLLAR = 92 // the inner collar's x on the left side
const GAP = 3

export default function Barbell({ plates, loading }: { plates: Plate[]; loading?: boolean }) {
  const side = (dir: 1 | -1) => {
    let x = dir === 1 ? W - COLLAR + 2 : COLLAR - 2 // plates go outward from the collars
    return plates.map((p) => {
      const k = KG[p.key]
      const done = p.value >= 1
      const left = dir === -1 ? x - k.w : x
      x += dir * (k.w + GAP)
      const y = CY - k.h / 2, fill = Math.max(0, Math.min(1, p.value))
      const id = `clip-${p.key}-${dir}`
      return (
        <g key={p.key + dir} className={`plate${done ? ' done' : ''}${p.ghost ? ' ghost' : ''}`} style={{ ['--dx' as string]: `${dir * 10}px` }}>
          <clipPath id={id}><rect x={left} y={y + k.h * (1 - fill)} width={k.w} height={k.h * fill} /></clipPath>
          <rect className="plate-shell" x={left} y={y} width={k.w} height={k.h} rx={4} />
          {!loading && fill > 0 && <rect className="plate-fill" x={left} y={y} width={k.w} height={k.h} rx={4}
            fill={p.over ? 'var(--warn)' : k.color} clipPath={`url(#${id})`} />}
          <rect className="plate-hub" x={left + k.w * 0.2} y={CY - 9} width={k.w * 0.6} height={18} rx={2} />
          {done && <rect className="plate-rim" x={left + 1.5} y={y + 1.5} width={k.w - 3} height={k.h - 3} rx={2} />}
        </g>
      )
    })
  }
  return (
    <svg className="barbell" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={plates.map((p) => `${p.label}: ${p.ghost ? 'не сделано' : `${Math.round(p.value * 100)}%`}`).join(', ')}>
      <rect className="bar-shaft" x={8} y={CY - 2.5} width={W - 16} height={5} rx={2.5} />
      <rect className="bar-grip" x={COLLAR + 18} y={CY - 3.5} width={W - 2 * COLLAR - 36} height={7} rx={3.5} />
      <rect className="bar-collar" x={COLLAR} y={CY - 12} width={8} height={24} rx={2} />
      <rect className="bar-collar" x={W - COLLAR - 8} y={CY - 12} width={8} height={24} rx={2} />
      {side(-1)}
      {side(1)}
    </svg>
  )
}
