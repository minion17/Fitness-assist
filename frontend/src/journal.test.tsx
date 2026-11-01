import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import AiMeal from './AiMeal'
import AiSummary from './AiSummary'
import Body from './Body'
import Food from './Food'
import { api, ApiError, publicGet } from './telegram'
import { mealNow, nextDay, weightTrend, type FoodDay, type Measurement, type Program, type WorkoutLog } from './types'
import Workouts from './Workouts'

vi.mock('./telegram', () => {
  class ApiError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status } }
  return { api: vi.fn(), publicGet: vi.fn(), postJson: (b: unknown) => ({ method: 'POST', body: JSON.stringify(b) }), ApiError }
})
const apiMock = vi.mocked(api)
const publicGetMock = vi.mocked(publicGet)

beforeEach(() => { apiMock.mockReset(); apiMock.mockResolvedValue(null); publicGetMock.mockReset() })
afterEach(cleanup)

const program: Program = {
  id: 1, name: 'PPL', goal: 'Масса', level: 'intermediate', days_per_week: 3, description: null,
  days: [
    { id: 11, day_name: 'Push', day_order: 1, exercises: [{ exercise_id: 7, name: 'Жим лёжа', sets: 2, reps: '6-8', rest_seconds: 180, notes: null }] },
    { id: 12, day_name: 'Pull', day_order: 2, exercises: [] },
  ],
}
const log = (dayId: number, done = true): WorkoutLog =>
  ({ id: dayId, title: '', program_day_id: dayId, started_at: '2026-10-28T10:00:00Z', completed_at: done ? '2026-10-28T11:00:00Z' : null, sets: 1 })

test('helpers: next program day and meal by time', () => {
  expect(nextDay(program, []).day_name).toBe('Push')
  expect(nextDay(program, [log(11)]).day_name).toBe('Pull')
  expect(nextDay(program, [log(12)]).day_name).toBe('Push') // wraps around
  expect(nextDay(program, [log(11, false)]).day_name).toBe('Push') // unfinished doesn't count
  expect([mealNow(8), mealNow(13), mealNow(19), mealNow(23)]).toEqual(['breakfast', 'lunch', 'dinner', 'snack'])
})

