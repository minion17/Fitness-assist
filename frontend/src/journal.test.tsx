import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ProfileData } from './profile'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import AiMeal from './AiMeal'
import AiSummary from './AiSummary'
import Body from './Body'
import Food from './Food'
import { api, ApiError, publicGet } from './telegram'
import { lastLabel, mealNow, nextDay, weightTrend, type FoodDay, type Measurement, type Program, type WorkoutLog } from './types'
import Workouts from './Workouts'
import Friends from './Friends'
import Quests from './Quests'
import Habits, { type Habit } from './Habits'
import Consent, { PrivacyCard } from './Consent'

vi.mock('./telegram', () => {
  class ApiError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status } }
  return { api: vi.fn(), publicGet: vi.fn(), postJson: (b: unknown) => ({ method: 'POST', body: JSON.stringify(b) }), ApiError, tg: undefined, tgUser: undefined }
})
const apiMock = vi.mocked(api)
const publicGetMock = vi.mocked(publicGet)

beforeEach(() => { apiMock.mockReset(); apiMock.mockResolvedValue(null); publicGetMock.mockReset(); localStorage.removeItem('setly-active-workout') }) // a workout from the previous test isn't resumed
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
  apiMock.mockImplementation(async (url: string) =>
    url.startsWith('/api/exercises/last') ? {} // last time: nothing yet
      : url === '/api/workout-logs' ? { id: 99 } : url.endsWith('/sets') ? { id: 1, record: null }
      : url.endsWith('/complete') ? { ok: true, xp_awarded: 50 } : { ok: true }) // rest timer
  render(<Workouts programs={[program]} logs={[]} programId={1} onSelectProgram={() => {}} canEdit onChanged={onChanged} />)

  fireEvent.click(screen.getByRole('button', { name: 'Начать тренировку' }))
  expect(screen.queryByRole('button', { name: /Завершить тренировку/ })).toBeNull()

  expect((screen.getByLabelText('Жим лёжа, подход 1, повторы') as HTMLInputElement).value).toBe('6') // from "6-8"
  fireEvent.change(screen.getByLabelText('Жим лёжа, подход 1, вес'), { target: { value: '62,5' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подход 1' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /Завершить тренировку · 1/ })).toBeTruthy())

  expect(apiMock.mock.calls[0][0]).toBe('/api/exercises/last?ids=7')
  expect(apiMock.mock.calls[1][0]).toBe('/api/workout-logs')
  expect(JSON.parse(apiMock.mock.calls[2][1]!.body as string)).toEqual({ exercise_id: 7, set_number: 1, reps: 6, weight_kg: 62.5 })

  // a set saved by mistake comes back to the inputs
  fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: /Завершить тренировку/ })).toBeNull())
  expect(apiMock.mock.calls.map((c) => c[0])).toContain('/api/workout-logs/99/sets/1')
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подход 1' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /Завершить тренировку · 1/ })).toBeTruthy())

  fireEvent.click(screen.getByRole('button', { name: /Завершить тренировку/ }))
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(50))
  expect(apiMock.mock.calls.map((c) => c[0])).toContain('/api/workout-logs/99/complete')
  // the summary: sets and kilograms lifted (6 × 62,5)
  expect(await screen.findByText('Тренировка завершена')).toBeTruthy()
  expect(screen.getByText('375')).toBeTruthy()
})

