// Прогресс data: fetched in the background after startup and kept on the phone, so the tab opens with numbers.
import { cache, cached } from './snapshot'
import { api } from './telegram'

export type Day = { date: string; kcal: number; protein: number; fat: number; carbs: number; water_ml: number; workouts: number }
export type Stats = {
  days: Day[]
  goal: { calories: number; protein: number; fat: number; carbs: number; water_ml: number } | null
  weight: { date: string; kg: number }[]
  exercises: { id: number; name: string; points: { date: string; kg: number; reps: number }[] }[]
}

export const cachedStats = (days: number) => cached<Stats>(`stats${days}`)

export async function loadStats(days: number): Promise<Stats | null> {
  const s = await api<Stats>(`/api/stats?days=${days}`)
  if (s) cache(`stats${days}`, s)
  return s
}

export function prefetchStats(): void {
  loadStats(30).catch(() => {})  // the default period of the tab
}
