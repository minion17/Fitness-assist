import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MealPlan from './MealPlan'
import { RECIPES } from './mealCatalog'
import { api } from './telegram'

vi.mock('./telegram', () => ({ api: vi.fn(), putJson: (body: unknown) => ({ method: 'PUT', body: JSON.stringify(body) }) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('анкета подбора рациона', () => {
  it('проводит через вопросы и показывает сохранённые ответы', () => {
    render(<MealPlan onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '7 дней' }))
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
    fireEvent.click(screen.getByRole('button', { name: 'Снизить вес' }))
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
    for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
    fireEvent.change(screen.getByLabelText('Аллергии и ограничения'), { target: { value: 'орехи' } })
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
    fireEvent.change(screen.getByLabelText('Продукты, которые нравятся'), { target: { value: 'курица' } })
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть ответы' }))
    expect(screen.getByText('орехи')).toBeTruthy()
    expect(screen.getByText('курица')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Составить рацион' }))
    expect(screen.getByText('Список продуктов')).toBeTruthy()
  })

  it('показывает состав блюд и список продуктов в демонстрации', () => {
    render(<MealPlan onClose={vi.fn()} />)
    for (let i = 0; i < 9; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть ответы' }))
    fireEvent.click(screen.getByLabelText(/у меня нет пищевой аллергии/i))
    fireEvent.click(screen.getByRole('button', { name: 'Составить рацион' }))
    expect(screen.getByRole('button', { name: 'Открыть день 1' })).toBeTruthy()
    expect(screen.getByText('Список продуктов')).toBeTruthy()
    expect(screen.getByText(/Расчёты примерные/i)).toBeTruthy()
  })

  it('загружает и сохраняет ответы в аккаунте', async () => {
    vi.mocked(api).mockImplementation(async (url, options) => url === '/api/meal-plan' ? null : options ? {} : { days: 3, goal: 'weight_loss', allergies: '', liked: 'рис', disliked: '', budget: 3000, current_spend: null })
    render(<MealPlan onClose={vi.fn()} canEdit healthConsent />)
    await waitFor(() => expect(screen.getByRole('button', { name: '3 дня' }).getAttribute('aria-pressed')).toBe('true'))
    for (let i = 0; i < 9; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть ответы' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить ответы' }))
    await waitFor(() => expect(screen.getByText('Ответы сохранены')).toBeTruthy())
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/meal-preferences', expect.objectContaining({ method: 'PUT' }))
  })
})

it('учитывает заполненный профиль в деморежиме и выбранную цель', () => {
  render(<MealPlan onClose={vi.fn()} profile={{ sex: 'male', birth_year: 1995, height_cm: 185, weight_kg: 93, activity: 'very_high', goal: 'maintenance' }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Набрать вес' }))
  for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Посмотреть ответы' }))
  expect(screen.getByText(/ориентир.*4[0-9]{3} ккал/i)).toBeTruthy()
})

it('заменяет блюдо и пересчитывает список продуктов', () => {
  render(<MealPlan onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '1 день' }))
  for (let i = 0; i < 9; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Посмотреть ответы' }))
  fireEvent.click(screen.getByLabelText(/у меня нет пищевой аллергии/i))
  fireEvent.click(screen.getByRole('button', { name: 'Составить рацион' }))
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
  expect(document.getElementById(oldName)?.textContent).not.toBe(originalTitle)
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть рецепт' }))
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
  expect(screen.getByText('Список продуктов').closest('details')?.textContent).not.toBe(shoppingBefore)
})

it('позволяет выбрать семью, совместные приёмы и тип питания', () => {
  render(<MealPlan onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  expect(screen.getByText(/Кто будет есть/)).toBeTruthy()
  fireEvent.change(screen.getByRole('slider', { name: 'Количество человек' }), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  expect(screen.getByText(/приёмы пищи/i)).toBeTruthy()
})

it('учитывает тип питания и общий обед при составлении рациона', () => {
  render(<MealPlan onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '1 день' }))
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.change(screen.getByRole('slider', { name: 'Количество человек' }), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: /Завтрак/ }))
  fireEvent.click(screen.getByRole('button', { name: /Ужин/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Для всей семьи' }))
  for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: /Вегетарианство/ }))
  for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Посмотреть ответы' }))
  fireEvent.click(screen.getByLabelText(/у меня нет пищевой аллергии/i))
  fireEvent.click(screen.getByRole('button', { name: 'Составить рацион' }))
  fireEvent.click(screen.getByRole('button', { name: 'Открыть день 1' }))
  expect(screen.getAllByRole('button', { name: /^открыть/i })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /открыть обед/i }))
  expect(screen.getByText(/обед · на 2 чел/i)).toBeTruthy()
})