test('a workout left to log food comes back with its saved set', async () => {
  apiMock.mockImplementation(async (url: string) =>
    url.startsWith('/api/exercises/last') ? {} : url === '/api/workout-logs' ? { id: 99 } : url.endsWith('/sets') ? { id: 1, record: null } : { ok: true })
  const onMinimize = vi.fn()
  const { unmount } = render(<Workouts programs={[program]} logs={[]} programId={1} onSelectProgram={() => {}} canEdit onChanged={() => {}} onMinimize={onMinimize} />)
  fireEvent.click(screen.getByRole('button', { name: 'Начать тренировку' }))
  fireEvent.change(screen.getByLabelText('Жим лёжа, подход 1, вес'), { target: { value: '60' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подход 1' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /Завершить тренировку · 1/ })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: /Свернуть тренировку/ }))
  expect(onMinimize).toHaveBeenCalled()
  unmount() // the tab changes

  render(<Workouts programs={[program]} logs={[]} programId={1} onSelectProgram={() => {}} canEdit onChanged={() => {}} />)
  expect(screen.getByRole('button', { name: /Завершить тренировку · 1/ })).toBeTruthy() // the same workout, the set kept
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' }))
  expect(localStorage.getItem('setly-active-workout')).toBeNull()
})

test('workout session shows last time and prefills its weights', async () => {
  apiMock.mockResolvedValueOnce({ 7: { date: '2026-11-03', sets: [
    { reps: 8, duration_seconds: null, weight_kg: 60 }, { reps: 6, duration_seconds: null, weight_kg: 62.5 }] } })
  render(<Workouts programs={[program]} logs={[]} programId={1} onSelectProgram={() => {}} canEdit onChanged={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Начать тренировку' }))
  expect((await screen.findByText(/В прошлый раз/)).textContent).toMatch(/3 нояб.*60 кг × 8, 62,5 кг × 6/)
  expect((screen.getByLabelText('Жим лёжа, подход 2, вес') as HTMLInputElement).value).toBe('62.5')
  expect(lastLabel([{ reps: 8, duration_seconds: null, weight_kg: 60 }, { reps: 8, duration_seconds: null, weight_kg: 60 }])).toBe('2 подх. по 60 кг × 8')
  expect(lastLabel([{ reps: 12, duration_seconds: null, weight_kg: 0 }])).toBe('12 повт.')
  expect(lastLabel([{ reps: null, duration_seconds: 45, weight_kg: 0 }])).toBe('45 с')
})

test('workout session rejects bad reps without calling the API', () => {
  render(<Workouts programs={[program]} logs={[]} programId={1} onSelectProgram={() => {}} canEdit onChanged={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Начать тренировку' }))
  fireEvent.change(screen.getByLabelText('Жим лёжа, подход 1, повторы'), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подход 1' }))
  expect(screen.getByRole('alert').textContent).toBe('Повторы: целое число от 1 до 500')
  expect(apiMock.mock.calls.map((c) => c[0])).toEqual(['/api/exercises/last?ids=7']) // only the "last time" hint
})

test('food: search a product and add grams to a meal', async () => {
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  apiMock.mockResolvedValue(null) // outside Telegram -> public catalog
  publicGetMock.mockResolvedValue([{ id: 5, name: 'Творог 5%', brand: null, category: null, kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3 }])
  const onAdd = vi.fn().mockResolvedValue(undefined)
  render(<Food day={empty} canEdit onAdd={onAdd} onDelete={vi.fn()} />)

  fireEvent.click(screen.getAllByRole('button', { name: '+ Добавить' })[2]) // dinner
  fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: 'тв' } })
  fireEvent.click(await screen.findByRole('button', { name: /^Творог 5%/ }, { timeout: 2000 }))
  expect(publicGetMock).toHaveBeenCalledWith('/api/products/search?q=%D1%82%D0%B2')

  fireEvent.change(screen.getByDisplayValue('100'), { target: { value: '200' } })
  expect(document.querySelector('.amount-kcal strong')?.textContent).toBe('242') // big, for the typed amount
  fireEvent.click(screen.getByRole('button', { name: 'Добавить в «Ужин»' }))
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith(5, 200, 'dinner', null))
  // the sheet stays open for the next product: empty search, a running total
  expect((await screen.findByRole('status')).textContent).toContain('Добавлено: 1')
  expect((screen.getByPlaceholderText(/Поиск/) as HTMLInputElement).value).toBe('')
  // "+" on a row adds the shown amount in one tap
  fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: 'тв' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Добавить 100 г: Творог 5%' }, { timeout: 2000 }))
  await waitFor(() => expect(onAdd).toHaveBeenLastCalledWith(5, 100, 'dinner', null))
  expect((await screen.findByRole('status')).textContent).toContain('Добавлено: 2')
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

test('food: line actions — change grams, move, delete', async () => {
  const day: FoodDay = {
    date: '', totals: { kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3 },
    items: [{ id: 42, meal_type: 'lunch', amount_g: 100, logged_at: '', kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3,
      product: { id: 5, name: 'Творог 5%', brand: null, category: null, kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3 } }],
  }
  const onDelete = vi.fn().mockResolvedValue(undefined)
  const onGrams = vi.fn().mockResolvedValue(undefined)
  const onMove = vi.fn().mockResolvedValue(undefined)
  render(<Food day={day} canEdit onAdd={vi.fn()} onDelete={onDelete} onGrams={onGrams} onMove={onMove} />)
  // meals are open: the line is visible right away; ⋯ (or a long press) opens its menu
  fireEvent.click(screen.getByRole('button', { name: 'Действия: Творог 5%' }))
  fireEvent.click(screen.getByRole('button', { name: 'Изменить количество' }))
  fireEvent.change(screen.getByLabelText('Граммы, Творог 5%'), { target: { value: '150' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(onGrams).toHaveBeenCalledWith(42, 150))

  fireEvent.click(screen.getByRole('button', { name: 'Действия: Творог 5%' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Ужин' }))
  await waitFor(() => expect(onMove).toHaveBeenCalledWith(42, 'dinner'))

  fireEvent.click(screen.getByRole('button', { name: 'Действия: Творог 5%' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить' })) // no "are you sure": the toast offers undo
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

test('body: add measurement prefilled with latest values, validated', async ({ onTestFinished }) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => { vi.useRealTimers() })
  vi.setSystemTime(new Date('2026-10-29T12:00:00'))
  const onSave = vi.fn().mockResolvedValue(undefined)
  const ago = (d: number) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10) // the trend looks 30 days back from today
  render(<Body measurements={[m(2, ago(3), 79.1), m(1, ago(10), 79.6, 85)]} canEdit onSave={onSave} onDelete={vi.fn()} />)
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

  apiMock.mockResolvedValueOnce({ text: 'Сегодня 1650 ккал из 2354.\nСовет: добавь белка на ужин.', created_at: '', cached: false })
  fireEvent.click(screen.getByRole('button', { name: 'Получить итог дня' }))
  expect(await screen.findByText(/Совет: добавь белка/)).toBeTruthy()
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
  expect(apiMock).toHaveBeenCalledWith('/api/products', expect.objectContaining({ body: JSON.stringify({ name: 'Сырник домашний', kcal: 220, protein_g: 15, fat_g: 9, carbs_g: 20, brand: null, portion_g: null }) }))
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
  expect(titles).toEqual(['КБЖУ за сегодня', 'Приёмы пищи', 'Завтрак', 'Перекус 11:30', 'Обед', 'Перекус 16:40', 'Ужин'])
  expect(screen.getByRole('button', { name: /Перекус 11:30\s*180 ккал/ })).toBeTruthy() // 11:30 snack total
  fireEvent.click(screen.getAllByRole('button', { name: '+ Добавить' })[1]) // into the 11:30 snack
  fireEvent.click(await screen.findByRole('button', { name: /^Творог 5%/ }))
  fireEvent.click(screen.getByRole('button', { name: /Добавить в «Перекус»/ }))
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith(5, 50, 'snack', '11:30'))
  expect(screen.getByRole('button', { name: '+ Перекус' })).toBeTruthy()
})

test('reminders: toggles and times are saved', async () => {
  const saved: unknown[] = []
  apiMock.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { saved.push(JSON.parse(String(init.body))); return null }
    return { meals: true, water: true, streak: true, weekly: true, breakfast_at: '10:00', lunch_at: '14:00', dinner_at: '20:00', streak_at: '21:00', weekly_at: '19:00' }
  })
  const { default: Reminders } = await import('./Reminders')
  render(<Reminders />)
  const toggle = await screen.findByRole('button', { name: 'Напоминания в боте' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('switch', { name: 'Напоминать о воде' }))
  expect(screen.getByRole('switch', { name: 'Напоминать о воде' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.change(screen.getByLabelText('Обед, время'), { target: { value: '13:30' } })
  fireEvent.click(screen.getByRole('switch', { name: 'Напоминать о приёмах пищи' }))
  expect(screen.queryByLabelText('Обед, время')).toBeNull() // times hide when meals are off
  fireEvent.click(screen.getByRole('switch', { name: 'Присылать итоги недели' }))
  await waitFor(() => expect(saved).toHaveLength(4))
  expect(saved[3]).toMatchObject({ meals: false, water: false, lunch_at: '13:30', weekly: false })
})

test('home water: portions, custom volume, removing any amount', async () => {
  const { default: Home } = await import('./Home')
  const onWater = vi.fn()
  const day: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  render(<Home name="Егор" level={1} streak={0} day={day} logs={[]} water={{ ml: 500, goal_ml: 2500 }}
    aiEnabled={false} canEdit onFood={vi.fn()} onNutrition={vi.fn()} onWorkouts={vi.fn()} onWater={onWater} />)
  fireEvent.click(screen.getByRole('button', { name: 'Добавить воды, 250 мл' })) // one tap on Home
  expect(screen.queryByRole('button', { name: 'Добавить 330 мл' })).toBeNull() // the portions are one tap further
  fireEvent.click(screen.getByRole('button', { name: 'Вода: подробнее' }))
  fireEvent.click(screen.getByRole('button', { name: 'Добавить 330 мл' }))
  fireEvent.click(screen.getByRole('button', { name: 'Свой объём' }))
  fireEvent.change(screen.getByLabelText('Объём, мл'), { target: { value: '5000' } })
  expect((screen.getByRole('button', { name: 'Добавить' }) as HTMLButtonElement).disabled).toBe(true) // over 1000 ml
  fireEvent.change(screen.getByLabelText('Объём, мл'), { target: { value: '400' } })
  fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Режим: убирать' }))
  fireEvent.click(screen.getByRole('button', { name: 'Убрать 150 мл' }))
  expect(screen.getByRole('button', { name: 'Добавить 250 мл' })).toBeTruthy() // back to adding after one fix
  fireEvent.click(screen.getByRole('button', { name: 'Режим: убирать' }))
  fireEvent.click(screen.getByRole('button', { name: 'Убрать свой объём' }))
  fireEvent.change(screen.getByLabelText('Убрать, мл'), { target: { value: '600' } })
  expect((screen.getByRole('button', { name: 'Убрать' }) as HTMLButtonElement).disabled).toBe(true) // more than drunk (500)
  fireEvent.change(screen.getByLabelText('Убрать, мл'), { target: { value: '200' } })
  fireEvent.click(screen.getByRole('button', { name: 'Убрать' }))
  expect(onWater.mock.calls.map((c) => c[0])).toEqual([250, 330, 400, -150, -200])
  expect(screen.getByRole('button', { name: 'Добавить воды, 400 мл' })).toBeTruthy() // the quick button pours the last portion
  localStorage.clear()
})

test('menu photo: pick dishes, save with the restaurant, then quick portions', async () => {
  const pizza = { name: 'Пепперони 30 см', kcal: 260, protein_g: 10.6, fat_g: 8.3, carbs_g: 34, portion_g: 610, portion_name: 'пицца' }
  const posted: Record<string, unknown>[] = []
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/products/recent' || path === '/api/favorites') return []
    if (path === '/api/ai/menu') return { venue: 'Додо Пицца', note: '', items: [pizza, { ...pizza, name: 'Морс', portion_g: null, portion_name: 'порция' }] }
    if (path === '/api/products') { const b = JSON.parse(String(init!.body)); posted.push(b); return { id: 90 + posted.length, brand: b.brand, category: 'Мои продукты', ...b, shared: false } }
    return null
  })
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  const onAdd = vi.fn().mockResolvedValue(undefined)
  const { container } = render(<Food day={empty} canEdit aiEnabled onAdd={onAdd} onDelete={vi.fn()} />)
  fireEvent.click(screen.getAllByRole('button', { name: '+ Добавить' })[0])
  fireEvent.click(await screen.findByRole('button', { name: '📷 Меню ресторана' }))
  const file = new File(['x'], 'menu.jpg', { type: 'image/jpeg' })
  fireEvent.change(container.ownerDocument.querySelector('.sheet input[type=file]')!, { target: { files: [file] } })
  const boxes = await screen.findAllByRole('checkbox')
  fireEvent.click(boxes[1]) // keep only the pizza
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить выбранные (1)' }))
  fireEvent.click(await screen.findByRole('button', { name: /Пепперони 30 см/ }))
  expect(posted).toEqual([{ ...pizza, brand: 'Додо Пицца' }])
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('1') // one pizza by default
  const chip = screen.getAllByRole('button').find((b) => b.textContent === 'пицца · 610 г')
  expect(chip?.getAttribute('aria-pressed')).toBe('true')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '0,5' } })
  expect(screen.getByText(/Количество · 305 г/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Добавить в/ }))
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith(91, 305, 'breakfast', null, { unit: 'пицца', qty: 0.5 }))
})

test('charts: tap a bar to read its value; goal line shown', async () => {
  const { BarChart, LineChart } = await import('./charts')
  const data = [{ date: '2026-10-30', value: 1800 }, { date: '2026-10-31', value: 2600 }, { date: '2026-11-01', value: 0 }]
  const { container } = render(<BarChart data={data} color="red" goal={2375} unit="ккал" />)
  expect(container.querySelector('.chart-read b')!.textContent).toBe('0') // latest day by default
  fireEvent.click(container.querySelectorAll('svg g')[1])
  expect(container.querySelector('.chart-read b')!.textContent!.replace(/\s/g, ' ')).toBe('2 600')
  expect(screen.getByText('норма')).toBeTruthy()
  expect(container.querySelectorAll('path')).toHaveLength(2) // empty day draws no bar
  cleanup()
  const line = render(<LineChart points={[{ date: '2026-10-01', value: 80.4 }, { date: '2026-10-29', value: 78.9 }]} color="red" unit="кг" />)
  expect(line.container.querySelector('.chart-read b')!.textContent).toBe('78,9')
})

test('friends: leaderboard, accept an incoming duel, challenge a friend', async () => {
  const board = [
    { id: 2, name: 'Борис', me: false, level: 3, week_xp: 120, streak: 5, registered: true },
    { id: 1, name: 'Аня', me: true, level: 2, week_xp: 40, streak: 2, registered: true },
    { id: 4, name: 'Гоша', me: false, level: 1, week_xp: 0, streak: 0, registered: false },
    { id: 3, name: 'Вера', me: false, level: 1, week_xp: 0, streak: 0, registered: true },
  ]
  const duels = [{ id: 9, metric: 'xp', days: 3, status: 'pending', incoming: true, rival: 'Борис', rival_id: 2, ends_at: null, result: null }]
  apiMock.mockImplementation(async (path: string) => (path === '/api/friends' ? { invite_link: 'https://t.me/b?start=fx', board } : path === '/api/duels' ? duels : { ok: true }))
  render(<Friends />)
  expect(await screen.findByText('Рейтинг недели')).toBeTruthy()
  expect(screen.getByText('Ты')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Вызвать Борис на дуэль' })).toBeNull() // a duel with Борис is already open
  expect(screen.queryByRole('button', { name: 'Вызвать Гоша на дуэль' })).toBeNull() // no profile yet: no duels
  expect(screen.getByText('без анкеты')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Принять' }))
  await waitFor(() => expect(apiMock.mock.calls.some((c) => c[0] === '/api/duels/9/accept')).toBe(true))

  fireEvent.click(screen.getByRole('button', { name: 'Вызвать Вера на дуэль' }))
  fireEvent.click(screen.getByRole('button', { name: 'Тренировки' }))
  fireEvent.click(screen.getByRole('button', { name: '3 дня' }))
  fireEvent.click(screen.getByRole('button', { name: 'Вызвать' }))
  await waitFor(() => expect(apiMock.mock.calls.find((c) => c[0] === '/api/duels' && c[1])?.[1]?.body).toBe(JSON.stringify({ friend_id: 3, metric: 'workouts', days: 3 })))
  expect(await screen.findByRole('status')).toBeTruthy()
})

test('weekly tasks: one row on Home that opens the list', () => {
  render(<Quests week={{ days_left: 3, bonus: 50, xp_awarded: 0, items: [
    { code: 'diary_days', title: 'Веди дневник питания 5 дн.', progress: 5, target: 5, xp: 50, done: true },
    { code: 'workouts', title: 'Проведи 3 тренировки', progress: 1, target: 3, xp: 80, done: false },
  ] }} />)
  expect(screen.getByText('Задания недели · 1 из 2')).toBeTruthy()
  expect(screen.getByText('ещё 3 дня · все три — ещё +50 XP')).toBeTruthy()
  expect(screen.queryByText('1 из 3')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Задания недели/ }))
  expect(screen.getByText('1 из 3')).toBeTruthy()
})

test('workout player: one exercise at a time, moves on when its sets are done', async () => {
  const two: Program = { ...program, days: [{ ...program.days[0], exercises: [
    { exercise_id: 7, name: 'Жим лёжа', sets: 1, reps: '8', rest_seconds: 90, notes: null },
    { exercise_id: 8, name: 'Тяга', sets: 1, reps: '10', rest_seconds: 90, notes: null }] }, program.days[1]] }
  apiMock.mockImplementation(async (path: string) => (path.startsWith('/api/exercises/last') ? {} : path === '/api/workout-logs' ? { id: 5 } : { id: 1 }))
  render(<Workouts programs={[two]} logs={[]} programId={1} onSelectProgram={() => {}} canEdit onChanged={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Начать тренировку' }))
  expect(screen.getByText('Упражнение 1 из 2')).toBeTruthy()
  expect(screen.queryByLabelText('Тяга, подход 1, вес')).toBeNull()
  fireEvent.change(screen.getByLabelText('Жим лёжа, подход 1, вес'), { target: { value: '60' } })
  // ± without the keyboard, then one big button saves the current set
  fireEvent.click(screen.getByRole('button', { name: 'Плюс 2,5 кг' }))
  fireEvent.click(screen.getByRole('button', { name: 'Минус повтор' }))
  fireEvent.click(screen.getByRole('button', { name: '✓ Подход 1: 7 повт. × 62,5 кг' }))
  await waitFor(() => expect(apiMock.mock.calls.some((c) => String(c[0]).endsWith('/sets'))).toBe(true))
  const sent = JSON.parse(String(apiMock.mock.calls.find((c) => String(c[0]).endsWith('/sets'))![1]!.body))
  expect(sent).toMatchObject({ reps: 7, weight_kg: 62.5 })
  expect(await screen.findByText('Упражнение 2 из 2', {}, { timeout: 2000 })).toBeTruthy()
  // a swipe right goes back to the previous exercise
  const card = screen.getByText('Упражнение 2 из 2').closest('section')!
  fireEvent.pointerDown(card, { clientX: 50, clientY: 100 })
  fireEvent.pointerUp(card, { clientX: 200, clientY: 105 })
  expect(screen.getByText('Упражнение 1 из 2')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Следующее →' }))
  fireEvent.click(screen.getByRole('button', { name: 'Все упражнения' }))
  expect(screen.getByLabelText('Жим лёжа, подход 1, вес')).toBeTruthy()
  expect(screen.getByLabelText('Тяга, подход 1, вес')).toBeTruthy()
})

test('a broken screen shows a restart button instead of a blank page', async () => {
  const { default: CrashScreen } = await import('./CrashScreen')
  const Boom = () => { throw new Error('boom') }
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<CrashScreen><Boom /></CrashScreen>)
  expect(screen.getByRole('button', { name: 'Перезапустить' })).toBeTruthy()
  quiet.mockRestore()
})


test('habits: one tap ticks today, a server error puts it back', async () => {
  const sleep: Habit = { id: 1, title: 'Сон 8 часов', emoji: '😴', done: false, streak: 3 }
  const onChange = vi.fn()
  apiMock.mockResolvedValueOnce([{ ...sleep, done: true, streak: 4 }])
  render(<Habits habits={[sleep]} onChange={onChange} />)
  expect(screen.queryByRole('button', { name: /Сон 8 часов/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Привычки/ }))
  fireEvent.click(screen.getByRole('button', { name: /Сон 8 часов/ }))
  expect(onChange).toHaveBeenNthCalledWith(1, [{ ...sleep, done: true }]) // instantly, before the server answers
  expect(apiMock).toHaveBeenCalledWith('/api/habits/1/check', expect.objectContaining({ body: JSON.stringify({ done: true, day: new Date().toLocaleDateString('sv') }) }))
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([{ ...sleep, done: true, streak: 4 }]))

  onChange.mockReset()
  apiMock.mockRejectedValueOnce(new ApiError(500, 'Сервер упал'))
  fireEvent.click(screen.getByRole('button', { name: /Сон 8 часов/ }))
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([sleep]))
  expect((await screen.findByRole('alert')).textContent).toBe('Сервер упал')

  // no connection at all: the tick stays and waits in the offline queue
  onChange.mockReset()
  const onQueued = vi.fn()
  localStorage.removeItem('setly-offline-queue')
  apiMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  render(<Habits habits={[{ ...sleep, title: 'Растяжка', id: 5 }]} onChange={onChange} onQueued={onQueued} />)
  fireEvent.click(screen.getByRole('button', { name: /Растяжка/ }))
  await waitFor(() => expect(onQueued).toHaveBeenCalled())
  expect(onChange).toHaveBeenCalledTimes(1) // only the instant tick, not taken back
  expect(JSON.parse(localStorage.getItem('setly-offline-queue')!)[0].path).toBe('/api/habits/5/check')
})

test('habits: empty list offers to set them up with presets', async () => {
  apiMock.mockResolvedValueOnce([{ id: 2, title: 'Витамины', emoji: '💊', done: false, streak: 0 }])
  const onChange = vi.fn()
  render(<Habits habits={[]} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: /Привычки/ }))
  fireEvent.click(screen.getByRole('button', { name: /Витамины/ }))
  await waitFor(() => expect(onChange).toHaveBeenCalled())
  expect(apiMock).toHaveBeenCalledWith('/api/habits', expect.objectContaining({ body: JSON.stringify({ emoji: '💊', title: 'Витамины' }) }))
})


test('consent: nothing goes on without the main tick; health is a separate, optional one', async () => {
  const onDone = vi.fn()
  render(<Consent url="https://example.test/privacy" onDone={onDone} />)
  const go = screen.getByRole('button', { name: 'Продолжить' }) as HTMLButtonElement
  expect(go.disabled).toBe(true)
  expect(screen.getByRole('link', { name: 'политикой конфиденциальности' }).getAttribute('href')).toBe('https://example.test/privacy')
  fireEvent.click(screen.getByRole('checkbox', { name: /Согласен на обработку/ }))
  fireEvent.click(go)
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(false))
  expect(apiMock).toHaveBeenCalledWith('/api/consent', expect.objectContaining({ body: JSON.stringify({ health: false }) }))
})

test('privacy card: deleting the account asks first, then calls the API', async () => {
  render(<PrivacyCard consent={{ ok: true, health: true, url: null }} onHealth={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Удалить аккаунт и все данные' }))
  expect(apiMock).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Удалить навсегда' }))
  await screen.findByText(/аккаунт и данные удалены/)
  expect(apiMock).toHaveBeenCalledWith('/api/account', { method: 'DELETE' })
})


test('units: pieces, ml, glasses and spoons turn into grams', async () => {
  const { unitsFor, defaultAmount } = await import('./units')
  const base = { id: 1, name: 'x', brand: null, category: null, kcal: 50, protein_g: 1, fat_g: 1, carbs_g: 1 }
  const egg = { ...base, piece_g: 55, piece_name: null }
  expect(unitsFor(egg).map((u) => [u.label, u.g])).toEqual([['г', 1], ['шт', 55]])
  expect(defaultAmount(egg)).toEqual({ unit: { label: 'шт', g: 55 }, qty: 1 })
  const milk = { ...base, ml_g: 1.03, tbsp_g: 15.5 }
  expect(unitsFor(milk).map((u) => u.label)).toEqual(['г', 'мл', 'стакан', 'ст. л.', 'ч. л.'])
  expect(unitsFor(milk).find((u) => u.label === 'стакан')!.g).toBeCloseTo(257.5)
  expect(defaultAmount(milk).qty).toBe(200)
  expect(defaultAmount(base)).toEqual({ unit: { label: 'г', g: 1 }, qty: 100 })
  // Open Food Facts packages: a 125 g yogurt is "1 упаковка", a litre of juice starts at 200 ml, a kilo of oats at its serving
  expect(defaultAmount({ ...base, piece_g: 125, piece_name: 'упаковка' })).toEqual({ unit: { label: 'упаковка', g: 125 }, qty: 1 })
  expect(defaultAmount({ ...base, piece_g: 1000, piece_name: 'упаковка', ml_g: 1 })).toEqual({ unit: { label: 'мл', g: 1 }, qty: 200 })
  expect(defaultAmount({ ...base, piece_g: 1000, piece_name: 'упаковка', portion_g: 30, portion_name: 'порция' }).unit.label).toBe('порция')
})

test('search: an amount in the query opens the product with it; brands of one product fold', async () => {
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  const egg = { id: 7, name: 'Яйцо куриное', brand: null, category: null, kcal: 157, protein_g: 12.7, fat_g: 11.5, carbs_g: 0.7, piece_g: 55, piece_name: null }
  const milk = (id: number, brand: string | null) => ({ id, name: 'Молоко 2.5%', brand, category: null, kcal: 52, protein_g: 2.8, fat_g: 2.5, carbs_g: 4.7, ml_g: 1.03 })
  apiMock.mockResolvedValue(null)
  publicGetMock.mockImplementation(async (url: string) =>
    url.includes('quiet=1') ? [] : url.includes(encodeURIComponent('яйцо')) ? [egg] : [milk(1, null), milk(2, 'Домик'), milk(3, 'Савушкин')])
  const onAdd = vi.fn().mockResolvedValue(undefined)
  render(<Food day={empty} canEdit onAdd={onAdd} onDelete={vi.fn()} />)
  fireEvent.click(screen.getAllByRole('button', { name: '+ Добавить' })[0])

  fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: 'яйцо 2' } })
  const row = await screen.findByRole('button', { name: /^Яйцо куриное/ }, { timeout: 2000 })
  expect(row.parentElement!.textContent).toContain('173 ккал') // 2 × 55 g
  expect(screen.getByRole('button', { name: 'Добавить 2 шт: Яйцо куриное' })).toBeTruthy()
  expect(publicGetMock).toHaveBeenCalledWith(`/api/products/search?q=${encodeURIComponent('яйцо 2')}&quiet=1`) // tried whole first
  fireEvent.click(row)
  expect((screen.getByRole('textbox', { name: 'Количество' }) as HTMLInputElement).value).toBe('2')
  fireEvent.click(screen.getByRole('button', { name: /Добавить в/ }))
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith(7, 110, 'breakfast', null, { unit: 'шт', qty: 2 }))

  await screen.findByRole('status') // still open: the next product
  fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: 'молоко' } })
  await screen.findByRole('button', { name: 'ещё 2 варианта ›' }, { timeout: 2000 })
  expect(screen.getAllByRole('button', { name: /^Молоко 2.5%/ })).toHaveLength(1) // brands folded under the plain one
  fireEvent.click(screen.getByRole('button', { name: 'ещё 2 варианта ›' }))
  expect(screen.getAllByRole('button', { name: /^Молоко 2.5%/ })).toHaveLength(3)
})

