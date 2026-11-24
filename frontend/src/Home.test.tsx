import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import Home from './Home'
import FirstSteps from './FirstSteps'

// midday unless a test says otherwise: from 20:00 the day card opens with the day's summary
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 19, 13, 0)) })
afterEach(() => { cleanup(); vi.useRealTimers() })
test('summarizes food and training with direct actions', () => {
  const onFood = vi.fn(), onNutrition = vi.fn(), onWorkouts = vi.fn()
  render(<Home name="Тест" level={1} streak={0} targets={{ calories: 2000, protein: 100, fat: 70, carbs: 200 }}
    day={{ date: '', items: [], totals: { kcal: 800, protein_g: 30, fat_g: 20, carbs_g: 40 } }}
    logs={[]} water={{ ml: 250, goal_ml: 2000 }} aiEnabled={false} canEdit
    onFood={onFood} onNutrition={onNutrition} onWorkouts={onWorkouts} onWater={() => {}} />)
  const nutrition = screen.getByRole('button', { name: /Питание/ })
  expect(nutrition.textContent).toContain('800')
  expect(screen.getByRole('button', { name: /Выбери программу/ })).toBeTruthy()
  expect(screen.queryByText('Белки')).toBeNull()
  fireEvent.click(nutrition)
  expect(onNutrition).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: /Выбери программу/ }))
  expect(onWorkouts).toHaveBeenCalledOnce()
  expect(screen.queryByText('Неделя')).toBeNull() // moved to Прогресс
})


test('shows the average of nutrition and water progress', () => {
  render(<Home name="Тест" level={1} streak={0} targets={{ calories: 2000, protein: 100, fat: 70, carbs: 200 }} day={{date:'2026-11-05', meals: [], totals:{kcal:1000, protein_g:0, fat_g:0, carbs_g:0}} as never} logs={[]} water={{ml:500,goal_ml:1000}} aiEnabled={false} canEdit onFood={() => {}} onNutrition={() => {}} onWorkouts={() => {}} onWater={() => {}} />)
  expect(screen.getByLabelText('Прогресс дня: 50%. Из чего он сложился')).toBeTruthy()
})

test('the day ring counts habits and a workout done today, and shows its parts on tap', () => {
  const now = new Date().toISOString()
  render(<Home name="Тест" level={1} streak={0} targets={{ calories: 2000, protein: 100, fat: 70, carbs: 200 }}
    day={{ date: '', items: [], totals: { kcal: 2700, protein_g: 0, fat_g: 0, carbs_g: 0 } }} habitsDone={[4, 4]}
    logs={[{ id: 1, title: 'Т', program_day_id: null, started_at: now, completed_at: now, sets: 9 }]}
    water={{ ml: 2600, goal_ml: 2500 }} aiEnabled={false} canEdit onFood={() => {}} onNutrition={() => {}} onWorkouts={() => {}} onWater={() => {}} />)
  // food 135% of the norm → 75%; water, habits, workout 100% → (75 + 300) / 4 = 94%
  const ring = screen.getByRole('button', { name: 'Прогресс дня: 94%. Из чего он сложился' })
  fireEvent.click(ring)
  expect(screen.getByText('на 700 ккал больше нормы')).toBeTruthy()
  expect(screen.getByText('4 из 4')).toBeTruthy()
  expect(screen.getByText('сделана')).toBeTruthy()
})

test('shows the x2 XP booster after a duel win', () => {
  render(<Home name="Тест" level={3} boostUntil="2030-01-01T10:00:00Z" streak={0} targets={{ calories: 2000, protein: 100, fat: 70, carbs: 250 }}
    day={{ date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }}
    logs={[]} water={{ ml: 0, goal_ml: 2000 }} aiEnabled={false} canEdit={false}
    onFood={() => {}} onNutrition={() => {}} onWorkouts={() => {}} onWater={() => {}} />)
  expect(screen.getByText(/бустер за победу в дуэли/)).toBeTruthy()
})

