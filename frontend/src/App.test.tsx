import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import App from './App'

afterEach(cleanup)

test('bottom navigation opens all five sections', async () => {
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
  expect((await screen.findByRole('button', { name: 'Программы' })).textContent).toContain('Программа не выбрана')
  fireEvent.click(screen.getByRole('button', { name: 'Программы' }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Выбрать' })[0])
  expect(screen.getByRole('button', { name: 'Программы' }).textContent).toContain('Выбрана:')
  expect(screen.getByText('Следующая тренировка')).toBeTruthy()
  expect(screen.getByText('История')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Программы' }))
  expect(screen.getByText('Готовые программы')).toBeTruthy()

  nav('Прогресс')
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Прогресс')
  expect(screen.getByText('Параметры тела')).toBeTruthy() // measurements live next to the charts

  nav('Профиль')
  expect(screen.getByText('Демо-режим')).toBeTruthy()
  expect(screen.getByText('Уровень 1')).toBeTruthy()
  expect(screen.getByText('0 / 100 XP до уровня 2')).toBeTruthy()

  nav('Главная')
  expect(screen.getByText('Питание', { selector: '.day-stat .sub' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Главная' }).getAttribute('aria-current')).toBe('page')
})

test('questionnaire: one question per screen, a tap moves on, ends with the plan and saves all answers', async () => {
  window.scrollTo = () => {}
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Профиль' }))
  fireEvent.click(screen.getByRole('button', { name: 'Заполнить анкету' }))
  const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
  const title = () => screen.getByRole('heading', { level: 1 }).textContent
  const alert = () => screen.getByRole('alert').textContent
  const tap = async (name: string | RegExp, nextTitle: string) => { click(name); await waitFor(() => expect(title()).toBe(nextTitle)) }

  const slide = (name: string, value: number) => fireEvent.change(screen.getByRole('slider', { name }), { target: { value: String(value) } })
  click('Продолжить')
  expect(alert()).toBe('Выберите пол')
  await tap(/Женский/, 'Немного о вас')
  const [year, height, weight] = screen.getAllByRole('textbox')
  fireEvent.change(year, { target: { value: '1995' } })
  fireEvent.change(height, { target: { value: '400' } })
  fireEvent.change(weight, { target: { value: '61,5' } })
  click('Продолжить')
  expect(alert()).toBe('Рост: от 120 до 230')
  fireEvent.change(height, { target: { value: '168' } })
  click('Продолжить')
  await tap(/Снизить вес/, 'Каково ваше телосложение?')
  expect(screen.getByRole('img', { name: /Телосложение/ })).toBeTruthy() // our drawing
  click('Продолжить')
  expect(alert()).toBe('Сдвиньте ползунок')
  fireEvent.change(screen.getByRole('slider', { name: 'Телосложение сейчас' }), { target: { value: '5' } })
  click('Продолжить')
  slide('Целевое телосложение', 3)
  click('Продолжить')
  expect(title()).toBe('Желаемый вес')
  expect((screen.getByRole('slider', { name: 'Желаемый вес' }) as HTMLInputElement).value).toBe('55') // −10% for weight loss
  expect(screen.getByText(/Минус 6,5 кг/)).toBeTruthy()
  click('Продолжить')
  expect(title()).toBe('Ваш ориентир')
  expect(screen.getByText('Снизить вес на 6,5 кг')).toBeTruthy()
  expect(screen.getByText('61,5 кг')).toBeTruthy()
  expect(screen.getByText('55 кг')).toBeTruthy()
  click('Назад')
  slide('Желаемый вес', 62)
  click('Продолжить')
  expect(screen.getByText('Набрать вес на 0,5 кг')).toBeTruthy()
  click('Назад')
  slide('Желаемый вес', 55)
  click('Продолжить')
  click('Продолжить')
  const chooseFirst = (name: string) => fireEvent.keyDown(screen.getByRole('slider', { name }), { key: 'Home' })
  chooseFirst('Уровень подготовки')
  click('Продолжить')
  expect(screen.getByRole('img', { name: 'Приседания' })).toBeTruthy()
  slide('Приседания', 1)
  click('Продолжить')
  chooseFirst('Отжимания')
  click('Продолжить')
  chooseFirst('Подтягивания')
  click('Продолжить')
  await tap(/Умеренная/, 'Где будете тренироваться?')
  await tap(/Дома/, 'Что есть под рукой?')
  expect(screen.getByRole('button', { name: 'Собственный вес' }).getAttribute('aria-pressed')).toBe('true') // home preset
  click('Гантели')
  click('Продолжить')
  slide('Дней в неделю', 2)
  slide('Длительность тренировки', 2)
  click('Продолжить')
  expect(screen.getByRole('button', { name: 'Пропустить' })).toBeTruthy() // focus is optional
  click('Живот')
  click('Продолжить')
  // back keeps the answers
  click('Назад')
  expect(screen.getByRole('button', { name: 'Живот', pressed: true })).toBeTruthy()
  click('Продолжить')
  slide('Приёмов пищи в день', 1)
  click('Продолжить')
  slide('Сон, часов', 7.5)
  slide('Уровень стресса', 2)
  click('Продолжить')
  // demo mode counts as consented: the health screen
  expect(title()).toBe('Здоровье')
  click('Орехи')
  click('Да')
  click('Продолжить')
  expect(alert()).toBe('Выберите зону ограничения')
  click('Колени')
  click('Продолжить')

  expect(title()).toBe('Ваш план готов')
  expect(screen.getByText('8–13 нед.')).toBeTruthy() // 6.5 kg at 0.5–0.8 kg a week
  click('Сохранить и начать')
  expect(await screen.findByText('Ваши первые ориентиры')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Вернуться в профиль' }))
  expect(await screen.findByText('Снижение веса')).toBeTruthy()
  expect(screen.getByText('168')).toBeTruthy()
  expect(screen.getByText('61.5')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Изменить анкету' })).toBeTruthy()
})

test('home water tracker, food shortcut and theme picker work in demo mode', async () => {
  window.scrollTo = () => {}
  render(<App />)
  // demo: no account -> no edit buttons, ring still shows the goal
  await waitFor(() => expect(screen.getByRole('button', { name: 'Питание: открыть дневник' }).textContent).toMatch(/\/ 2\s000 ккал/))
  expect(screen.getByRole('button', { name: 'Вода: подробнее' }).textContent).toContain('0 / 2 л') // nothing drunk yet

  fireEvent.click(screen.getByRole('button', { name: 'Профиль' }))
  fireEvent.click(screen.getByRole('button', { name: 'Салатовая' }))
  expect(document.documentElement.dataset.theme).toBe('green')
  expect(screen.queryByRole('group', { name: 'Акцентный цвет' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Светлая' }))
  expect(document.documentElement.dataset.theme).toBe('light')
  fireEvent.click(screen.getByRole('button', { name: 'Акцент #a98bff' }))
  expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#8462f5')  // light theme: deeper shade of the chosen accent
  expect(document.documentElement.style.getPropertyValue('--accent-text')).toBe('#5a37d6')
  fireEvent.click(screen.getByRole('button', { name: 'Как в Telegram' }))
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#a98bff')
  expect(document.documentElement.style.getPropertyValue('--accent-text')).toBe('')
})