test('search: nothing found offers AI, a label photo and the scanner', async () => {
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  apiMock.mockResolvedValue(null)
  publicGetMock.mockResolvedValue([])
  render(<Food day={empty} canEdit aiEnabled onAdd={vi.fn()} onDelete={vi.fn()} />)
  fireEvent.click(screen.getAllByRole('button', { name: '+ Добавить' })[0])
  fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: 'борщ бабушкин' } })
  fireEvent.click(await screen.findByRole('button', { name: /Описать AI/ }, { timeout: 2000 }))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('борщ бабушкин') // the AI text sheet, prefilled
})

test('units: parse amounts typed into the search', async () => {
  const { parseQuery, applyWanted } = await import('./units')
  expect(parseQuery('яйцо 2')).toEqual({ text: 'яйцо', wanted: { qty: 2, unit: null } })
  expect(parseQuery('молоко 200 мл')).toEqual({ text: 'молоко', wanted: { qty: 200, unit: 'мл' } })
  expect(parseQuery('2 банана')).toEqual({ text: 'банана', wanted: { qty: 2, unit: null } })
  expect(parseQuery('творог 5%').wanted).toBeNull() // a fat percentage is not an amount
  const base = { id: 1, name: 'x', brand: null, category: null, kcal: 50, protein_g: 1, fat_g: 1, carbs_g: 1 }
  expect(applyWanted(base, { qty: 150, unit: null })).toEqual({ unit: { label: 'г', g: 1 }, qty: 150 })
  expect(applyWanted(base, { qty: 2, unit: null })).toBeNull() // "2" of something without pieces: ignore
  expect(applyWanted({ ...base, ml_g: 1 }, { qty: 0.5, unit: 'л' })).toEqual({ unit: { label: 'мл', g: 1 }, qty: 500 })
  expect(applyWanted({ ...base, tbsp_g: 25 }, { qty: 1, unit: 'ст.л.' })?.unit.label).toBe('ст. л.')
  const { unitWord } = await import('./units')
  expect([1, 2, 5, 11, 22, 1.5].map((n) => unitWord('ломтик', n))).toEqual(['ломтик', 'ломтика', 'ломтиков', 'ломтиков', 'ломтика', 'ломтика'])
  expect(unitWord('шт', 5)).toBe('шт')
})

