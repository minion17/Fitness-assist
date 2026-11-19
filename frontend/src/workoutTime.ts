import type { ProgramDay } from './types'

/** A rough length of a workout day: each set's work (40 s, or the seconds asked) plus the rest between sets,
 * and a minute to set up each exercise; rounded to 5 minutes. */
export function workoutMinutes(day: ProgramDay): number {
  const sec = day.exercises.reduce((n, e) => {
    const timed = e.unit === 'seconds' || /сек/i.test(e.reps)
    const work = timed ? Number(e.reps.match(/\d+/)?.[0] ?? 30) : 40
    return n + 60 + e.sets * work + Math.max(0, e.sets - 1) * (e.rest_seconds || 60)
  }, 0)
  return Math.max(5, Math.round(sec / 300) * 5)
}
