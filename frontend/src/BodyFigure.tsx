// The questionnaire's body picture: our own drawing (see bodyShape.ts), morphing as the slider moves.
import { useId } from 'react'
import { figure, type Sex } from './bodyShape'

export default function BodyFigure({ sex, fat, muscle, label }: { sex: Sex; fat: number; muscle: number; label: string }) {
  const g = figure(sex, fat, muscle)
  const id = useId()
  const skin = `url(#${id}s)`
  return (
    <svg className="body-figure" viewBox="0 0 200 400" role="img" aria-label={label}>
      <defs>
        <linearGradient id={`${id}s`} x1="0" x2="1">
          <stop offset="0" stopColor="#d79f80" /><stop offset=".5" stopColor="#f2c6a6" /><stop offset="1" stopColor="#d79f80" />
        </linearGradient>
        <radialGradient id={`${id}g`}><stop offset="0" stopColor="rgba(0,0,0,.28)" /><stop offset="1" stopColor="rgba(0,0,0,0)" /></radialGradient>
      </defs>
      <ellipse cx="100" cy="390" rx="62" ry="8" fill={`url(#${id}g)`} />
      {g.arms.map((d) => <path key={d} d={d} fill={skin} />)}
      {g.legs.map((d) => <path key={d} d={d} fill={skin} />)}
      <path d={g.body} fill={skin} />
      <path d={g.shorts} fill="#2a2c33" />
      {g.lines.map((d) => <path key={d} d={d} fill="none" stroke="#b47a5d" strokeWidth="1.6" strokeLinecap="round" opacity=".55" />)}
      {sex === 'female' && <path d={g.hair} fill="#5b3d2a" />}
      <ellipse {...g.head} fill="#f2c6a6" />
      {sex === 'male' && <path d={g.hair} fill="#5b3d2a" />}
      {g.shoes.map(([x, y]) => <ellipse key={x} cx={x} cy={y} rx="11" ry="6" fill="#ececee" stroke="#c4c4c8" />)}
    </svg>
  )
}