test('круговая тренировка ведёт по упражнениям и возвращает к следующему кругу', async () => {
  const circuit: Program = {
    ...program,
    days: [{ id: 20, day_name: 'Круг', day_order: 1, exercises: [
      { exercise_id: 7, name: 'Первое упражнение', sets: 2, reps: '30', rest_seconds: 20, unit: 'seconds', superset: 1, notes: null },
      { exercise_id: 8, name: 'Второе упражнение', sets: 2, reps: '8', rest_seconds: 90, superset: 1, notes: null },
    ] }],
  }
  apiMock.mockResolvedValueOnce({}).mockResolvedValueOnce({ id: 99 }).mockResolvedValue({ id: 1 })
  render(<Workouts programs={[circuit]} logs={[]} programId={1} onSelectProgram={() => {}} canEdit onChanged={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Начать тренировку' }))
  const start = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Засечь время' }))
    expect(screen.getByRole('timer').textContent).toBe('00:00')
    clock.mockReturnValue(start + 47000)
    await waitFor(() => expect(screen.getByRole('timer').textContent).toBe('00:47'))
    fireEvent.click(screen.getByRole('button', { name: 'Завершить подход' }))
    await waitFor(() => expect(screen.getByRole('timer').textContent).toBe('00:20'))
    clock.mockReturnValue(start + 50000)
    await waitFor(() => expect(screen.getByRole('timer').textContent).toBe('00:17'))
  } finally { clock.mockRestore() }
  await waitFor(() => expect(screen.getByLabelText('Второе упражнение, подход 1, повторы')).toBeTruthy())
  expect(screen.getByText('Подход 1 · 47 с')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подход 1' }))
  await waitFor(() => expect(screen.getByLabelText('Первое упражнение, подход 2, секунды')).toBeTruthy())
  expect(screen.getByText(/Круг 2 из 2/)).toBeTruthy()
  const sent = apiMock.mock.calls.filter(([url]) => String(url).endsWith('/sets')).map(([, options]) => JSON.parse(options!.body as string))
  expect(sent).toEqual([
    { exercise_id: 7, set_number: 1, duration_seconds: 47, weight_kg: 0 },
    { exercise_id: 8, set_number: 1, reps: 8, weight_kg: 0 },
  ])
})

test('recipe: per 100 g from ingredients and the cooked weight, saved to the API', async () => {
  const { default: RecipeEditor } = await import('./Recipe')
  const beet = { id: 3, name: 'Свёкла', brand: null, category: null, kcal: 40, protein_g: 1.5, fat_g: 0.1, carbs_g: 8.8 }
  apiMock.mockImplementation(async (url: string) => (url.startsWith('/api/products/search') ? [beet] : { ...beet, id: 99, name: 'Борщ' }))
  const onSaved = vi.fn()
  render(<RecipeEditor onSaved={onSaved} onCancel={vi.fn()} />)
  fireEvent.change(screen.getByPlaceholderText(/Например/), { target: { value: 'Борщ' } })
  fireEvent.change(screen.getByLabelText('Добавить продукт в рецепт'), { target: { value: 'свекла' } })
  fireEvent.click(await screen.findByRole('button', { name: /Свёкла/ }, { timeout: 2000 }))
  fireEvent.change(screen.getByLabelText('Свёкла, граммы'), { target: { value: '500' } })
  fireEvent.change(screen.getByPlaceholderText('500'), { target: { value: '400' } }) // boiled down from 500 g to 400 g
  expect(screen.getByText(/50 ккал/)).toBeTruthy() // 200 kcal in 400 g
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить рецепт' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(apiMock).toHaveBeenLastCalledWith('/api/recipes', expect.objectContaining({ method: 'POST',
    body: JSON.stringify({ name: 'Борщ', ingredients: [{ product_id: 3, grams: 500 }], cooked_g: 400, servings: null }) }))
})

