import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Workouts from './Workouts'
import type { Program } from './types'

afterEach(cleanup)
const makeProgram = (id: number, name: string, level: string): Program => ({ id, name, level, goal: '', days_per_week: 1, description: null, days: [{ id, day_name: 'День 1', day_order: 1, exercises: [] }] })

test('готовые программы сгруппированы по уровню и доступны для просмотра', () => {
  const select = vi.fn()
  render(<Workouts programs={[makeProgram(1, 'Дом', 'beginner'), makeProgram(2, 'Гиря', 'intermediate'), makeProgram(3, 'Неизвестная', 'other')]} logs={[]} programId={null} onSelectProgram={select} canEdit={false} onChanged={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Программы' }))
  for (const title of ['Для новичков', 'Средний уровень', 'Другие программы']) expect(screen.getByText(title)).toBeTruthy()
  expect(screen.queryByText('Для опытных')).toBeNull() // no programs of that level: no empty row
  const beginner = screen.getByText('Для новичков').closest('details')!
  const middle = screen.getByText('Средний уровень').closest('details')!
  expect(beginner.open).toBe(false)
  expect(within(beginner).getByText('Дом')).toBeTruthy()
  expect(within(middle).getByText('Гиря')).toBeTruthy()
  fireEvent.click(within(beginner).getByText('Для новичков'))
  fireEvent.click(within(beginner).getByRole('button', { name: 'Посмотреть тренировки' }))
  expect(screen.getByText('День 1')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Выбрать программу' }))
  expect(select).toHaveBeenCalledWith(1)
})
