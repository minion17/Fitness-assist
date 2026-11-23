import { expect, it } from 'vitest'
import { calculateTargets, type ProfileData } from './profile'

it('matches the server norms: 190 cm / 76 kg on a mass gain gets ~400 g of carbs, not 540', () => {
  const p: ProfileData = { sex: 'male', birth_year: new Date().getFullYear() - 28, height_cm: 190, weight_kg: 76, activity: 'moderate', goal: 'mass_gain' }
  expect(calculateTargets(p)).toEqual({ calories: 3227, protein: 152, fat: 114, carbs: 398 }) // same as backend daily_targets
  expect(calculateTargets(p, 'weight_loss')).toEqual({ calories: 2182, protein: 152, fat: 61, carbs: 257 })
  // obese: protein on the adjusted weight, not 240 g
  expect(calculateTargets({ ...p, height_cm: 175, weight_kg: 120 }, 'weight_loss').protein).toBe(175)
})
