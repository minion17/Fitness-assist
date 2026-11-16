import { useEffect, useRef, useState } from 'react'
import type { MealPlan } from './mealPrototype'
import './MealDay.css'
import { useBack } from './back'

type Day = MealPlan['days'][number]
type Meal = Day['meals'][number]
const labels = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин' }

function RecipeCard({ meal, batch, error, onClose, onReplace }: {
  meal: Meal; batch: boolean; error: string; onClose: () => void; onReplace: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    const trigger = document.activeElement
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    return () => {
      if (typeof element.close === 'function') element.close()
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [])
  const steps = meal.instructions.split(/(?:^|\s)\d+\.\s+/).filter(Boolean)
  return <dialog ref={dialog} className="plan-recipe" aria-labelledby="plan-recipe-title"
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === dialog.current) onClose() }}>
    <div className="plan-recipe-scroll">
      <button autoFocus className="plan-recipe-close" aria-label="Закрыть рецепт" onClick={onClose}>×</button>
      <img className="plan-recipe-cover" src={`/images/recipes/${meal.id}.jpg`} alt={`Пример блюда: ${meal.name}`} />
      <div className="plan-recipe-body">
        <span className="plan-slot">{labels[meal.meal]}{meal.portions > 1 && ` · на ${meal.portions} чел.`}</span>
        <h2 id="plan-recipe-title">{meal.name}</h2>
        <dl className="plan-nutrients" aria-label="КБЖУ одной порции">
          {[[meal.nutrition.kcal, 'ккал'], [meal.nutrition.protein_g, 'белки, г'], [meal.nutrition.fat_g, 'жиры, г'], [meal.nutrition.carbs_g, 'углеводы, г']].map(([value, label]) =>
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <section className="meal-result-ingredients"><h3>Ингредиенты на порцию</h3>
          {meal.ingredients.map(i => <div key={i.productId ?? i.product}><span>{i.product}</span><span>{i.grams} г</span></div>)}
        </section>
        <section className="meal-result-steps"><h3>Как приготовить</h3><ol>{steps.map((text, i) => <li key={i}>{text}</li>)}</ol></section>
        <button className="link meal-result-replace" aria-label={`Заменить блюдо ${meal.name}`} onClick={onReplace}>{batch && meal.meal !== 'breakfast' ? 'Заменить во всей партии' : 'Заменить блюдо'} ↻</button>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  </dialog>
}

export default function MealDay({ day, batch, error, onReplace, onBack, onClearError }: {
  day: Day; batch: boolean; error: string; onReplace: (index: number) => void; onBack: () => void; onClearError: () => void
}) {
  useBack(onBack)
  const [active, setActive] = useState<number | null>(null)
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => { title.current?.focus() }, [])
  return <div className="meal-plan">
    <div className="meal-plan-heading"><div><span className="plan-slot">Рацион</span><h1 ref={title} tabIndex={-1}>День {day.day}</h1></div><button className="link" onClick={onBack}>Назад</button></div>
    <p className="plan-day-total">≈ {day.totals.kcal} ккал <span>· Б {day.totals.protein_g} · Ж {day.totals.fat_g} · У {day.totals.carbs_g} г</span></p>
    <div className="plan-day-menu">{day.meals.map((meal, index) =>
      <button className="plan-meal-link" key={meal.meal} aria-label={`Открыть ${labels[meal.meal]} — ${meal.name}`} onClick={() => setActive(index)}>
        <img src={`/images/recipes/${meal.id}.jpg`} alt="" />
        <span className="plan-meal-copy"><span className="plan-slot">{labels[meal.meal]}</span><strong>{meal.name}</strong><small>{meal.nutrition.kcal} ккал{meal.portions > 1 && ` · на ${meal.portions} чел.`}</small></span>
        <span className="plan-arrow" aria-hidden="true">›</span>
      </button>)}</div>
    {active !== null && <RecipeCard meal={day.meals[active]} batch={batch} error={error}
      onClose={() => { setActive(null); onClearError() }} onReplace={() => onReplace(active)} />}
  </div>
}
