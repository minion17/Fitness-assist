// Demo data for stage 1. Replaced by API data in the next stages.
export const nutrition = {
  calories: { eaten: 1640, goal: 2400 },
  macros: [
    { key: 'Белки', eaten: 112, goal: 160, color: 'var(--protein)' },
    { key: 'Жиры', eaten: 54, goal: 80, color: 'var(--fat)' },
    { key: 'Углеводы', eaten: 168, goal: 260, color: 'var(--carbs)' },
  ],
  meals: [
    { name: 'Завтрак', time: '08:30', kcal: 520, items: 'Овсянка, банан, кофе' },
    { name: 'Обед', time: '13:15', kcal: 780, items: 'Курица, рис, овощи' },
    { name: 'Перекус', time: '16:40', kcal: 340, items: 'Творог, орехи' },
  ],
}

export const workout = {
  program: 'Фулбади · 3 раза в неделю',
  week: 2,
  today: 'Тренировка A',
  exercises: [
    { name: 'Приседания со штангой', sets: '4 × 8', weight: '70 кг' },
    { name: 'Жим лёжа', sets: '4 × 8', weight: '55 кг' },
    { name: 'Тяга в наклоне', sets: '3 × 10', weight: '45 кг' },
    { name: 'Планка', sets: '3 × 45 с', weight: '—' },
  ],
  history: [
    { date: '26 окт', name: 'Тренировка B', duration: '52 мин' },
    { date: '24 окт', name: 'Тренировка A', duration: '48 мин' },
    { date: '22 окт', name: 'Тренировка B', duration: '55 мин' },
  ],
}

export const progress = { weight: 78.4, delta: -1.2, workoutsThisWeek: 2, workoutsGoal: 3 }

export const profile = {
  age: 27,
  height: 182,
  weight: 78.4,
  goal: 'Снижение веса',
  body: [
    { label: 'Талия', value: '84 см' },
    { label: 'Грудь', value: '101 см' },
    { label: 'Бёдра', value: '97 см' },
    { label: '% жира', value: '17 %' },
  ],
}
