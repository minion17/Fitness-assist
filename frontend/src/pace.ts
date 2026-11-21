// The pace of a weight goal: weeks at a safe rate, and whether a chosen date is realistic.

/** Weeks at a safe pace: losing 0.5–0.8 kg a week, gaining 0.25–0.5. */
export function planWeeks(weight: number, target: number): [number, number] | null {
  const diff = target - weight
  if (Math.abs(diff) < 0.5) return null
  const [fast, slow] = diff < 0 ? [0.8, 0.5] : [0.5, 0.25]
  return [Math.max(1, Math.round(Math.abs(diff) / fast)), Math.max(1, Math.round(Math.abs(diff) / slow))]
}

export const isoIn = (days: number) => new Date(Date.now() + days * 864e5).toLocaleDateString('sv-SE')
export const dateRu = (iso: string) => new Date(iso + 'T12:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })

/** Is the target date realistic at a safe pace? A sentence for the summary, or null without a date. */
export function datePace(weight: number, target: number, date: string | undefined, today = new Date()): { ok: boolean; text: string } | null {
  const weeks = planWeeks(weight, target)
  if (!date || !weeks) return null
  const left = Math.floor((new Date(date + 'T12:00').getTime() - today.getTime()) / (7 * 864e5))
  if (left >= weeks[1]) return { ok: true, text: `К ${dateRu(date)} успеваешь спокойно: нужно ${weeks[0]}–${weeks[1]} нед., до даты ${left}.` }
  if (left >= weeks[0]) return { ok: true, text: `К ${dateRu(date)} успеваешь, но без запаса — придётся держать темп каждую неделю.` }
  const fast = target < weight ? 0.8 : 0.5 // kg a week at the top of the safe pace
  const reach = Math.round(Math.max(0, left) * fast * 10) / 10
  const whole = new Date(today.getTime() + weeks[0] * 7 * 864e5).toLocaleDateString('sv-SE')
  return { ok: false, text: `К ${dateRu(date)} безопасно получится ${target < weight ? 'минус' : 'плюс'} ${reach.toLocaleString('ru-RU')} кг — уже хороший шаг. Вся цель — примерно к ${dateRu(whole)}.` }
}

