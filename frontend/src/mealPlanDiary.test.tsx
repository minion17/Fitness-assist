import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Food from './Food'
import { api } from './telegram'
vi.mock('./telegram', () => ({ api: vi.fn(), publicGet: vi.fn(), postJson: (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) }), putJson: (body: unknown) => ({ method: 'PUT', body: JSON.stringify(body) }), ApiError: Error, tg: undefined }))
afterEach(cleanup)
test('план на день показывает блюдо и записывает его по галочке', async () => {
  const meal = { id: 'rice', name: 'Рис с курицей', meal: 'lunch', completed: false, nutrition: { kcal: 420, protein_g: 30, fat_g: 10, carbs_g: 50 } }
  const mock = vi.mocked(api)
  mock.mockImplementation(async (path) => path === '/api/meal-plan/today' ? { finished: false, day: 1, meals: [meal] } as never : null)
  const refresh = vi.fn().mockResolvedValue(undefined)
  render(<Food day={{ date: '2026-11-15', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }} canEdit onAdd={vi.fn()} onDelete={vi.fn()} onPlanLogged={refresh} />)
  const check = await screen.findByRole('checkbox', { name: 'Отметить: Рис с курицей' })
  fireEvent.click(check)
  await waitFor(() => expect(mock).toHaveBeenCalledWith('/api/meal-plan/today/0', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ completed: true }) })))
  await waitFor(() => expect(refresh).toHaveBeenCalled())
})

test('дневник открывает рецепт без записи еды и показывает весь сохранённый рацион', async () => {
  const { createMealPlan } = await import('./mealPrototype')
  const input = { days: 7, calories: 2200, allergies: '', liked: '', disliked: '' }
  const plan = createMealPlan(input)
  const meals = plan.days[0].meals.map(meal => ({ ...meal, completed: false }))
  const breakfast = meals[0]
  const mock = vi.mocked(api)
  mock.mockClear()
  mock.mockImplementation(async path => {
    if (path === '/api/meal-plan/today') return { finished: false, day: 1, meals } as never
    if (path === '/api/meal-plan') return { plan, input } as never
    return null
  })
  render(<Food day={{ date: '2026-11-15', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }} canEdit onAdd={vi.fn()} onDelete={vi.fn()} />)
  const open = await screen.findByRole('button', { name: `Открыть Завтрак — ${breakfast.name}` })
  expect(open.querySelector('img')?.getAttribute('src')).toBe(`/images/recipes/${breakfast.id}.jpg`)
  fireEvent.click(open)
  expect(screen.getByRole('dialog', { name: breakfast.name })).toBeTruthy()
  expect(screen.getByText('Как приготовить')).toBeTruthy()
  expect(screen.getByText('Ингредиенты на порцию')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть рецепт' }))
  expect(mock.mock.calls.some(([path, init]) => path.includes('/today/') || init?.method === 'PUT')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: /Весь рацион/ }))
  const lastDay = await screen.findByRole('button', { name: 'Открыть день 7' })
  expect(screen.getAllByRole('button', { name: /Открыть день/ })).toHaveLength(7)
  fireEvent.click(lastDay)
  expect(screen.getByRole('heading', { name: 'День 7' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /^Открыть Ужин/ }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть рецепт' }))
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
  expect(screen.getByRole('heading', { name: 'Питание' })).toBeTruthy()
})

test('перекус из рациона виден, даже когда перекусов ещё не было; законченный рацион предлагает следующий', async () => {
  const { createMealPlan } = await import('./mealPrototype')
  const input = { days: 3, calories: 3000, allergies: '', liked: '', disliked: '' }
  const plan = createMealPlan(input)
  const meals = plan.days[0].meals.map(meal => ({ ...meal, completed: false }))
  const snack = meals.find(m => m.meal === 'snack')!
  const mock = vi.mocked(api)
  let finished = false
  mock.mockImplementation(async path => {
    if (path === '/api/meal-plan/today') return (finished ? { finished: true, meals: [] } : { finished: false, day: 1, meals }) as never
    if (path === '/api/meal-plan') return { plan, input } as never
    return null
  })
  const day = { date: '2026-11-15', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  const view = render(<Food day={day} canEdit onAdd={vi.fn()} onDelete={vi.fn()} />)
  expect(await screen.findByRole('button', { name: `Открыть Перекус — ${snack.name}` })).toBeTruthy()
  view.unmount()
  finished = true
  render(<Food day={day} canEdit onAdd={vi.fn()} onDelete={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Составить следующий' }))
  expect(await screen.findByText(/Новый рацион с теми же настройками/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Сохранить и использовать рацион' })).toBeTruthy()
})
