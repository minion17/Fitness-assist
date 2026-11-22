import { expect, test } from 'vitest'
import { fitLabel } from './MenuImport'

test('a dish is tagged by how it fits the calories left', () => {
  const d = { name: 'Паста', kcal: 150, protein_g: 6, fat_g: 5, carbs_g: 20, portion_g: 300, portion_name: 'порция' } // 450 kcal
  expect(fitLabel(d, 1000)?.text).toBe('влезает')
  expect(fitLabel(d, 500)?.text).toBe('почти весь остаток')
  expect(fitLabel(d, 300)?.text).toBe('больше остатка')
  expect(fitLabel({ ...d, portion_g: null }, 1000)).toBeNull()
})