test('real expenditure: shows the estimate, the forecast and applies the suggested norm', async () => {
  const { default: EnergyCard } = await import('./Energy')
  const e = { ready: true, formula: 2400, days_logged: 21, weighins: 5, need_days: 10, need_weighins: 3, target_weight_kg: 75, kcal_override: null,
    goal: 'weight_loss', tdee: 2550, intake: 2000, kg_per_week: -0.5, suggest: 2000, weight: 78.5, in_30_days: 76.4, eta: '2027-03-01', plateau: true,
    plateau_tips: ['Норму ты держишь, а вес стоит — значит, реальный расход ниже расчёта. Снизь норму до 1750 ккал.'], plateau_kcal: 1750 }
  apiMock.mockImplementation(async (url: string) => (url === '/api/insights/energy' ? e : {}))
  const onNorm = vi.fn()
  render(<EnergyCard calories={1900} onNormChanged={onNorm} />)
  expect(await screen.findByText(/2 550|2 550/)).toBeTruthy()
  expect(screen.getByText(/Вес стоит две недели/)).toBeTruthy()
  expect(screen.getByRole('button', { name: /Сделать норму 1.750 ккал/ })).toBeTruthy() // the plateau's own step
  expect(screen.getByText(/к 1 марта/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Сделать норму 2.000 ккал/ }))
  await waitFor(() => expect(onNorm).toHaveBeenCalled())
  expect(apiMock).toHaveBeenCalledWith('/api/insights/energy/apply', expect.objectContaining({ body: JSON.stringify({ kcal: 2000 }) }))
})

