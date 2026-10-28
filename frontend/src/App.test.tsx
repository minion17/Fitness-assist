import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import App from './App'

afterEach(cleanup)

test('bottom navigation opens all four sections', () => {
  window.scrollTo = () => {}
  render(<App />)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Привет, Гость')

  const nav = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }))

  nav('Питание')
  expect(screen.getByText('КБЖУ за сегодня')).toBeTruthy()
  expect(screen.getByText('+ Добавить приём пищи')).toBeTruthy()

  nav('Тренировки')
  expect(screen.getByText('Упражнения')).toBeTruthy()
  expect(screen.getByText('История')).toBeTruthy()

  nav('Профиль')
  expect(screen.getByText('Параметры тела')).toBeTruthy()
  expect(screen.getByText('Демо-режим')).toBeTruthy()

  nav('Главная')
  expect(screen.getByText('Тренировка дня')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Главная' }).getAttribute('aria-current')).toBe('page')
})
