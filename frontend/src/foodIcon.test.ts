import { expect, test } from 'vitest'
import { foodIcon } from './foodIcon'

test('food icons by name', () => {
  expect(foodIcon('Овсянка на молоке')).toBe('🥣')
  expect(foodIcon('Куриная грудка')).toBe('🍗')
  expect(foodIcon('Йогурт греческий')).toBe('🥛')
  expect(foodIcon('Пепперони 30 см', 'Пицца')).toBe('🍕')
  expect(foodIcon('Нечто')).toBe('🍽')
})