it('предлагает выбрать удобную частоту готовки', () => {
  render(<MealPlan onClose={vi.fn()} />)
  for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  expect(screen.getByRole('heading', { name: /как вам удобнее готовить/i })).toBeTruthy()
  expect(screen.getByRole('button', { name: /на несколько дней/i })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /на несколько дней/i }))
  fireEvent.click(screen.getByRole('button', { name: 'На 7 дней' }))
  expect(screen.getByRole('button', { name: 'На 7 дней' }).getAttribute('aria-pressed')).toBe('true')
})

it('сохраняет рацион и открывает его повторно', async () => {
  let stored: unknown = null
  vi.mocked(api).mockImplementation(async (url, options) => {
    if (url === '/api/meal-preferences') return null
    if (url === '/api/meal-plan' && options) { stored = JSON.parse(String(options.body)); return stored }
    return stored
  })
  const view = render(<MealPlan onClose={vi.fn()} canEdit />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Продолжить' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '1 день' }))
  for (let i = 0; i < 9; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Посмотреть ответы' }))
  fireEvent.change(screen.getByLabelText('Свой дневной ориентир, ккал'), { target: { value: '3300' } })
  fireEvent.click(screen.getByLabelText(/у меня нет пищевой аллергии/i))
  fireEvent.click(screen.getByRole('button', { name: 'Составить рацион' }))
  expect(screen.getByText('Ориентир — 3300 ккал в день')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить рацион' }))
  await waitFor(() => expect(screen.getByText('Рацион сохранён в вашем профиле.')).toBeTruthy())
  view.unmount()
  render(<MealPlan onClose={vi.fn()} canEdit />)
  fireEvent.click(await screen.findByRole('button', { name: 'Открыть сохранённый рацион' }))
  expect(screen.getByText('Ориентир — 3300 ккал в день')).toBeTruthy()
  expect(screen.getByText('Список продуктов')).toBeTruthy()
})

it('для одного человека пропускает выбор общих приёмов и возвращается обратно', () => {
  render(<MealPlan onClose={vi.fn()} />)
  for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  expect(screen.getByRole('heading', { name: /как вам удобнее готовить/i })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
  expect(screen.getByRole('slider', { name: 'Количество человек' })).toBeTruthy()
})

it('для семьи предлагает выбрать общие приёмы пищи', () => {
  render(<MealPlan onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.change(screen.getByRole('slider', { name: 'Количество человек' }), { target: { value: '3' } })
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  expect(screen.getByRole('heading', { name: /приёмы пищи/i })).toBeTruthy()
})

it('ползунки сохраняют цель, число людей и обе суммы в анкете', () => {
  render(<MealPlan onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.change(screen.getByRole('slider', { name: 'Цель' }), { target: { value: '2' } })
  expect(screen.getByRole('button', { name: 'Набрать вес' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.change(screen.getByRole('slider', { name: 'Количество человек' }), { target: { value: '2' } })
  for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.change(screen.getByRole('slider', { name: 'Желаемый бюджет' }), { target: { value: '8000' } })
  fireEvent.change(screen.getByRole('slider', { name: 'Сколько тратите сейчас' }), { target: { value: '5000' } })
  for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Посмотреть ответы' }))
  expect(screen.getByText('8000 ₽')).toBeTruthy()
  expect(screen.getByText('5000 ₽ в неделю')).toBeTruthy()
  expect(screen.getByText('Набрать вес')).toBeTruthy()
})

it('каждая карточка вкуса показывает изображение соответствующего блюда', () => {
  render(<MealPlan onClose={vi.fn()} />)
  for (let i = 0; i < 7; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  for (const recipe of RECIPES) {
    const image = screen.getByRole('img', { name: `Пример блюда: ${recipe.name}` })
    expect(image.getAttribute('src')).toBe(`/images/recipes/${recipe.id}.jpg`)
    fireEvent.click(screen.getByRole('button', { name: 'Нравится' }))
  }
  expect(screen.getByText('Вы оценили все блюда.')).toBeTruthy()
})

it('открывает отдельный день и карточку блюда, затем возвращается к списку дней', () => {
  render(<MealPlan onClose={vi.fn()} />)
  for (let i = 0; i < 9; i++) fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Посмотреть ответы' }))
  fireEvent.click(screen.getByLabelText(/у меня нет пищевой аллергии/i))
  fireEvent.click(screen.getByRole('button', { name: 'Составить рацион' }))
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
