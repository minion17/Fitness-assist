import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import Food from './Food'
import { api, publicGet } from './telegram'
import { mealNow, nextDay, type FoodDay, type Program, type WorkoutLog } from './types'
import Workouts from './Workouts'

vi.mock('./telegram', () => ({ api: vi.fn(), publicGet: vi.fn(), postJson: (b: unknown) => ({ method: 'POST', body: JSON.stringify(b) }) }))
const apiMock = vi.mocked(api)
const publicGetMock = vi.mocked(publicGet)

beforeEach(() => { apiMock.mockReset(); publicGetMock.mockReset() })
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
  publicGetMock.mockResolvedValue([{ id: 5, name: 'Творог 5%', brand: null, category: null, kcal: 121, protein_g: 17, fat_g: 5, carbs_g: 3 }])
  const onAdd = vi.fn().mockResolvedValue(undefined)
  render(<Food day={empty} canEdit onAdd={onAdd} />)

  fireEvent.click(screen.getAllByRole('button', { name: '+ Добавить' })[2]) // dinner
  fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: 'тв' } })
  fireEvent.click(await screen.findByRole('button', { name: /Творог 5%/ }, { timeout: 2000 }))
  expect(publicGetMock).toHaveBeenCalledWith('/api/products/search?q=%D1%82%D0%B2')

  fireEvent.change(screen.getByDisplayValue('100'), { target: { value: '200' } })
  expect(screen.getByText(/242 ккал/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Добавить в «Ужин»' }))
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith(5, 200, 'dinner'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
