export type Targets = { calories: number; protein: number; fat: number; carbs: number }

export type Goal = 'weight_loss' | 'fat_loss' | 'maintenance' | 'muscle_gain' | 'mass_gain'
export type ProfileData = {
  sex: 'male' | 'female'
  birth_year: number
  height_cm: number
  weight_kg: number
  activity: 'low' | 'light' | 'moderate' | 'high' | 'very_high'
  goal: Goal
  // extended questionnaire (null for profiles saved before it)
  experience?: 'beginner' | 'intermediate' | 'advanced' | null
  equipment?: string[] | null
  sessions_per_week?: number | null
  session_minutes?: number | null
  allergies?: string[] | null
  meals_per_day?: number | null
  sleep_hours?: number | null
  stress?: 'low' | 'moderate' | 'high' | null
  injury?: 'knees' | 'back' | 'shoulders' | 'other' | null
  // body and fitness check (newer questionnaire)
  body_now?: number | null
  body_target?: number | null
  squats?: 'lt15' | '15_30' | 'gt30' | 'unknown' | null
  pushups?: 'lt10' | '10_20' | 'gt20' | 'unknown' | null
  pullups?: 'none' | '1_5' | '6_10' | 'gt10' | 'unknown' | null
  place?: 'home' | 'gym' | 'outdoor' | null
  focus?: string[] | null
  target_weight_kg?: number | null
  training_days?: number[] | null // weekdays, 0 = Mon
  target_date?: string | null // ISO date, optional
  targets?: Targets
}

export type Recommendation = { program_id: number; score: number; reasons: string[] }

export const GOALS: Record<Goal, string> = {
  weight_loss: 'Снижение веса',
  fat_loss: 'Снижение % жира',
  maintenance: 'Поддержание формы',
  muscle_gain: 'Набор мышц',
  mass_gain: 'Набор массы',
}

export const YEAR = new Date().getFullYear()

// Matches the server's daily_targets (backend/core/nutrition.py) for an offline profile: the goal is a weekly rate of
// weight change (% of body weight), protein on a reference weight, fat 25 % of energy, carbs capped near 5 g/kg.
const WEEKLY_RATE = { weight_loss: -0.75, fat_loss: -0.5, maintenance: 0, muscle_gain: 0.25, mass_gain: 0.5 }
const MAX_SHIFT = { weight_loss: 0.25, fat_loss: 0.2, maintenance: 0, muscle_gain: 0.1, mass_gain: 0.15 }
const PROTEIN_PER_KG = { weight_loss: 2, fat_loss: 2.2, maintenance: 1.6, muscle_gain: 2, mass_gain: 2 }

export function calculateTargets(profile: ProfileData, goal: Goal = profile.goal): Targets {
  const activity = { low: 1.2, light: 1.375, moderate: 1.55, high: 1.725, very_high: 1.9 }
  const age = new Date().getFullYear() - profile.birth_year
  const w = profile.weight_kg
  const bmr = 10 * w + 6.25 * profile.height_cm - 5 * age + (profile.sex === 'male' ? 5 : -161)
  const expenditure = Math.round(bmr * activity[profile.activity])
  const cap = expenditure * MAX_SHIFT[goal]
  const shift = Math.max(-cap, Math.min(cap, (w * WEEKLY_RATE[goal]) / 100 * 7700 / 7))
  const calories = Math.max(Math.round(expenditure + shift), profile.sex === 'male' ? 1500 : 1200)
  const lean = 25 * (profile.height_cm / 100) ** 2
  const ref = w <= lean ? w : lean + 0.25 * (w - lean)
  const protein = Math.round(ref * PROTEIN_PER_KG[goal])
  let fat = Math.max(0.8 * ref, (0.25 * calories) / 9)
  let carbs = (calories - protein * 4 - fat * 9) / 4
  if (carbs > 5 * ref) {
    fat += Math.min(Math.max(0, Math.min((0.35 * calories) / 9, 1.5 * ref) - fat), ((carbs - 5 * ref) * 4) / 9)
    carbs = (calories - protein * 4 - fat * 9) / 4
  }
  return { calories, protein, fat: Math.round(fat), carbs: Math.max(0, Math.round(carbs)) }
}
