import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import Questionnaire from './Questionnaire'

test('a closed questionnaire reopens on the same screen with the answers', async () => {
  localStorage.clear()
  const onSave = vi.fn(async () => {})
  const open = () => render(<Questionnaire initial={null} onSave={onSave} />)
  open()
  fireEvent.click(screen.getByRole('button', { name: /Женский/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Немного о вас')
  cleanup()
  open()
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Немного о вас')
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
  expect(screen.getByRole('button', { name: /Женский/ }).getAttribute('aria-pressed')).toBe('true')
})
