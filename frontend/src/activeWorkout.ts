// The workout in progress, kept on the phone: leave it to log food and come back to the same set, timer and records.
// Saved sets are on the server already; this keeps what is only on screen (inputs, current exercise, rest).
export type ActiveWorkout = {
  programId: number; dayId: number; title: string; logId: number | null; startedAt: number; cur: number
  sets: { reps: string; weight: string; saved: boolean; id?: number }[][]
  records: string[]; rest: { until: number; total: number; next: string } | null
  restClock?: { end: number; result: string; ei: number; si: number } | null // the «Отдых» clock over the set table
}

const KEY = 'setly-active-workout'
const STALE = 6 * 3600 * 1000 // a workout left open for hours is over

export function loadActive(): ActiveWorkout | null {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ActiveWorkout | null
    return a && Date.now() - a.startedAt < STALE ? a : null
  } catch { return null }
}

export function saveActive(a: ActiveWorkout | null) {
  try { if (a) localStorage.setItem(KEY, JSON.stringify(a)); else localStorage.removeItem(KEY) } catch { /* private mode */ }
  window.dispatchEvent(new Event(KEY))
}

export const ACTIVE_EVENT = KEY
