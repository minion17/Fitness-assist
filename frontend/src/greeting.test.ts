import { expect, test } from 'vitest'
import { hello, insight } from './greeting'

const base = { hour: 13, streak: 0, workoutsThisWeek: 0, kcalToday: 500 }
test('greeting by the time of day, and one true fact', () => {
  expect(hello(8, 'Егор')).toBe('Доброе утро, Егор')
  expect(hello(21, 'Егор')).toBe('Добрый вечер, Егор')
  expect(insight({ ...base, streak: 14 })).toBe('2 недели без пропусков. Это уже привычка')
  expect(insight({ ...base, goal: 2000, yesterday: { kcal: 1950 } })).toBe('Вчера калории ровно в норме')
  expect(insight({ ...base, workoutsThisWeek: 3 })).toBe('Уже 3 тренировки на этой неделе')
  expect(insight({ ...base, streak: 5 })).toBe('5 дней подряд с дневником')
  expect(insight({ ...base, streak: 3 })).toBe('3 дня подряд с дневником')
  expect(insight({ ...base, hour: 8, kcalToday: 0 })).toBe('Начни с завтрака')
  expect(insight(base)).toBeNull()
})
