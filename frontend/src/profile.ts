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

// Matches the server's daily_targets calculation for an offline profile.
export function calculateTargets(profile: ProfileData, goal: Goal = profile.goal): Targets {
  const activity = { low: 1.2, light: 1.375, moderate: 1.55, high: 1.725, very_high: 1.9 }
  const factors = { weight_loss: .8, fat_loss: .85, maintenance: 1, muscle_gain: 1.15, mass_gain: 1.2 }
  const proteinPerKg = { weight_loss: 2, fat_loss: 2, maintenance: 1.6, muscle_gain: 2, mass_gain: 2 }
  const age = new Date().getFullYear() - profile.birth_year
  const bmr = 10 * profile.weight_kg + 6.25 * profile.height_cm - 5 * age + (profile.sex === 'male' ? 5 : -161)
  const calories = Math.max(Math.round(bmr * activity[profile.activity] * factors[goal]), profile.sex === 'male' ? 1500 : 1200)
  const protein = Math.round(profile.weight_kg * proteinPerKg[goal])
  const fat = Math.round(profile.weight_kg * .9)
  return { calories, protein, fat, carbs: Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4)) }
}