test('progression: add weight only when every set reached the top of the plan', async () => {
  const { nextWeight, topReps } = await import('./progression')
  const s = (reps: number, weight_kg: number) => ({ reps, duration_seconds: null, weight_kg })
  expect(topReps('8-12')).toBe(12)
  expect(nextWeight([s(12, 60), s(12, 60), s(12, 60)], '8-12')).toBe(62.5)
  expect(nextWeight([s(12, 60), s(10, 60)], '8-12')).toBeNull() // not all sets made it
  expect(nextWeight([s(10, 12), s(10, 12)], '10')).toBe(13) // dumbbells: +1 kg
  expect(nextWeight([s(15, 0)], '15')).toBeNull() // bodyweight
  expect(nextWeight(undefined, '10')).toBeNull()
})

test('challenges: accept an invitation, tick today', async () => {
  const { default: Challenges } = await import('./Challenges')
  const ch = { id: 5, title: 'Без сладкого', emoji: '🍬', days: 7, day: 2, end_day: '', finished: false, mine: false, invited: true,
    members: [{ name: 'Аня', me: false, joined: true, done: 2, today: true }, { name: 'Ты', me: true, joined: false, done: 0, today: false }] }
  let state = ch
  apiMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/join')) state = { ...ch, invited: false, members: ch.members.map((m) => (m.me ? { ...m, joined: true } : m)) }
    if (url.endsWith('/check')) state = { ...state, members: state.members.map((m) => (m.me ? { ...m, today: true, done: 1 } : m)) }
    return url === '/api/challenges' ? [state] : state
  })
  render(<Challenges friends={[{ id: 2, name: 'Аня' }]} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Принять' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Отметить день' }))
  await screen.findByRole('button', { name: '✓ Сегодня' })
  expect(apiMock).toHaveBeenCalledWith('/api/challenges/5/check', expect.objectContaining({ body: JSON.stringify({ done: true }) }))
})

