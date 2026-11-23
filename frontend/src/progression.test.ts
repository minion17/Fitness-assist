import { describe, expect, it } from 'vitest'
import { advice, nextWeight } from './progression'


describe('advice', () => {
  const sets = (w: number, r: number) => [{ weight_kg: w, reps: r, duration_seconds: null }, { weight_kg: w, reps: r, duration_seconds: null }]
  it('keeps the weight after a hard workout, even if every set hit the top', () => {
    expect(nextWeight(sets(60, 12), '8-12', 'hard')).toBeNull()
    expect(advice({ date: '', sets: sets(60, 12), effort: 'hard' }, '8-12')).toMatch(/тяжело/)
  })
  it('suggests a lighter week on a plateau', () => {
    const history = [{ weight_kg: 60, reps: 9 }, { weight_kg: 60, reps: 10 }, { weight_kg: 60, reps: 9 }]
    expect(advice({ date: '', sets: sets(60, 9), history }, '8-12')).toMatch(/облегчённую неделю: 54 кг/)
  })
  it('asks for more reps on a bodyweight exercise done to the top', () => {
    expect(advice({ date: '', sets: sets(0, 15) }, '10-15')).toMatch(/на 1–2 повтора больше/)
  })
})

describe('nextWeight', () => {
  const sets = (w: number, r: number) => [{ weight_kg: w, reps: r, duration_seconds: null }]
  it('adds ~2.5 % rounded to the step, ~5 % when it was easy', () => {
    expect(nextWeight(sets(60, 12), '8-12')).toBe(62.5)
    expect(nextWeight(sets(140, 12), '8-12')).toBe(142.5)
    expect(nextWeight(sets(100, 12), '8-12', 'easy')).toBe(105)
    expect(nextWeight(sets(12, 12), '8-12')).toBe(13)
    expect(nextWeight(sets(60, 10), '8-12')).toBeNull()
  })
})
