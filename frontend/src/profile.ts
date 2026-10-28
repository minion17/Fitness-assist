export type Targets = { calories: number; protein: number; fat: number; carbs: number }
export type ProfileData = {
  sex: 'male' | 'female'
  birth_year: number
  height_cm: number
  weight_kg: number
  activity: 'low' | 'light' | 'moderate' | 'high' | 'very_high'
  goal: 'lose' | 'maintain' | 'gain'
  targets?: Targets
}

export const GOALS = { lose: 'Снижение веса', maintain: 'Поддержание формы', gain: 'Набор массы' }

export const YEAR = new Date().getFullYear()
