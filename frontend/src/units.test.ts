import { expect, test } from 'vitest'
import { applyWanted, parseQuery } from './units'

const p = (extra = {}) => ({ id: 1, name: 'Банан', brand: null, category: null, kcal: 96, protein_g: 1.5, fat_g: 0.2, carbs_g: 21, ...extra })

test('half: «полбанана», «пол банана», «полстакана молока»; real words stay words', () => {
  expect(parseQuery('полбанана')).toEqual({ text: 'банана', wanted: { qty: 0.5, unit: null } })
  expect(parseQuery('пол-яблока')).toEqual({ text: 'яблока', wanted: { qty: 0.5, unit: null } })
  expect(parseQuery('полстакана молока')).toEqual({ text: 'молока', wanted: { qty: 0.5, unit: 'стакана' } })
  expect(parseQuery('полкило гречки')).toEqual({ text: 'гречки', wanted: { qty: 0.5, unit: 'кило' } })
  for (const w of ['полента', 'полезный завтрак', 'полуфабрикат', 'полба']) expect(parseQuery(w).wanted).toBeNull()
  expect(parseQuery('банан 2')).toEqual({ text: 'банан', wanted: { qty: 2, unit: null } })
})

test('half a piece opens as 0,5 шт; half a kilo as 500 g', () => {
  expect(applyWanted(p({ piece_g: 120, piece_name: 'шт' }), { qty: 0.5, unit: null })).toMatchObject({ qty: 0.5, unit: { label: 'шт' } })
  expect(applyWanted(p(), { qty: 0.5, unit: 'кило' })).toMatchObject({ qty: 500, unit: { label: 'г' } })
})
