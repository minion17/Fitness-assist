import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import App from './App'

afterEach(cleanup)

test('bottom navigation opens all four sections', async () => {
  window.scrollTo = () => {}
  render(<App />)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Привет, Гость')

  const nav = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }))

  nav('Питание')
  expect(screen.getByText('КБЖУ за сегодня')).toBeTruthy()
  expect(screen.getByText('Куриная грудка')).toBeTruthy() // demo diary outside Telegram
  expect(screen.getByText(/Демо-режим: чтобы вести дневник/)).toBeTruthy()

  nav('Тренировки')
  // API is unreachable in tests -> demo program list
  fireEvent.click(await screen.findByRole('button', { name: 'Выбрать' }))
  expect(screen.getByText('Следующая тренировка')).toBeTruthy()
  expect(screen.getByText('История')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Сменить программу' }))

  nav('Профиль')
  expect(screen.getByText('Параметры тела')).toBeTruthy()
  expect(screen.getByText('Демо-режим')).toBeTruthy()
  expect(screen.getByText('Уровень 1')).toBeTruthy()
  expect(screen.getByText('0 / 100 XP до уровня 2')).toBeTruthy()

  nav('Главная')
  expect(screen.getByText('Тренировка дня')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Главная' }).getAttribute('aria-current')).toBe('page')
})

test('questionnaire validates input and updates the profile', async () => {
  window.scrollTo = () => {}
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Профиль' }))
  fireEvent.click(screen.getByRole('button', { name: 'Заполнить анкету' }))

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(screen.getByRole('alert').textContent).toBe('Выберите пол, цель и уровень активности')

  fireEvent.click(screen.getByRole('button', { name: 'Женский' }))
  fireEvent.click(screen.getByRole('button', { name: 'Набор массы' }))
  fireEvent.click(screen.getByRole('button', { name: /Средняя/ }))
  const [year, height, weight] = screen.getAllByRole('textbox')
  fireEvent.change(year, { target: { value: '1995' } })
  fireEvent.change(height, { target: { value: '400' } })
  fireEvent.change(weight, { target: { value: '61,5' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(screen.getByRole('alert').textContent).toBe('Рост: от 120 до 230')

  fireEvent.change(height, { target: { value: '168' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText('Набор массы')).toBeTruthy()
  expect(screen.getByText('168')).toBeTruthy()
  expect(screen.getByText('61.5')).toBeTruthy()
  expect(screen.getByText(String(new Date().getFullYear() - 1995))).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Изменить анкету' })).toBeTruthy()
})