test('workout session: logs sets, then completes', async () => {
  const onChanged = vi.fn()
  apiMock.mockResolvedValueOnce({ id: 99 }) // start workout
    .mockResolvedValueOnce({ id: 1 }) // set
    .mockResolvedValueOnce({ ok: true, xp_awarded: 50 }) // complete
  render(<Workouts programs={[program]} logs={[]} programId={1} onSelectProgram={() => {}} canEdit onChanged={onChanged} />)

  fireEvent.click(screen.getByRole('button', { name: 'Начать тренировку' }))
  const finish = screen.getByRole('button', { name: 'Отметьте хотя бы один подход' }) as HTMLButtonElement
  expect(finish.disabled).toBe(true)

  expect((screen.getByLabelText('Жим лёжа, подход 1, повторы') as HTMLInputElement).value).toBe('6') // from "6-8"
  fireEvent.change(screen.getByLabelText('Жим лёжа, подход 1, вес'), { target: { value: '62,5' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подход 1' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /Завершить тренировку · 1/ })).toBeTruthy())

  expect(apiMock.mock.calls[0][0]).toBe('/api/workout-logs')
  expect(JSON.parse(apiMock.mock.calls[1][1]!.body as string)).toEqual({ exercise_id: 7, set_number: 1, reps: 6, weight_kg: 62.5 })

  fireEvent.click(screen.getByRole('button', { name: /Завершить тренировку/ }))
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(50))
  expect(apiMock.mock.calls[2][0]).toBe('/api/workout-logs/99/complete')
})

test('workout session rejects bad reps without calling the API', () => {
  render(<Workouts programs={[program]} logs={[]} programId={1} onSelectProgram={() => {}} canEdit onChanged={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Начать тренировку' }))
  fireEvent.change(screen.getByLabelText('Жим лёжа, подход 1, повторы'), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подход 1' }))
  expect(screen.getByRole('alert').textContent).toBe('Повторы: целое число от 1 до 500')
  expect(apiMock).not.toHaveBeenCalled()
})

test('food: search a product and add grams to a meal', async () => {
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  apiMock.mockResolvedValue(null) // outside Telegram -> public catalog
  publicGetMock.mockResolvedValue([{ id: 5, name: 'Творог 5%', brand: null, category: null, kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3 }])
  const onAdd = vi.fn().mockResolvedValue(undefined)
  render(<Food day={empty} canEdit onAdd={onAdd} onDelete={vi.fn()} />)

  fireEvent.click(screen.getAllByRole('button', { name: '+ Добавить' })[2]) // dinner
  fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: 'тв' } })
  fireEvent.click(await screen.findByRole('button', { name: /Творог 5%/ }, { timeout: 2000 }))
  expect(publicGetMock).toHaveBeenCalledWith('/api/products/search?q=%D1%82%D0%B2')

  fireEvent.change(screen.getByDisplayValue('100'), { target: { value: '200' } })
  expect(screen.getByText(/242 ккал/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Добавить в «Ужин»' }))
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith(5, 200, 'dinner', null))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

test('food: delete asks for confirmation', async () => {
  const day: FoodDay = {
    date: '', totals: { kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3 },
    items: [{ id: 42, meal_type: 'lunch', amount_g: 100, logged_at: '', kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3,
      product: { id: 5, name: 'Творог 5%', brand: null, category: null, kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3 } }],
  }
  const onDelete = vi.fn().mockResolvedValue(undefined)
  render(<Food day={day} canEdit onAdd={vi.fn()} onDelete={onDelete} />)
  fireEvent.click(screen.getByRole('button', { name: 'Удалить Творог 5%' }))
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
  expect(onDelete).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Удалить Творог 5%' }))
  fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
  await waitFor(() => expect(onDelete).toHaveBeenCalledWith(42))
})

test('food: repeat yesterday, recent with last portion, favourite star', async () => {
  const curd = { id: 5, name: 'Творог 5%', brand: null, category: null, kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3 }
  const yesterday: FoodDay = {
    date: '2026-10-31', totals: { kcal: 242, protein_g: 34, fat_g: 10, carbs_g: 6 },
    items: [{ id: 1, meal_type: 'breakfast', amount_g: 200, logged_at: '', kcal: 242, protein_g: 34, fat_g: 10, carbs_g: 6, product: curd }],
  }
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/food-logs?day=')) return yesterday
    if (path === '/api/products/recent') return [{ ...curd, last_amount_g: 180 }]
    if (path === '/api/favorites') return []
    return { ok: true }
  })
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  const onCopy = vi.fn().mockResolvedValue(undefined)
  const onAdd = vi.fn().mockResolvedValue(undefined)
  render(<Food day={empty} canEdit onAdd={onAdd} onDelete={vi.fn()} onCopy={onCopy} />)
  fireEvent.click(await screen.findByRole('button', { name: /Как вчера · 242 ккал/ }))
  expect(onCopy).toHaveBeenCalledWith('2026-10-31', 'breakfast')
  expect(screen.getAllByRole('button', { name: /Как вчера/ })).toHaveLength(1) // only meals eaten yesterday

  fireEvent.click(screen.getAllByRole('button', { name: '+ Добавить' })[0])
  fireEvent.click(await screen.findByRole('button', { name: /Творог 5%.*180 г/ }))
  fireEvent.click(screen.getByRole('button', { name: 'В избранное' }))
  expect(screen.getByRole('button', { name: 'В избранное' }).getAttribute('aria-pressed')).toBe('true')
  expect(apiMock).toHaveBeenCalledWith('/api/favorites/5', { method: 'PUT' })
  fireEvent.click(screen.getByRole('button', { name: /Добавить в «Завтрак»/ }))
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith(5, 180, 'breakfast', null))
})

const m = (id: number, on: string, weight: number | null, waist: number | null = null): Measurement =>
  ({ id, measured_on: on, weight_kg: weight, waist_cm: waist, chest_cm: null, hips_cm: null, body_fat_pct: null })

test('weight trend over 30 days', () => {
  const today = new Date('2026-10-29T12:00:00')
  expect(weightTrend([], today)).toBeNull()
  expect(weightTrend([m(1, '2026-10-28', 78)], today)).toEqual({ latest: 78, delta: null })
  const ms = [m(3, '2026-10-28', 77.5), m(2, '2026-10-10', 79.1), m(1, '2026-09-01', 82)] // newest first
  expect(weightTrend(ms, today)).toEqual({ latest: 77.5, delta: -1.6 }) // 09-01 is older than 30 days
})

test('body: add measurement prefilled with latest values, validated', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined)
  render(<Body measurements={[m(2, '2026-10-20', 79.1), m(1, '2026-10-13', 79.6, 85)]} canEdit onSave={onSave} onDelete={vi.fn()} />)
  expect(screen.getByText('79.1')).toBeTruthy()
  expect(screen.getByText('-0.5 кг за 30 дней')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: '+ Добавить замер' }))
  const [weight, waist] = screen.getAllByRole('textbox') as HTMLInputElement[]
  expect([weight.value, waist.value]).toEqual(['79.1', '85']) // latest known value of each field
  fireEvent.change(weight, { target: { value: '500' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(screen.getByRole('alert').textContent).toBe('Вес: от 30 до 300')
  fireEvent.change(weight, { target: { value: '78,6' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ weight_kg: 78.6, waist_cm: 85, chest_cm: null, hips_cm: null, body_fat_pct: null }))
})

test('AI meal from text: edit draft, confirm sends edited items', async () => {
  const draft = { meal_type: 'lunch', note: 'Порцию плова оценил примерно', items: [
    { product_id: 3, name: 'Гречка', grams: 200, from_catalog: true, kcal_100g: 110, protein_100g: 4, fat_100g: 1, carbs_100g: 21 },
    { product_id: null, name: 'Плов домашний', grams: 300, from_catalog: false, kcal_100g: 180, protein_100g: 7, fat_100g: 9, carbs_100g: 20 },
    { product_id: null, name: 'Чай', grams: 250, from_catalog: false, kcal_100g: 1, protein_100g: 0, fat_100g: 0, carbs_100g: 0 },
  ] }
  apiMock.mockResolvedValueOnce(draft).mockResolvedValueOnce({ added: 2, xp_awarded: 10 })
  const onDone = vi.fn().mockResolvedValue(undefined)
  render(<AiMeal mode="text" onClose={() => {}} onDone={onDone} />)

  fireEvent.change(screen.getByPlaceholderText(/Например/), { target: { value: 'гречка, плов и чай' } })
  fireEvent.click(screen.getByRole('button', { name: 'Распознать' }))
  expect(await screen.findByText('Порцию плова оценил примерно')).toBeTruthy()
  expect(screen.getAllByText('оценка AI')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Обед' }).getAttribute('aria-pressed')).toBe('true') // meal type from AI

  fireEvent.change(screen.getByLabelText('Плов домашний, граммы'), { target: { value: '250' } })
  fireEvent.click(screen.getByRole('button', { name: 'Убрать Чай' }))
  expect(screen.getByText(/Итого ≈ 670 ккал/)).toBeTruthy() // 220 + 450
  fireEvent.click(screen.getByRole('button', { name: 'Ужин' }))
  fireEvent.click(screen.getByRole('button', { name: 'Добавить в «Ужин»' }))

  await waitFor(() => expect(onDone).toHaveBeenCalledWith(10))
  const [url, init] = apiMock.mock.calls[1]
  expect(url).toBe('/api/ai/meal/confirm')
  const body = JSON.parse(init!.body as string)
  expect(body.meal_type).toBe('dinner')
  expect(body.items.map((i: { name: string; grams: number }) => [i.name, i.grams])).toEqual([['Гречка', 200], ['Плов домашний', 250]])
})

test('AI errors are shown in plain words', async () => {
  apiMock.mockRejectedValueOnce(new ApiError(429, 'Лимит AI-запросов на сегодня исчерпан (30). Завтра снова можно.'))
  render(<AiSummary />)
  fireEvent.click(screen.getByRole('button', { name: 'Получить итог дня' }))
  expect((await screen.findByRole('alert')).textContent).toMatch('Лимит AI-запросов')

  apiMock.mockResolvedValueOnce({ text: 'Сегодня 1650 ккал из 2354.\nСовет: добавьте белка на ужин.', created_at: '', cached: false })
  fireEvent.click(screen.getByRole('button', { name: 'Получить итог дня' }))
  expect(await screen.findByText(/Совет: добавьте белка/)).toBeTruthy()
  expect(apiMock.mock.calls[1][0]).toBe('/api/ai/summary?period=day')
  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))
  await waitFor(() => expect(apiMock.mock.calls[2]?.[0]).toBe('/api/ai/summary?period=day&refresh=true'))
})

