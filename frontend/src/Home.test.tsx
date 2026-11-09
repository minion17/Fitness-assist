import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Home from './Home'

afterEach(cleanup)
test('summarizes food and training with direct actions', () => {
  const onFood = vi.fn(), onNutrition = vi.fn(), onWorkouts = vi.fn()
  render(<Home name="Тест" level={1} streak={0} targets={{ calories: 2000, protein: 100, fat: 70, carbs: 200 }}
    day={{ date: '', items: [], totals: { kcal: 800, protein_g: 30, fat_g: 20, carbs_g: 40 } }}
    logs={[]} water={{ ml: 250, goal_ml: 2000 }} week={[]} aiEnabled={false} canEdit
    onFood={onFood} onNutrition={onNutrition} onWorkouts={onWorkouts} onWater={() => {}} summary={null} />)
  const nutrition = screen.getByRole('button', { name: /Питание/ })
  expect(nutrition.textContent).toContain('800')
  expect(screen.getByRole('button', { name: /Тренировка/ }).textContent).toContain('Выберите программу')
  expect(screen.queryByText('Белки')).toBeNull()
  fireEvent.click(nutrition)
  expect(onNutrition).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: /Тренировка/ }))
  expect(onWorkouts).toHaveBeenCalledOnce()
})


test('shows the average of nutrition and water progress', () => {
  render(<Home name="Тест" level={1} streak={0} targets={{ calories: 2000, protein: 100, fat: 70, carbs: 200 }} day={{date:'2026-11-05', meals: [], totals:{kcal:1000, protein_g:0, fat_g:0, carbs_g:0}} as never} logs={[]} water={{ml:500,goal_ml:1000}} week={[]} aiEnabled={false} canEdit onFood={() => {}} onNutrition={() => {}} onWorkouts={() => {}} onWater={() => {}} summary={null} />)
  expect(screen.getByLabelText('Прогресс дня: 50%')).toBeTruthy()
})

test('shows the x2 XP booster after a duel win', () => {
  render(<Home name="Тест" level={3} boostUntil="2030-01-01T10:00:00Z" streak={0} targets={{ calories: 2000, protein: 100, fat: 70, carbs: 250 }}
    day={{ date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }}
    logs={[]} water={{ ml: 0, goal_ml: 2000 }} week={[]} aiEnabled={false} canEdit={false}
    onFood={() => {}} onNutrition={() => {}} onWorkouts={() => {}} onWater={() => {}} summary={null} />)
  expect(screen.getByText(/бустер за победу в дуэли/)).toBeTruthy()
})
