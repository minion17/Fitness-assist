// The pace of a weight goal: weeks at a safe rate, and whether a chosen date is realistic.

/** % of body weight a week at the top of the safe pace: losing up to 1 % keeps muscle (Helms 2014),
 * gaining more than 0.5 % adds mostly fat (Iraki 2019, Helms 2023). */
const topRate = (weight: number, target: number) => weight * (target < weight ? 0.01 : 0.005)

/** Weeks at a safe pace: losing 0.5–1 % of body weight a week, gaining 0.25–0.5 %. */
export function planWeeks(weight: number, target: number): [number, number] | null {
  const diff = target - weight
  if (Math.abs(diff) < 0.5) return null
  const fast = topRate(weight, target), slow = fast / 2
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
  const reach = Math.round(Math.max(0, left) * topRate(weight, target) * 10) / 10
  const whole = new Date(today.getTime() + weeks[0] * 7 * 864e5).toLocaleDateString('sv-SE')
  return { ok: false, text: `К ${dateRu(date)} безопасно получится ${target < weight ? 'минус' : 'плюс'} ${reach.toLocaleString('ru-RU')} кг — уже хороший шаг. Вся цель — примерно к ${dateRu(whole)}.` }
}


/** "При текущем темпе 70 кг будет 14 марта": a straight line through the last 4 weeks of weigh-ins.
 * Null with too few points (3+ over 10+ days), when the weight stands still or moves away from the target. */
export function forecast(points: { date: string; kg: number }[], target: number | null | undefined, today = new Date()): { date: string; weekly: number } | null {
  if (!target) return null
  const since = new Date(today.getTime() - 28 * 864e5).toLocaleDateString('sv-SE')
  const p = points.filter((x) => x.date >= since).map((x) => ({ t: new Date(x.date + 'T12:00').getTime() / 864e5, kg: x.kg }))
  if (p.length < 3 || p[p.length - 1].t - p[0].t < 10) return null
  const mt = p.reduce((a, x) => a + x.t, 0) / p.length
  const mk = p.reduce((a, x) => a + x.kg, 0) / p.length
  const slope = p.reduce((a, x) => a + (x.t - mt) * (x.kg - mk), 0) / p.reduce((a, x) => a + (x.t - mt) ** 2, 0) // kg a day
  const now = mk + slope * (today.getTime() / 864e5 - mt)
  const days = (target - now) / slope
  if (Math.abs(slope) < 0.01 || !(days > 0) || days > 730) return null
  return { date: new Date(today.getTime() + days * 864e5).toLocaleDateString('sv-SE'), weekly: Math.round(slope * 7 * 10) / 10 }
}

export function forecastText(f: { date: string; weekly: number }, target: number): string {
  const w = `${f.weekly > 0 ? '+' : '−'}${Math.abs(f.weekly).toLocaleString('ru-RU')} кг в неделю`
  return `При текущем темпе (${w}) ${target.toLocaleString('ru-RU')} кг будет ${dateRu(f.date)}`
}
