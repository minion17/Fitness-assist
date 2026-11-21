// The line under the name on Home: a greeting by the time of day and one short fact from the user's own diary.
// Only true things from their data — no made-up comparisons with other users.
export type GreetingInput = {
  hour: number; streak: number; workoutsThisWeek: number; kcalToday: number
  yesterday?: { kcal: number } | null; goal?: number | null; trainingDay?: boolean
}

export function hello(hour: number, name: string): string {
  const part = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер'
  return `${part}, ${name}`
}

const workoutsWord = (n: number) => n % 10 === 1 && n % 100 !== 11 ? 'тренировка' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'тренировки' : 'тренировок'

/** The first fact that applies, most personal first; null when there's nothing worth saying. */
export function insight(g: GreetingInput): string | null {
  if (g.streak >= 7 && g.streak % 7 === 0) return `${g.streak / 7 === 1 ? 'Неделя' : `${g.streak / 7} недели`} без пропусков — это уже привычка`
  if (g.goal && g.yesterday && g.yesterday.kcal > 0 && Math.abs(g.yesterday.kcal - g.goal) <= 0.1 * g.goal) return 'Вчера калории точно в норме — так держать'
  if (g.workoutsThisWeek >= 2) return `Уже ${g.workoutsThisWeek} ${workoutsWord(g.workoutsThisWeek)} на этой неделе`
  if (g.trainingDay && g.hour < 18) return 'Сегодня день тренировки — план уже ждёт'
  if (g.streak >= 3) return `${g.streak} дня подряд с дневником — хороший ритм`.replace(/^(\d+) дня/, (m, n) => (Number(n) % 10 >= 5 || Number(n) % 10 === 0 || (Number(n) % 100 >= 11 && Number(n) % 100 <= 14) ? `${n} дней` : m))
  if (g.kcalToday === 0 && g.hour >= 5 && g.hour < 11) return 'Начни день с завтрака — запись займёт пару секунд'
  return null
}
