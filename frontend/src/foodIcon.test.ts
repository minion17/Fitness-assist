import { expect, test } from 'vitest'
import { emojiSrc, foodIcon } from './foodIcon'

test('food icons by name', () => {
  expect(foodIcon('Овсянка на молоке')).toBe('🥣')
  expect(foodIcon('Куриная грудка')).toBe('🍗')
  expect(foodIcon('Йогурт греческий')).toBe('🥛')
  expect(foodIcon('Пепперони 30 см', 'Пицца')).toBe('🍕')
  expect(foodIcon('Нечто')).toBe('🍽')
  expect(foodIcon('Гречка')).toBe('🥣')
  expect(foodIcon('Рис варёный')).toBe('🍚')
  expect(emojiSrc('🍽')).toMatch(/emoji\/1f37d\.svg$/)
  expect(emojiSrc('☕')).toMatch(/emoji\/2615\.svg$/)
})