test('food: day switcher — arrows, a past day writes there, Esc closes a sheet', async () => {
  const iso = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE') }
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  apiMock.mockResolvedValue(null)
  const onDate = vi.fn()
  const { rerender } = render(<Food day={empty} date={iso(0)} onDate={onDate} canEdit onAdd={vi.fn()} onDelete={vi.fn()} />)
  expect((screen.getByRole('button', { name: 'Следующий день' }) as HTMLButtonElement).disabled).toBe(true) // no future
  fireEvent.click(screen.getByRole('button', { name: 'Предыдущий день' }))
  expect(onDate).toHaveBeenCalledWith(iso(-1))

  rerender(<Food day={empty} date={iso(-1)} onDate={onDate} canEdit onAdd={vi.fn()} onDelete={vi.fn()} />)
  expect(screen.getByText('Вчера')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'КБЖУ · Вчера' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '+ Дописать за вчера' }))
  expect(screen.getByRole('dialog', { name: 'Дописать · Вчера' })).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

test('quick weight on Home keeps the rest of today\'s measurement', async () => {
  const { QuickWeight } = await import('./Body')
  const today = new Date().toLocaleDateString('sv-SE')
  const onSave = vi.fn().mockResolvedValue(undefined)
  render(<QuickWeight measurements={[{ id: 1, measured_on: today, weight_kg: null, waist_cm: 80, chest_cm: null, hips_cm: null, body_fat_pct: null },
    { id: 2, measured_on: '2026-01-01', weight_kg: 75, waist_cm: null, chest_cm: null, hips_cm: null, body_fat_pct: null }]} onSave={onSave} />)
  fireEvent.click(screen.getByRole('button', { name: /Взвеситься/ }))
  expect((screen.getByLabelText('Вес, кг') as HTMLInputElement).value).toBe('75') // the last weight
  fireEvent.click(screen.getByRole('button', { name: 'Минус 0,1 кг' }))
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ weight_kg: 74.9, waist_cm: 80, chest_cm: null, hips_cm: null, body_fat_pct: null }))
})

test('food: the calendar colours days by the norm and opens a picked day; old days are read only', async () => {
  const d = new Date(), month = d.toLocaleDateString('sv-SE').slice(0, 7)
  const day1 = `${month}-01`
  apiMock.mockImplementation(async (path: string) => (path.startsWith('/api/food-calendar') ? { days: { [day1]: 2000 }, goal: 2200 } : null))
  const onDate = vi.fn()
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  render(<Food day={empty} date={d.toLocaleDateString('sv-SE')} onDate={onDate} canEdit onAdd={vi.fn()} onDelete={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /открыть календарь/ }))
  expect(apiMock).toHaveBeenCalledWith(`/api/food-calendar?month=${month}`)
  const cell = await screen.findByRole('button', { name: /^1 .*, 2000 ккал$/ })
  expect(cell.className).toContain('ok') // 2000 of 2200: within 10%
  expect(screen.getByText(/Записано 1 день, в норме — 1/)).toBeTruthy()
  fireEvent.click(cell)
  expect(onDate).toHaveBeenCalledWith(day1)
  cleanup()

  const old = new Date(); old.setDate(old.getDate() - 60)
  render(<Food day={empty} date={old.toLocaleDateString('sv-SE')} onDate={onDate} canEdit onAdd={vi.fn()} onDelete={vi.fn()} />)
  expect(screen.getByText(/только для просмотра/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '+ Добавить' })).toBeNull()
})

