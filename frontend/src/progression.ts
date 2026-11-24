// "Progressive overload": if last time every set reached the top of the planned reps, add a little weight.
import type { Effort, Last, LastSet } from './types'

/** "8-12" -> 12, "10" -> 10, "до отказа" -> null */
export function topReps(plan: string): number | null {
  const n = plan.match(/\d+/g)
  return n ? Number(n[n.length - 1]) : null
}

/** The weight to try today, or null if it's not time to add (or the exercise has no weight). */
export function nextWeight(last: LastSet[] | undefined, plan: string, effort?: Effort | null): number | null {
  const top = topReps(plan)
  if (!last?.length || !top || effort === 'hard') return null // it was hard: keep the weight one more time
  const weight = Math.max(...last.map((s) => s.weight_kg || 0))
  if (weight <= 0 || last.some((s) => s.duration_seconds != null || (s.reps ?? 0) < top || (s.weight_kg || 0) < weight)) return null
  // +2–10 % when the top reps are reached (ACSM): ~2.5 %, ~5 % if it was easy, rounded to the plate / dumbbell step
  const step = weight >= 20 ? 2.5 : 1
  const add = Math.max(step, Math.round((weight * (effort === 'easy' ? 0.05 : 0.025)) / step) * step)
  return Math.round((weight + add) * 10) / 10
}

/** One line of coaching for today's exercise beyond "+2,5 кг": a hard last time, a plateau, or more reps
 * for an exercise without weight. Null when there's nothing to say (nextWeight speaks for itself). */
export function advice(entry: Last[string] | undefined, plan: string): string | null {
  if (!entry?.sets.length) return null
  const top = topReps(plan)
  const weight = Math.max(...entry.sets.map((s) => s.weight_kg || 0))
  if (entry.effort === 'hard') return 'В прошлый раз было тяжело. Держим вес, добираем повторы.'
  const h = entry.history ?? []
  if (weight > 0 && h.length >= 3 && h[0].weight_kg <= h[2].weight_kg && (!top || h[0].reps < top)) {
    const light = Math.round(weight * 0.9 * 2) / 2
    return `Вес стоит три тренировки. Сделай лёгкую неделю: ${String(light).replace('.', ',')} кг, потом вернёмся с новыми силами.`
  }
  if (weight === 0 && top && entry.sets.every((s) => s.duration_seconds == null && (s.reps ?? 0) >= top))
    return `Все подходы были по ${top} — сегодня попробуй на 1–2 повтора больше.`
  if (entry.effort === 'easy' && weight > 0 && !nextWeight(entry.sets, plan)) return 'В прошлый раз было легко. Добавь по повтору в каждом подходе.'
  return null
}
