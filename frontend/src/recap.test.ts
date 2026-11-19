import { beforeEach, expect, test } from 'vitest'
import { markRecapSeen, recapDue, weekId } from './recap'

const days = [{ date: '2026-11-16', kcal: 1800, water_ml: 0, workouts: 1 }]
beforeEach(() => localStorage.clear())
test('the weekly recap opens once: Sunday evening or Monday', () => {
  expect(weekId(new Date(2026, 10, 22))).toBe(weekId(new Date(2026, 10, 16))) // Sun and Mon of one ISO week
  expect(recapDue(days, new Date(2026, 10, 22, 12))).toBe(false) // Sunday noon: too early
  expect(recapDue(days, new Date(2026, 10, 22, 19))).toBe(true)
  markRecapSeen(new Date(2026, 10, 22, 19))
  expect(recapDue(days, new Date(2026, 10, 23, 9))).toBe(false) // Monday: the same week, already seen
  expect(recapDue([], new Date(2026, 10, 30, 19))).toBe(false) // nothing logged: nothing to show
})