test('first steps: shows progress, runs a step, collapses to a bar and reopens', () => {
  const water = vi.fn()
  const steps = [
    { key: 'meal', title: 'Запиши, что съел', hint: '', done: true, action: vi.fn() },
    { key: 'water', title: 'Отметь стакан воды', hint: 'Нажми — добавим 250 мл', done: false, action: water },
    { key: 'program', title: 'Выбери программу', hint: '', done: false, action: vi.fn() },
  ]
  render(<FirstSteps steps={steps} />)
  expect(screen.getByText('1 из 3')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Запиши, что съел — сделано' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Отметь стакан воды' }))
  expect(water).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Свернуть' }))
  expect(screen.queryByLabelText('Первые шаги')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Первые шаги: 1 из 3. Открыть' })) // the bar brings it back
  expect(screen.getByLabelText('Первые шаги')).toBeTruthy()
  localStorage.clear()
})

test('first steps fold into the bar by themselves past half', () => {
  localStorage.clear()
  render(<FirstSteps steps={[{ key: 'a', title: 'A', hint: '', done: true, action: () => {} }, { key: 'b', title: 'Б', hint: '', done: false, action: () => {} }]} />)
  expect(screen.queryByLabelText('Первые шаги')).toBeNull()
  expect(screen.getByRole('button', { name: 'Первые шаги: 1 из 2. Открыть' })).toBeTruthy()
})

test('first steps disappear when everything is done', () => {
  render(<FirstSteps steps={[{ key: 'a', title: 'A', hint: '', done: true, action: () => {} }]} />)
  expect(screen.queryByLabelText('Первые шаги')).toBeNull()
})

test('offers to repeat yesterday\'s meal in one tap', () => {
  const run = vi.fn()
  render(<Home name="Тест" level={1} streak={0} day={{ date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }}
    logs={[]} water={{ ml: 0, goal_ml: 2000 }} aiEnabled={false} canEdit
    onFood={() => {}} onNutrition={() => {}} onWorkouts={() => {}} onWater={() => {}}
    repeat={{ title: 'Повторить вчерашний завтрак', kcal: 420, run }} />)
  fireEvent.click(screen.getByRole('button', { name: /повторить вчерашний завтрак/ }))
  expect(run).toHaveBeenCalled()
})


test('in the evening the day card opens with what is left for today', () => {
  vi.setSystemTime(new Date(2026, 10, 19, 21, 0))
  render(<Home name="Тест" level={1} streak={0} targets={{ calories: 2000, protein: 100, fat: 70, carbs: 200 }}
    day={{ date: '', items: [], totals: { kcal: 1500, protein_g: 60, fat_g: 0, carbs_g: 0 } }}
    logs={[]} water={{ ml: 2000, goal_ml: 2000 }} aiEnabled={false} canEdit onFood={() => {}} onNutrition={() => {}} onWorkouts={() => {}} onWater={() => {}} />)
  expect(screen.getByText('Итог дня')).toBeTruthy()
  expect(screen.getByText('ещё 500 ккал')).toBeTruthy()
  expect(screen.getByText('ещё 40 г')).toBeTruthy() // protein
})

test('on a day off from the questionnaire the workout row says rest and when the next one is', () => {
  // 19.11.2026 is a Thursday; training on Mon, Wed, Fri
  const program = { id: 1, name: 'П', level: 'beginner', goal: '', days_per_week: 3, description: null,
    days: [{ id: 5, day_name: 'День 1', day_order: 1, exercises: [] }] }
  render(<Home name="Тест" level={1} streak={0} targets={{ calories: 2000, protein: 100, fat: 70, carbs: 200 }}
    day={{ date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }} program={program} trainingDays={[0, 2, 4]}
    logs={[]} water={{ ml: 0, goal_ml: 2000 }} aiEnabled={false} canEdit onFood={() => {}} onNutrition={() => {}} onWorkouts={() => {}} onWater={() => {}} />)
  expect(screen.getByText('Сегодня отдых 😌')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Следующая тренировка — пт: День 1/ })).toBeTruthy()
})