test('food: custom product form validates and returns the new product', async () => {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/products/recent' || path === '/api/favorites') return []
    if (path === '/api/products') return { id: 77, name: 'Сырник домашний', brand: null, category: 'Мои продукты', kcal: 220, protein_g: 15, fat_g: 9, carbs_g: 20 }
    return null
  })
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  render(<Food day={empty} canEdit onAdd={vi.fn()} onDelete={vi.fn()} />)
  fireEvent.click(screen.getAllByRole('button', { name: '+ Добавить' })[0])
  fireEvent.click(await screen.findByRole('button', { name: '+ Свой продукт' }))
  const [name, kcal, p, f, c] = screen.getAllByRole('textbox')
  fireEvent.change(name, { target: { value: 'Сырник домашний' } })
  fireEvent.change(kcal, { target: { value: '220' } })
  fireEvent.change(p, { target: { value: '60' } }); fireEvent.change(f, { target: { value: '30' } }); fireEvent.change(c, { target: { value: '20' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить продукт' }))
  expect(screen.getByRole('alert').textContent).toBe('Белков, жиров и углеводов вместе не больше 100 г')
  fireEvent.change(p, { target: { value: '15' } }); fireEvent.change(f, { target: { value: '9,0' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить продукт' }))
  expect(await screen.findByRole('button', { name: /Добавить в «Завтрак»/ })).toBeTruthy()
  expect(apiMock).toHaveBeenCalledWith('/api/products', expect.objectContaining({ body: JSON.stringify({ name: 'Сырник домашний', kcal: 220, protein_g: 15, fat_g: 9, carbs_g: 20 }) }))
})

test('food: each snack is its own card in time order; adding to a snack keeps its time', async () => {
  const curd = { id: 5, name: 'Творог 5%', brand: null, category: null, kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3 }
  const item = (id: number, meal: FoodDay['items'][number]['meal_type'], slot: string | null, kcal: number) =>
    ({ id, meal_type: meal, snack_slot: slot, amount_g: 100, logged_at: '', kcal, protein_g: 1, fat_g: 1, carbs_g: 1, product: { ...curd, name: `П${id}` } })
  const day: FoodDay = { date: '', totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
    items: [item(1, 'lunch', null, 400), item(2, 'snack', '16:40', 150), item(3, 'snack', '11:30', 120), item(4, 'snack', '11:30', 60)] }
  apiMock.mockImplementation(async (path: string) => (path === '/api/products/recent' ? [{ ...curd, last_amount_g: 50 }] : path === '/api/favorites' ? [] : null))
  const onAdd = vi.fn().mockResolvedValue(undefined)
  render(<Food day={day} canEdit onAdd={onAdd} onDelete={vi.fn()} />)
  const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
  expect(titles).toEqual(['КБЖУ за сегодня', 'Завтрак', 'Перекус 11:30', 'Обед', 'Перекус 16:40', 'Ужин'])
  expect(screen.getByText('180 ккал')).toBeTruthy() // 11:30 snack total
  fireEvent.click(screen.getAllByRole('button', { name: '+ Добавить' })[1]) // into the 11:30 snack
  fireEvent.click(await screen.findByRole('button', { name: /Творог 5%/ }))
  fireEvent.click(screen.getByRole('button', { name: /Добавить в «Перекус»/ }))
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith(5, 50, 'snack', '11:30'))
  expect(screen.getByRole('button', { name: '+ Перекус' })).toBeTruthy()
})

test('reminders: toggles and times are saved', async () => {
  const saved: unknown[] = []
  apiMock.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { saved.push(JSON.parse(String(init.body))); return null }
    return { meals: true, water: true, streak: true, breakfast_at: '10:00', lunch_at: '14:00', dinner_at: '20:00', streak_at: '21:00' }
  })
  const { default: Reminders } = await import('./Reminders')
  render(<Reminders />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Напоминать о воде' }))
  expect(screen.getByRole('switch', { name: 'Напоминать о воде' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.change(screen.getByLabelText('Обед, время'), { target: { value: '13:30' } })
  fireEvent.click(screen.getByRole('switch', { name: 'Напоминать о приёмах пищи' }))
  expect(screen.queryByLabelText('Обед, время')).toBeNull() // times hide when meals are off
  await waitFor(() => expect(saved).toHaveLength(3))
  expect(saved[2]).toMatchObject({ meals: false, water: false, lunch_at: '13:30' })
})

test('home water: portions, custom volume and undo of the last one', async () => {
  const { default: Home } = await import('./Home')
  const onWater = vi.fn()
  const day: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  render(<Home name="Егор" level={1} streak={0} day={day} logs={[]} water={{ ml: 500, goal_ml: 2500 }} week={[]}
    aiEnabled={false} canEdit onFood={vi.fn()} onWorkouts={vi.fn()} onWater={onWater} summary={null} />)
  fireEvent.click(screen.getByRole('button', { name: 'Добавить 330 мл' }))
  fireEvent.click(screen.getByRole('button', { name: 'Свой объём' }))
  fireEvent.change(screen.getByLabelText('Объём, мл'), { target: { value: '5000' } })
  expect((screen.getByRole('button', { name: 'Добавить' }) as HTMLButtonElement).disabled).toBe(true) // over 1000 ml
  fireEvent.change(screen.getByLabelText('Объём, мл'), { target: { value: '400' } })
  fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Убрать последние 400 мл' }))
  fireEvent.click(screen.getByRole('button', { name: 'Убрать последние 330 мл' }))
  expect(onWater.mock.calls.map((c) => c[0])).toEqual([330, 400, -400, -330])
})