test('food: quick amounts and what is left of the norm after a product', async () => {
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 1500, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  apiMock.mockResolvedValue(null)
  publicGetMock.mockResolvedValue([{ id: 5, name: 'Творог 5%', brand: null, category: null, kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3 }])
  const onAdd = vi.fn().mockResolvedValue(undefined)
  render(<Food day={empty} targets={{ calories: 2000, protein: 120, fat: 70, carbs: 230 }} canEdit onAdd={onAdd} onDelete={vi.fn()} />)
  fireEvent.click(screen.getAllByRole('button', { name: '+ Добавить' })[0])
  fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: 'тв' } })
  expect(await screen.findByText('останется 379', {}, { timeout: 2000 })).toBeTruthy() // 500 left − 121
  fireEvent.click(screen.getByRole('button', { name: /^Творог 5%/ }))
  fireEvent.click(within(screen.getByRole('group', { name: 'Быстрое количество' })).getByRole('button', { name: '300' }))
  expect((screen.getByRole('textbox', { name: 'Количество' }) as HTMLInputElement).value).toBe('300')
  expect(screen.getByText(/останется 137/)).toBeTruthy()
  fireEvent.click(within(screen.getByRole('group', { name: 'Быстрое количество' })).getByRole('button', { name: '200' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Количество' }), { target: { value: '500' } })
  expect(screen.getByText(/сверх нормы на 105/)).toBeTruthy()
})

test('home: the usual meal in one tap', async () => {
  const { default: Home } = await import('./Home')
  const run = vi.fn()
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  render(<Home name="Егор" level={1} streak={0} day={empty} logs={[]} water={{ ml: 0, goal_ml: 2000 }} aiEnabled={false} canEdit
    onFood={vi.fn()} onNutrition={vi.fn()} onWorkouts={vi.fn()} onWater={vi.fn()}
    usual={{ meal: 'Завтрак', title: 'Овсянка, Яйцо', kcal: 380, run }} />)
  fireEvent.click(screen.getByRole('button', { name: /Завтрак как обычно/ }))
  expect(run).toHaveBeenCalled()
})

test('home: hide and reorder the blocks, kept on the phone', async () => {
  localStorage.clear()
  const { default: Home } = await import('./Home')
  const empty: FoodDay = { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }
  const props = { name: 'Егор', level: 1, streak: 0, day: empty, logs: [], water: { ml: 0, goal_ml: 2000 }, aiEnabled: false, canEdit: true,
    onFood: vi.fn(), onNutrition: vi.fn(), onWorkouts: vi.fn(), onWater: vi.fn(),
    habits: <div>Блок привычек</div>, quests: <div>Блок заданий</div>, weight: <div>Блок веса</div> }
  const { unmount } = render(<Home {...props} />)
  const order = () => [...document.querySelectorAll('.home-rows > *')].map((e) => e.textContent?.slice(0, 12))
  expect(order()).toEqual(['Выбери прогр', 'Блок привыче', 'Блок заданий'])
  fireEvent.click(screen.getByRole('button', { name: '⚙ Настроить главный экран' }))
  fireEvent.click(screen.getByRole('button', { name: 'Задания недели: выше' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Показывать: Тренировка на сегодня' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Показывать: Вес' }))
  expect(order()).toEqual(['Блок заданий', 'Блок привыче'])
  expect(screen.queryByText('Блок веса')).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: 'Показывать: Вес' }))
  fireEvent.click(screen.getByRole('button', { name: 'Вес: выше' })) // the weight can move between the rows: it splits the card
  expect([...document.querySelectorAll('.home-rows')].length).toBe(2)
  fireEvent.click(screen.getByRole('switch', { name: 'Показывать: Вес' }))
  unmount()
  render(<Home {...props} />) // next open: the same layout
  expect(order()).toEqual(['Блок заданий', 'Блок привыче'])
  localStorage.clear()
})

test('library: tap a muscle on the map, open an exercise; build a workout for chosen muscles and save it', async () => {
  const { default: Library } = await import('./Library')
  const ex = (id: number, name: string, primary: string[], extra = {}) => ({ id, name, equipment: [], difficulty: 'beginner', description: 'Ляг на скамью. Опусти штангу к груди. Выжми вверх.', is_bodyweight: false,
    primary, secondary: ['triceps'], images: [], category: 'strength', mechanic: 'compound', ...extra })
  const list = [
    ex(1, 'Жим штанги лёжа', ['chest'], { equipment: ['Штанга', 'Скамья'], images: ['Barbell_Bench/0.jpg', 'Barbell_Bench/1.jpg'] }),
    ex(2, 'Отжимания', ['chest'], { is_bodyweight: true }),
    ex(3, 'Разведения гантелей', ['chest'], { equipment: ['Гантели'], mechanic: 'isolation' }),
    ex(4, 'Французский жим', ['triceps'], { equipment: ['Штанга'], mechanic: 'isolation' }),
    ex(5, 'Обратные отжимания', ['triceps'], { is_bodyweight: true }),
    ex(6, 'Приседания', ['quadriceps'], { is_bodyweight: true }),
    ex(7, 'Растяжка груди', ['chest'], { category: 'stretching', is_bodyweight: true }),
  ]
  apiMock.mockImplementation(async (path: string) => (path === '/api/exercises' ? list : null))
  const onSave = vi.fn().mockResolvedValue(undefined)
  const profile = { sex: 'male', birth_year: 1995, height_cm: 180, weight_kg: 80, activity: 'moderate', goal: 'muscle_gain', experience: 'beginner', equipment: ['bodyweight', 'barbell', 'bench'] } as ProfileData
  const { unmount } = render(<Library canEdit profile={profile} mode="browse" onClose={vi.fn()} onSaveWorkout={onSave} />)
  expect(await screen.findByText('Нашлось: 6')).toBeTruthy() // strength only by default
  // equipment at hand, several at once: only what's doable with it
  fireEvent.click(screen.getByRole('button', { name: 'Гантели' }))
  expect(screen.getByText('Нашлось: 1')).toBeTruthy() // flyes; not the barbell press, not push-ups
  fireEvent.click(screen.getByRole('button', { name: 'Без инвентаря' }))
  expect(screen.getByText('Нашлось: 4')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Сбросить' }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Трицепс' })[0]) // a zone on the body map
  expect(screen.getByText('Нашлось: 6')).toBeTruthy() // main or helper muscle
  expect(document.querySelector('.lib-row b')!.textContent).toBe('Обратные отжимания') // main muscle first
  fireEvent.click(screen.getAllByRole('button', { name: 'Трицепс' })[0])
  fireEvent.click(screen.getAllByRole('button', { name: 'Грудь' })[0])
  expect(screen.getByText('Нашлось: 3')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Жим штанги лёжа/ }))
  const card = screen.getByRole('dialog', { name: 'Жим штанги лёжа' })
  expect(within(card).getAllByRole('img')[0].getAttribute('src')).toBe('/api/exercise-image/Barbell_Bench/0.webp')
  expect(within(card).getByText('Выжми вверх.')).toBeTruthy() // technique as steps
  fireEvent.keyDown(window, { key: 'Escape' })
  unmount()

  render(<Library canEdit profile={profile} mode="build" onClose={vi.fn()} onSaveWorkout={onSave} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Трицепс', pressed: false }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Грудь' })[1])
  fireEvent.click(screen.getByRole('button', { name: /Подобрать упражнения/ }))
  // no dumbbells in the profile: flyes are left out; base exercises first
  const names = () => [...document.querySelectorAll('.lib-row b')].map((b) => b.textContent)
  expect(names()).toEqual(['Французский жим', 'Жим штанги лёжа', 'Обратные отжимания', 'Отжимания'])
  fireEvent.click(screen.getByRole('button', { name: 'Убрать: Отжимания' }))
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить и выбрать' }))
  await waitFor(() => expect(onSave).toHaveBeenCalled())
  const draft = onSave.mock.calls[0][0]
  expect(draft.days[0].exercises.map((e: { exercise_id: number }) => e.exercise_id)).toEqual([4, 1, 5])
  expect(draft.days[0].exercises[0]).toMatchObject({ sets: 3, reps: '8-12', rest_seconds: 90 }) // muscle gain
})
