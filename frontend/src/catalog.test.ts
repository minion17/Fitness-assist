import { beforeEach, expect, test, vi } from 'vitest'

const p = (id: number, name: string, extra = {}) => ({ id, name, brand: null, category: null, kcal: 100, protein_g: 1, fat_g: 1, carbs_g: 1, ...extra })

beforeEach(() => { localStorage.clear(); vi.resetModules() })

test('local search: word starts, changed endings, mine first, plain before brands', async () => {
  localStorage.setItem('setly-catalog', JSON.stringify({ at: Date.now(), items: [
    p(1, 'Яйцо куриное'), p(2, 'Молоко 2.5%', { brand: 'Простоквашино' }), p(3, 'Молоко 2.5%'), p(4, 'Шоколад молочный'),
    p(5, 'Огурец свежий'), p(6, 'Гречка варёная', { mine: true }), p(7, 'Гречневая каша'),
  ] }))
  const { localSearch, eaten } = await import('./catalog')
  expect(localSearch('яйца').map((x) => x.id)).toEqual([1]) // "яйца" finds "Яйцо"
  expect(localSearch('молоко').map((x) => x.id)).toEqual([3, 2]) // not "молочный"; the plain one first
  expect(localSearch('греч').map((x) => x.id)).toEqual([6, 7]) // what I eat first
  expect(localSearch('гречка варе').map((x) => x.id)).toEqual([6]) // ё = е, all words must match
  expect(localSearch('о')).toEqual([])
  eaten(p(5, 'Огурец свежий'))
  expect(localSearch('о').length).toBe(0)
  expect(localSearch('ог')[0].id).toBe(5)
  expect(JSON.parse(localStorage.getItem('setly-catalog')!).items[0]).toMatchObject({ id: 5, mine: true })
})
