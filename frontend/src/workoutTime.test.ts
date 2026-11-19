import { expect, test } from 'vitest'
import { workoutMinutes } from './workoutTime'

const ex = (sets: number, reps: string, rest: number) => ({ exercise_id: 1, name: 'x', sets, reps, rest_seconds: rest, notes: null })
test('a workout length from sets and rests', () => {
  // 4 exercises × (60 s setup + 3 × 40 s work + 2 × 90 s rest) = 1 440 s ≈ 25 min
  expect(workoutMinutes({ id: 1, day_name: 'A', day_order: 1, exercises: Array.from({ length: 4 }, () => ex(3, '8-10', 90)) })).toBe(25)
  // a plank: the seconds asked count as work
  expect(workoutMinutes({ id: 1, day_name: 'B', day_order: 1, exercises: [ex(3, '60 сек', 60)] })).toBe(5)
})
