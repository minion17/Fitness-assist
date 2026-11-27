import { useState } from 'react'
import { haptic } from './haptics'
import { INGREDIENTS, PIECES } from './mealCatalog'
import type { MealPlan } from './mealPrototype'
import { api, postJson } from './telegram'
import { Chevron } from './ui'

const weight = (g: number) => (g >= 1000 ? `${(Math.round(g / 100) / 10).toString().replace('.', ',')} кг` : `${Math.round(g)} г`)
/** Eggs and fruit by the piece («12 шт»), the rest by weight. */
const qty = (id: string, g: number) => (PIECES[id] ? `${Math.max(1, Math.ceil(g / PIECES[id] - .15))} шт` : weight(g))

/** The list goes to a chat as one message with a button per item: in the family group whoever buys it ticks it off. */
function ShareList({ items, title }: { items: MealPlan['shopping']; title: string }) {
  const [chats, setChats] = useState<{ id: number; title: string }[] | null>(null)
  const [sent, setSent] = useState('')
  const [error, setError] = useState('')
  const open = () => api<{ id: number; title: string }[]>('/api/shopping/chats').then((r) => setChats(r ?? [])).catch(() => setError('Нет связи. Попробуй ещё раз'))
  const send = (groupId: number | null, where: string) => {
    haptic('success')
    setError('')
    api('/api/shopping/share', postJson({ group_id: groupId, title, items: items.slice(0, 90).map((i) => ({ name: i.product.slice(0, 60), qty: qty(i.productId, i.grams) })) }))
      .then(() => setSent(where)).catch(() => setError('Не отправилось. Попробуй ещё раз'))
  }
  if (sent) return <p className="sub pos" role="status">Список отправлен {sent}. Купленное отмечают прямо в сообщении, список обновится у всех.</p>
  if (!chats) return <><button className="btn btn-ghost share-list" onClick={open}>Отправить список в чат</button>{error && <p className="error" role="alert">{error}</p>}</>
  return (
    <div className="share-list-to">
      <p className="sub">Куда отправить? Покупки отмечаются кнопками прямо в сообщении.</p>
      {chats.map((c) => <button key={c.id} className="btn btn-ghost" onClick={() => send(c.id, `в чат «${c.title}»`)}>{c.title}</button>)}
      <button className="btn btn-ghost" onClick={() => send(null, 'тебе в чат с Nextly')}>Себе в чат с Nextly</button>
      {!chats.length && <p className="sub">Чтобы покупать вместе с семьёй, добавь Nextly в общий чат (команда /group в боте) и нажмите там «Участвую».</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}

/** Sections in the order of a walk through a supermarket: produce at the door, chilled meat and fish at the back. */
const AISLES = ['Овощи', 'Фрукты и ягоды', 'Хлеб и выпечка', 'Крупы и гарниры', 'Бобовые', 'Масла и соусы', 'Соусы и приправы',
  'Орехи и семена', 'Сухофрукты', 'Молочные продукты', 'Яйца', 'Мясо и птица', 'Рыба и морепродукты']
const aisle = (c: string) => { const i = AISLES.indexOf(c); return i < 0 ? AISLES.length : i }

export default function PlanShopping({ items: all, canShare = false, days, home = new Set(), onHome }: {
  items: MealPlan['shopping']; canShare?: boolean; days?: number
  home?: ReadonlySet<string>; onHome?: (productId: string) => void // what's already at home: off the bill and the shared list
}) {
  const [category, setCategory] = useState('')
  const items = all.filter(i => !home.has(i.productId))
  const groups = new Map<string, typeof all>()
  for (const item of all) {
    const key = INGREDIENTS[item.productId]?.category ?? 'Другие продукты'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }
  const categories = [...groups.keys()].sort((a, b) => aisle(a) - aisle(b) || a.localeCompare(b, 'ru'))
  const filter = groups.has(category) ? category : ''
  return <><details className="meal-result-shopping plan-basket">
    <summary><span><small>На весь период</small><strong>Список продуктов</strong></span>
      <span className="plan-basket-count">{items.length} поз.{all.length > items.length ? ` · ${all.length - items.length} дома` : ''}</span><span className="plan-basket-chevron" aria-hidden="true"><Chevron /></span>
    </summary>
    {onHome && <p className="sub">Отметь, что уже есть дома: уберём из суммы и из списка для чата.</p>}
    {categories.length > 1 && <label className="basket-filter">Категория
      <select value={filter} onChange={e => setCategory(e.target.value)}>
        <option value="">Все продукты</option>{categories.map(c => <option key={c}>{c}</option>)}
      </select></label>}
    {categories.filter(c => !filter || c === filter).map(c => <section key={c}><h3>{c}</h3>
      <ul>{groups.get(c)!.map(item => {
        const have = home.has(item.productId)
        return <li key={item.product} className={have ? 'at-home' : undefined}>
          {onHome ? <label><input type="checkbox" checked={have} onChange={() => onHome(item.productId)} aria-label={`${item.product}: есть дома`} />{item.product}</label> : <span>{item.product}</span>}
          <strong>{have ? 'дома' : qty(item.productId, item.grams)}</strong></li>
      })}</ul>
    </section>)}
    <p>Вес — для сырых продуктов, как в магазине. Яйца и фрукты — в штуках.</p>
  </details>
  {canShare && items.length > 0 && <ShareList items={items} title={days ? `Покупки на ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}` : 'Список покупок'} />}
  </>
}
