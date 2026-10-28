// Shapes returned by the backend API.
export type Macros = { kcal: number; protein_g: number; fat_g: number; carbs_g: number }

export type Product = Macros & { id: number; name: string; brand: string | null; category: string | null }

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack'
export const MEALS: Record<MealType, string> = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекус' }

export type FoodItem = Macros & { id: number; meal_type: MealType; amount_g: number; logged_at: string; product: Product }
export type FoodDay = { date: string; items: FoodItem[]; totals: Macros }

export type PlannedExercise = {
  exercise_id: number; name: string; sets: number; reps: string; rest_seconds: number; notes: string | null
}
export type ProgramDay = { id: number; day_name: string; day_order: number; exercises: PlannedExercise[] }
export type Program = {
  id: number; name: string; goal: string; level: string; days_per_week: number; description: string | null
  days: ProgramDay[]
}

export type WorkoutLog = {
  id: number; title: string; program_day_id: number | null; started_at: string; completed_at: string | null; sets: number
}

/** Meal that fits the current time of day — preselected when adding food. */
export function mealNow(hour = new Date().getHours()): MealType {
  if (hour < 11) return 'breakfast'
  if (hour < 16) return 'lunch'
  if (hour < 21) return 'dinner'
  return 'snack'
}

/** Next day of the program after the last completed one (wraps around). */
export function nextDay(program: Program, logs: WorkoutLog[]): ProgramDay {
  const ids = new Set(program.days.map((d) => d.id))
  const last = logs.find((l) => l.completed_at && l.program_day_id !== null && ids.has(l.program_day_id))
  if (!last) return program.days[0]
  const i = program.days.findIndex((d) => d.id === last.program_day_id)
  return program.days[(i + 1) % program.days.length]
}

export function completedThisWeek(logs: WorkoutLog[], now = Date.now()): number {
  return logs.filter((l) => l.completed_at && now - Date.parse(l.completed_at) < 7 * 864e5).length
}
