/// <reference types="node" />
import { existsSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MealPlan from './MealPlan'
import { RECIPE_PHOTOS, RECIPES } from './mealCatalog'
import { api } from './telegram'

vi.mock('./telegram', () => ({ api: vi.fn(), putJson: (body: unknown) => ({ method: 'PUT', body: JSON.stringify(body) }) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
/** Through the remaining questions to the review screen. */
function toReview() {
  for (let i = 0; i < 12 && !screen.queryByRole('button', { name: 'Посмотреть ответы' }); i++) next()
  fireEvent.click(screen.getByRole('button', { name: 'Посмотреть ответы' }))
}
function build() {
  toReview()
  fireEvent.click(screen.getByLabelText(/у меня нет пищевой аллергии/i))
  fireEvent.click(screen.getByRole('button', { name: 'Составить рацион' }))
}

describe('анкета подбора рациона', () => {
  it('проводит через вопросы и показывает ответы для проверки', () => {
    render(<MealPlan onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '7 дней' }))
    next()
    fireEvent.click(screen.getByRole('button', { name: 'Снизить вес' }))
    for (let i = 0; i < 12 && !screen.queryByLabelText('Что не ешь'); i++) next()
    fireEvent.change(screen.getByLabelText('Что не ешь'), { target: { value: 'грибы' } })
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть ответы' }))
    expect(screen.getByText('грибы')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Аллергии и ограничения'), { target: { value: 'орехи' } })
    fireEvent.click(screen.getByRole('button', { name: 'Составить рацион' }))
    expect(screen.getByText('Список продуктов')).toBeTruthy()
    expect(screen.getByText(/Продукты ≈ .* ₽ на весь срок/)).toBeTruthy()
  })

  it('показывает состав блюд и список продуктов в демонстрации', () => {
    render(<MealPlan onClose={vi.fn()} />)
    build()
    expect(screen.getByRole('button', { name: 'Открыть день 1' })).toBeTruthy()
    expect(screen.getByText('Список продуктов')).toBeTruthy()
    expect(screen.getByText(/Расчёты и цены примерные/i)).toBeTruthy()
  })

  it('загружает и сохраняет ответы в аккаунте', async () => {
    vi.mocked(api).mockImplementation(async (url, options) => url === '/api/meal-plan' ? null : options ? {} : { days: 3, goal: 'weight_loss', allergies: '', liked: 'рис', disliked: '', budget: 3000, current_spend: null })
    render(<MealPlan onClose={vi.fn()} canEdit healthConsent />)
    await waitFor(() => expect(screen.getByRole('button', { name: '3 дня' }).getAttribute('aria-pressed')).toBe('true'))
    toReview()
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить ответы' }))
    await waitFor(() => expect(screen.getByText('Ответы сохранены')).toBeTruthy())
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/meal-preferences', expect.objectContaining({ method: 'PUT' }))
  })
})

it('не спрашивает то, что есть в профиле, а цель меняется на проверке', () => {
  render(<MealPlan onClose={vi.fn()} profile={{ sex: 'male', birth_year: 1995, height_cm: 185, weight_kg: 93, activity: 'very_high', goal: 'maintenance' }} />)
  expect(screen.getByText('Шаг 1 из 6')).toBeTruthy() // no goal, no sex
  toReview()
  fireEvent.click(screen.getByRole('button', { name: 'Набрать вес' }))
  expect(screen.getByText(/ориентир.*4[0-9]{3} ккал/i)).toBeTruthy()
})

it('заменяет блюдо на выбранное и пересчитывает список продуктов', () => {
  render(<MealPlan onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '1 день' }))
  build()
  const basket = screen.getByText('Список продуктов').closest('details')!
  expect(basket.open).toBe(false)
  fireEvent.click(basket.querySelector('summary')!)
  const category = screen.getByRole('combobox', { name: 'Категория' })
  fireEvent.change(category, { target: { value: 'Крупы и гарниры' } })
  expect(basket.querySelectorAll('section')).toHaveLength(1)
  fireEvent.change(category, { target: { value: '' } })
  const shoppingBefore = screen.getByText('Список продуктов').closest('details')?.textContent
  fireEvent.click(screen.getByRole('button', { name: 'Открыть день 1' }))
  fireEvent.click(screen.getByRole('button', { name: /открыть завтрак/i }))
  const oldName = screen.getByRole('dialog').getAttribute('aria-labelledby')!
  const originalTitle = document.getElementById(oldName)?.textContent
  fireEvent.click(screen.getByRole('button', { name: /заменить блюдо/i }))
  const choices = within(screen.getByRole('region', { name: 'Чем заменить' })).getAllByRole('button').filter(b => b.className === 'replace-choice')
  expect(choices).toHaveLength(3)
  const picked = choices[1].querySelector('strong')!.textContent
  fireEvent.click(choices[1])
  expect(document.getElementById(oldName)?.textContent).toBe(picked)
  expect(picked).not.toBe(originalTitle)
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть рецепт' }))
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
  expect(screen.getByText('Список продуктов').closest('details')?.textContent).not.toBe(shoppingBefore)
})

it('позволяет выбрать семью, совместные приёмы и тип питания', () => {
  render(<MealPlan onClose={vi.fn()} />)
  next(); next()
  expect(screen.getByText(/Кто будет есть/)).toBeTruthy()
  fireEvent.change(screen.getByRole('slider', { name: 'Количество человек' }), { target: { value: '2' } })
  next()
  expect(screen.getByText(/приёмы пищи/i)).toBeTruthy()
})

it('учитывает тип питания и общий обед при составлении рациона', () => {
  render(<MealPlan onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '1 день' }))
  next(); next()
  fireEvent.change(screen.getByRole('slider', { name: 'Количество человек' }), { target: { value: '2' } })
  next()
  fireEvent.click(screen.getByRole('button', { name: /Завтрак/ }))
  fireEvent.click(screen.getByRole('button', { name: /Ужин/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Для всей семьи' }))
  for (let i = 0; i < 6 && !screen.queryByRole('button', { name: /Вегетарианство/ }); i++) next()
  fireEvent.click(screen.getByRole('button', { name: /Вегетарианство/ }))
  build()
  fireEvent.click(screen.getByRole('button', { name: 'Открыть день 1' }))
  expect(screen.getAllByRole('button', { name: /^открыть/i })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /открыть обед/i }))
  expect(screen.getByText(/обед · на 2 чел/i)).toBeTruthy()
})

