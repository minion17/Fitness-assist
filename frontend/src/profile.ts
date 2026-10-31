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
