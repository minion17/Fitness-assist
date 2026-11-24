import { useState } from 'react'
import { haptic } from './haptics'
import { INGREDIENTS } from './mealCatalog'
import type { MealPlan } from './mealPrototype'
import { api, postJson } from './telegram'
import { Chevron } from './ui'

const qty = (g: number) => (g >= 1000 ? `${(Math.round(g / 100) / 10).toString().replace('.', ',')} кг` : `${Math.round(g)} г`)

/** The list goes to a chat as one message with a button per item: in the family group whoever buys it ticks it off. */
function ShareList({ items, title }: { items: MealPlan['shopping']; title: string }) {
  const [chats, setChats] = useState<{ id: number; title: string }[] | null>(null)
  const [sent, setSent] = useState('')
  const [error, setError] = useState('')
  const open = () => api<{ id: number; title: string }[]>('/api/shopping/chats').then((r) => setChats(r ?? [])).catch(() => setError('Нет связи. Попробуй ещё раз'))
  const send = (groupId: number | null, where: string) => {
    haptic('success')
    setError('')
    api('/api/shopping/share', postJson({ group_id: groupId, title, items: items.slice(0, 90).map((i) => ({ name: i.product.slice(0, 60), qty: qty(i.grams) })) }))
      .then(() => setSent(where)).catch(() => setError('Не отправилось. Попробуй ещё раз'))
  }
  if (sent) return <p className="sub pos" role="status">Список отправлен {sent}. Купленное отмечают прямо в сообщении, список обновится у всех.</p>
  if (!chats) return <><button className="btn btn-ghost share-list" onClick={open}>Отправить список в чат</button>{error && <p className="error" role="alert">{error}</p>}</>
  return (
    <div className="share-list-to">
      <p className="sub">Куда отправить? Покупки отмечаются кнопками прямо в сообщении.</p>
      {chats.map((c) => <button key={c.id} className="btn btn-ghost" onClick={() => send(c.id, `в чат «${c.title}»`)}>{c.title}</button>)}
      <button className="btn btn-ghost" onClick={() => send(null, 'тебе в чат с Setly')}>Себе в чат с Setly</button>
      {!chats.length && <p className="sub">Чтобы покупать вместе с семьёй, добавь Setly в общий чат (команда /group в боте) и нажмите там «Участвую».</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}

export default function PlanShopping({ items, canShare = false, days }: { items: MealPlan['shopping']; canShare?: boolean; days?: number }) {
  const [category, setCategory] = useState('')
  const groups = new Map<string, typeof items>()
  for (const item of items) {
    const key = INGREDIENTS[item.productId]?.category ?? 'Другие продукты'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }
  const categories = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ru'))
  const filter = groups.has(category) ? category : ''
  return <><details className="meal-result-shopping plan-basket">
    <summary><span><small>На весь период</small><strong>Список продуктов</strong></span>
      <span className="plan-basket-count">{items.length} поз.</span><span className="plan-basket-chevron" aria-hidden="true"><Chevron /></span>
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
  {canShare && items.length > 0 && <ShareList items={items} title={days ? `Покупки на ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}` : 'Список покупок'} />}
  </>
}
