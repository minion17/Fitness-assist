// "Progressive overload": if last time every set reached the top of the planned reps, add a little weight.
import type { LastSet } from './types'

/** "8-12" -> 12, "10" -> 10, "до отказа" -> null */
export function topReps(plan: string): number | null {
  const n = plan.match(/\d+/g)
  return n ? Number(n[n.length - 1]) : null
}

/** The weight to try today, or null if it's not time to add (or the exercise has no weight). */
export function nextWeight(last: LastSet[] | undefined, plan: string): number | null {
  const top = topReps(plan)
  if (!last?.length || !top) return null
  const weight = Math.max(...last.map((s) => s.weight_kg || 0))
  if (weight <= 0 || last.some((s) => s.duration_seconds != null || (s.reps ?? 0) < top || (s.weight_kg || 0) < weight)) return null
  return Math.round((weight + (weight >= 20 ? 2.5 : 1)) * 10) / 10 // a barbell goes up by 2.5 kg, dumbbells by 1
}
