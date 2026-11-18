import { expect, test } from 'vitest'
import { datePace } from './pace'

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
