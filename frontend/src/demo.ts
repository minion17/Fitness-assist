// Demo data shown outside Telegram (no account), so the UI can be previewed in a browser.
import type { FoodDay, Measurement, Program } from './types'

const p = (id: number, name: string, kcal: number, protein_g: number, fat_g: number, carbs_g: number) =>
  ({ id, name, brand: null, category: null, kcal, protein_g, fat_g, carbs_g })

export const demoFoodDay: FoodDay = {
  date: '',
  items: [
    { id: 1, meal_type: 'breakfast', amount_g: 250, logged_at: '', product: p(1, 'Овсянка на молоке', 102, 3.2, 3.6, 14.2), kcal: 255, protein_g: 8, fat_g: 9, carbs_g: 35.5 },
    { id: 2, meal_type: 'lunch', amount_g: 150, logged_at: '', product: p(2, 'Куриная грудка', 165, 31, 3.6, 0), kcal: 248, protein_g: 46.5, fat_g: 5.4, carbs_g: 0 },
    { id: 3, meal_type: 'lunch', amount_g: 200, logged_at: '', product: p(3, 'Рис отварной', 130, 2.7, 0.3, 28), kcal: 260, protein_g: 5.4, fat_g: 0.6, carbs_g: 56 },
  ],
  totals: { kcal: 763, protein_g: 59.9, fat_g: 15, carbs_g: 91.5 },
}

export const demoPrograms: Program[] = [{
  id: -1, name: 'Full Body для новичков', goal: 'ОФП', level: 'beginner', days_per_week: 3, description: null,
  days: [{
    id: -1, day_name: 'День 1: Все тело', day_order: 1, exercises: [
      { exercise_id: -1, name: 'Приседания со штангой', sets: 3, reps: '8-10', rest_seconds: 120, notes: null },
      { exercise_id: -2, name: 'Жим штанги лежа', sets: 3, reps: '8-10', rest_seconds: 120, notes: null },
      { exercise_id: -3, name: 'Планка', sets: 3, reps: '45-60 сек', rest_seconds: 60, notes: null },
    ],
  }],
}]

export const demoMeasurements: Measurement[] = [
  { id: 3, measured_on: '2026-10-27', weight_kg: 78.4, waist_cm: 84, chest_cm: 101, hips_cm: 97, body_fat_pct: 17 },
  { id: 2, measured_on: '2026-10-20', weight_kg: 79.1, waist_cm: 85, chest_cm: null, hips_cm: null, body_fat_pct: null },
  { id: 1, measured_on: '2026-10-13', weight_kg: 79.6, waist_cm: null, chest_cm: null, hips_cm: null, body_fat_pct: null },
]

export const profile = { age: 27, height: 182, weight: 78.4, goal: 'Снижение веса' }
