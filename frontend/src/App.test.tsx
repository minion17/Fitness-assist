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

test('step-by-step questionnaire validates each step and saves all answers', async () => {
  window.scrollTo = () => {}
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Профиль' }))
  fireEvent.click(screen.getByRole('button', { name: 'Заполнить анкету' }))
  const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
  const alert = () => screen.getByRole('alert').textContent

  // 1. О себе
  click('Далее')
  expect(alert()).toBe('Выберите пол')
  click('Женский')
  const [year, height, weight] = screen.getAllByRole('textbox')
  fireEvent.change(year, { target: { value: '1995' } })
  fireEvent.change(height, { target: { value: '400' } })
  fireEvent.change(weight, { target: { value: '61,5' } })
  click('Далее')
  expect(alert()).toBe('Рост: от 120 до 230')
  fireEvent.change(height, { target: { value: '168' } })
  click('Далее')

  // 2. Цель (5 целей)
  expect(screen.getByText('Шаг 2 из 6')).toBeTruthy()
  click('Набор мышечной массы')
  click('Далее')

  // 3. Опыт и активность
  click('Далее')
  expect(alert()).toBe('Выберите уровень подготовки')
  click(/Новичок/)
  click(/Умеренная/)
  click('Далее')

  // 4. Тренировки: multi-select toggles
  click('Гантели'); click('Турник / брусья'); click('Гантели')
  expect(screen.getByRole('button', { name: 'Гантели' }).getAttribute('aria-pressed')).toBe('false')
  click('3'); click('45 мин')
  click('Далее')

  // 5. Питание: allergies optional; back keeps answers
  click('Назад')
  expect(screen.getByRole('button', { name: 'Турник / брусья' }).getAttribute('aria-pressed')).toBe('true')
  click('Далее')
  click('Орехи'); click('4 раза')
  click('Далее')

  // 6. Восстановление: conditional injury zone
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '7,5' } })
  click('Высокий')
  click('Да')
  click('Готово')
  expect(alert()).toBe('Выберите зону ограничения')
  click('Колени')
  click('Готово')

  expect(await screen.findByText('Набор мышц')).toBeTruthy()
  expect(screen.getByText('168')).toBeTruthy()
  expect(screen.getByText('61.5')).toBeTruthy()
  expect(screen.getByText(String(new Date().getFullYear() - 1995))).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Изменить анкету' })).toBeTruthy()
})

test('home water tracker, food shortcut and theme picker work in demo mode', () => {
  window.scrollTo = () => {}
  render(<App />)
  // demo: no account -> no edit buttons, ring still shows the goal
  expect(screen.getByText('из 2 000 ккал')).toBeTruthy()
  expect(screen.getByText(/Вода · 0/)).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Профиль' }))
  fireEvent.click(screen.getByRole('button', { name: 'Салатовая' }))
  expect(document.documentElement.dataset.theme).toBe('green')
  expect(screen.queryByRole('group', { name: 'Акцентный цвет' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Светлая' }))
  expect(document.documentElement.dataset.theme).toBe('light')
  fireEvent.click(screen.getByRole('button', { name: 'Акцент #a98bff' }))
  expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#a98bff')
  fireEvent.click(screen.getByRole('button', { name: 'Как в Telegram' }))
  expect(document.documentElement.dataset.theme).toBe('dark')
})
