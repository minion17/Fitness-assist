// Body map, front and back: main muscles bright, helpers pale; a tap on a zone picks that muscle (the library filter).
import { useId } from 'react'
import { figure } from './bodyShape'
import { MUSCLES, ZONES, type Muscle } from './muscles'

const BASE = figure('male', 0.15, 0.55)

export default function MuscleMap({ primary = [], secondary = [], heat, onPick, compact = false }: {
  primary?: string[]
  secondary?: string[]
  heat?: Partial<Record<string, number>> // 0..1 per muscle: the week's load
  onPick?: (m: Muscle) => void
  compact?: boolean
}) {
  const id = useId()
  const fill = (m: Muscle) => {
    if (heat) {
      const v = heat[m] ?? 0
      return v > 0 ? (v < 0.4 ? '#4cc78a' : v < 0.8 ? '#e4b94d' : '#ed6354') : undefined
    }
    return primary.includes(m) ? '#ed6354' : secondary.includes(m) ? '#e4b94d' : undefined
  }
  const label = heat ? 'Нагрузка на мышцы за неделю'
    : `Мышцы: ${[...primary, ...secondary].map((m) => MUSCLES[m as Muscle] ?? m).join(', ') || 'не указаны'}`
  const view = (side: 'front' | 'back') => (
    <svg viewBox="0 0 200 400" className="muscle-view" aria-hidden={!onPick}>
      <g className="muscle-base">
        {BASE.arms.map((d) => <path key={d} d={d} />)}
        {BASE.legs.map((d) => <path key={d} d={d} />)}
        <path d={BASE.body} />
        <ellipse {...BASE.head} />
      </g>
      {(Object.entries(ZONES[side]) as [Muscle, string[]][]).map(([m, paths]) => (
        <g key={m} className={onPick ? 'muscle-zone pick' : 'muscle-zone'} style={{ fill: fill(m) }}
          onClick={onPick ? () => onPick(m) : undefined} role={onPick ? 'button' : undefined} aria-label={onPick ? MUSCLES[m] : undefined}>
          {paths.map((d) => <path key={d} d={d} />)}
        </g>
      ))}
      <text x="100" y="398" textAnchor="middle" className="muscle-side">{side === 'front' ? 'спереди' : 'сзади'}</text>
    </svg>
  )
  return (
    <div className={compact ? 'muscle-map-wrap compact' : 'muscle-map-wrap'}>
      <div className={compact ? 'muscle-map compact' : 'muscle-map'} role={onPick ? 'group' : 'img'} aria-label={label} id={id}>
        {view('front')}{view('back')}
      </div>
      {heat && <div className="muscle-scale" aria-label="Относительное количество подходов за неделю">
        <div className="muscle-scale-bar"><i /><i /><i /></div>
        <div className="muscle-scale-labels"><span>Меньше</span><span>Больше</span></div>
      </div>}
      {!heat && !onPick && <div className="muscle-key"><span><i className="muscle-dot main" />Основные</span>{secondary.length > 0 && <span><i className="muscle-dot assist" />Дополнительные</span>}</div>}
    </div>
  )
}
