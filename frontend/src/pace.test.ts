import { describe, expect, it, test } from 'vitest'
import { datePace, forecast, forecastText } from './pace'

const today = new Date('2026-11-19T12:00')
test('a target date is checked against a safe pace', () => {
  // −8 kg: 10–16 weeks
  expect(datePace(80, 72, '2027-06-01', today)?.ok).toBe(true) // 27 weeks: plenty
  expect(datePace(80, 72, '2027-02-11', today)?.text).toMatch(/без запаса/) // 12 weeks
  const short = datePace(80, 72, '2026-12-31', today)! // 6 weeks: 4,8 kg at most
  expect(short.ok).toBe(false)
  expect(short.text).toMatch(/минус 4,8 кг/)
  expect(datePace(80, 72, undefined, today)).toBeNull()
})

describe('forecast', () => {
  const today = new Date('2026-11-22T12:00')
  const pts = [{ date: '2026-11-01', kg: 80 }, { date: '2026-11-08', kg: 79.5 }, { date: '2026-11-15', kg: 79 }, { date: '2026-11-22', kg: 78.5 }]
  it('draws the trend to the target date', () => {
    const f = forecast(pts, 76, today)!
    expect(f.weekly).toBe(-0.5)
    expect(f.date).toBe('2026-12-27') // 2,5 kg at 0,5 a week: 5 weeks
    expect(forecastText(f, 76)).toBe('При текущем темпе (−0,5 кг в неделю) 76 кг будет 27 декабря')
  })
  it('says nothing when the weight moves away, stands still or there is too little data', () => {
    expect(forecast(pts, 85, today)).toBeNull()
    expect(forecast(pts.map((p) => ({ ...p, kg: 80 })), 76, today)).toBeNull()
    expect(forecast(pts.slice(-2), 76, today)).toBeNull()
  })
})
