import { useState } from 'react'
import { INGREDIENTS } from './mealCatalog'
import type { MealPlan } from './mealPrototype'

export default function PlanShopping({ items }: { items: MealPlan['shopping'] }) {
  const [category, setCategory] = useState('')
  const groups = new Map<string, typeof items>()
  for (const item of items) {
    const key = INGREDIENTS[item.productId]?.category ?? 'Другие продукты'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }
  const categories = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ru'))
  const filter = groups.has(category) ? category : ''
  return <details className="meal-result-shopping plan-basket">
    <summary><span><small>На весь период</small><strong>Список продуктов</strong></span>
      <span className="plan-basket-count">{items.length} поз.</span><span className="plan-basket-chevron" aria-hidden="true">⌄</span>
    </summary>
    {categories.length > 1 && <label className="basket-filter">Категория
      <select value={filter} onChange={e => setCategory(e.target.value)}>
        <option value="">Все продукты</option>{categories.map(c => <option key={c}>{c}</option>)}
      </select></label>}
    {categories.filter(c => !filter || c === filter).map(c => <section key={c}><h3>{c}</h3>
      <ul>{groups.get(c)!.map(item => <li key={item.product}><span>{item.product}</span><strong>{item.grams} г</strong></li>)}</ul>
    </section>)}
    <p>Вес указан для продукта в том виде, который обозначен в названии.</p>
  </details>
}