it('предлагает выбрать удобную частоту готовки', () => {
  render(<MealPlan onClose={vi.fn()} />)
  for (let i = 0; i < 3; i++) next()
  expect(screen.getByRole('heading', { name: /как тебе удобнее готовить/i })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /на несколько дней/i }))
  fireEvent.click(screen.getByRole('button', { name: 'На 7 дней' }))
  expect(screen.getByRole('button', { name: 'На 7 дней' }).getAttribute('aria-pressed')).toBe('true')
})

it('сохраняет рацион, открывает его повторно и составляет следующий', async () => {
  let stored: unknown = null
  vi.mocked(api).mockImplementation(async (url, options) => {
    if (url === '/api/meal-preferences') return null
    if (url === '/api/meal-plan' && options) { stored = JSON.parse(String(options.body)); return stored }
    return stored
  })
  const view = render(<MealPlan onClose={vi.fn()} canEdit />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Продолжить' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '1 день' }))
  toReview()
  fireEvent.change(screen.getByLabelText('Свой дневной ориентир, ккал'), { target: { value: '3300' } })
  fireEvent.click(screen.getByLabelText(/у меня нет пищевой аллергии/i))
  fireEvent.click(screen.getByRole('button', { name: 'Составить рацион' }))
  expect(screen.getByText('Ориентир — 3300 ккал в день')).toBeTruthy()
  expect(screen.getByText(/Добавили перекус/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить и использовать рацион' }))
  await waitFor(() => expect(screen.getByText('Рацион сохранён в твоём профиле.')).toBeTruthy())
  view.unmount()
  render(<MealPlan onClose={vi.fn()} canEdit />)
  fireEvent.click(await screen.findByRole('button', { name: 'Открыть сохранённый рацион' }))
  expect(screen.getByText('Ориентир — 3300 ккал в день')).toBeTruthy()
  const before = screen.getByRole('button', { name: 'Открыть день 1' }).textContent
  fireEvent.click(screen.getByRole('button', { name: 'Составить следующий рацион' }))
  expect(screen.getByRole('button', { name: 'Открыть день 1' }).textContent).not.toBe(before)
  expect(screen.getByRole('button', { name: 'Сохранить и использовать рацион' })).toBeTruthy()
})

it('для одного человека пропускает выбор общих приёмов и возвращается обратно', () => {
  render(<MealPlan onClose={vi.fn()} />)
  for (let i = 0; i < 3; i++) next()
  expect(screen.getByRole('heading', { name: /как тебе удобнее готовить/i })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
  expect(screen.getByRole('slider', { name: 'Количество человек' })).toBeTruthy()
})

it('для семьи предлагает выбрать общие приёмы пищи', () => {
  render(<MealPlan onClose={vi.fn()} />)
  next(); next()
  fireEvent.change(screen.getByRole('slider', { name: 'Количество человек' }), { target: { value: '3' } })
  next()
  expect(screen.getByRole('heading', { name: /приёмы пищи/i })).toBeTruthy()
})

it('ползунки сохраняют цель, число людей и обе суммы в анкете', () => {
  render(<MealPlan onClose={vi.fn()} />)
  next()
  fireEvent.change(screen.getByRole('slider', { name: 'Цель' }), { target: { value: '2' } })
  expect(screen.getByRole('button', { name: 'Набрать вес' }).getAttribute('aria-pressed')).toBe('true')
  next()
  fireEvent.change(screen.getByRole('slider', { name: 'Количество человек' }), { target: { value: '2' } })
  for (let i = 0; i < 3; i++) next()
  fireEvent.change(screen.getByRole('slider', { name: 'Желаемый бюджет' }), { target: { value: '8000' } })
  fireEvent.change(screen.getByRole('slider', { name: 'Сколько тратишь сейчас' }), { target: { value: '5000' } })
  toReview()
  expect(screen.getByText('8000 ₽')).toBeTruthy()
  expect(screen.getByText('5000 ₽ в неделю')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Набрать вес' }).getAttribute('aria-pressed')).toBe('true')
})

it('каждая карточка вкуса показывает фото блюда, а блюдо без фото — значок', () => {
  render(<MealPlan onClose={vi.fn()} />)
  for (let i = 0; i < 12 && !screen.queryByLabelText('Что не ешь'); i++) next()
  for (const recipe of RECIPES) {
    const image = screen.getByRole('img', { name: `Пример блюда: ${recipe.name}` })
    const photo = RECIPE_PHOTOS.has(recipe.id)
    expect(existsSync(`public/images/recipes/${recipe.id}.jpg`)).toBe(photo) // the list matches the files
    if (photo) expect(image.getAttribute('src')).toBe(`/images/recipes/${recipe.id}.jpg`)
  }
  expect(RECIPES.filter(r => r.meal === 'snack').length).toBeGreaterThanOrEqual(6)
  // a tap marks, a second tap unmarks
  const tile = screen.getByRole('button', { name: new RegExp(RECIPES[0].name) })
  fireEvent.click(tile)
  expect(tile.getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText('Отмечено: 1')).toBeTruthy()
  fireEvent.click(tile)
  expect(tile.getAttribute('aria-pressed')).toBe('false')
})

it('открывает отдельный день и карточку блюда, затем возвращается к списку дней', () => {
  render(<MealPlan onClose={vi.fn()} />)
  build()
  fireEvent.click(screen.getByRole('button', { name: /открыть день 1/i }))
  expect(screen.getByRole('heading', { name: 'День 1' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /открыть завтрак/i }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByText('Ингредиенты на порцию')).toBeTruthy()
  expect(screen.getByText('Как приготовить')).toBeTruthy()
  expect(screen.getByRole('img', { name: /пример блюда/i })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть рецепт' }))
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
  expect(screen.getByRole('button', { name: /открыть день 1/i })).toBeTruthy()
})
