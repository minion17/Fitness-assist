// When the weekly recap (WeekRecap.tsx) opens by itself: once a week, Sunday evening or Monday.
import type { WeekDay } from './Home'

const KEY = 'setly-recap-seen'

/** The ISO week of a date, e.g. "2026-47": the recap shows once per week. */
export function weekId(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y = t.getUTCFullYear()
  return `${y}-${Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7)}`
}

/** Sunday from 18:00 or any time on Monday, if this week's recap wasn't seen and there is something to show. */
export function recapDue(days: WeekDay[], now = new Date()): boolean {
  const sundayEvening = now.getDay() === 0 && now.getHours() >= 18
  if (!(sundayEvening || now.getDay() === 1) || !days.some((d) => d.kcal > 0 || d.workouts > 0)) return false
  // on Monday it's last week's recap
  const of = now.getDay() === 1 ? new Date(now.getTime() - 864e5) : now
  try { return localStorage.getItem(KEY) !== weekId(of) } catch { return false }
}

export function markRecapSeen(now = new Date()) {
  const of = now.getDay() === 1 ? new Date(now.getTime() - 864e5) : now
  try { localStorage.setItem(KEY, weekId(of)) } catch { /* private mode */ }
}
