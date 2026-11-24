// "Меню ресторана": AI reads dishes from a menu / delivery-app photo (printed nutrition, or an estimate marked ≈);
// the user sees what fits the calories left and picks what to keep. Saved as the user's own products (brand = restaurant);
// identical printed entries from 3 users become shared (see backend). Estimates are saved without the brand: never shared.
import { useState } from 'react'
import { shrink } from './image'
import { api, ApiError, postJson } from './telegram'
import type { Product } from './types'
import { Chevron } from './ui'

type Dish = { name: string; kcal: number; protein_g: number; fat_g: number; carbs_g: number; portion_g: number | null; portion_name: string; estimated?: boolean }
type Menu = { venue: string; items: Dish[]; note: string }

/** How a dish fits what's left of the day: "влезает" / "почти весь остаток" / "больше остатка". */
export function fitLabel(d: Dish, kcalLeft: number | undefined): { text: string; cls: string } | null {
  if (kcalLeft === undefined || !d.portion_g) return null
  const k = (d.kcal * d.portion_g) / 100
  if (k <= kcalLeft * 0.6) return { text: 'влезает', cls: 'fit-ok' }
  if (k <= kcalLeft * 1.05) return { text: 'почти весь остаток', cls: 'fit-mid' }
  return { text: 'больше остатка', cls: 'fit-over' }
}

export default function MenuImport({ onPick, onCancel, kcalLeft }: { onPick: (p: Product) => void; onCancel: () => void; kcalLeft?: number }) {
  const [menu, setMenu] = useState<Menu | null>(null)
  const [venue, setVenue] = useState('')
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [saved, setSaved] = useState<(Product & { shared?: boolean })[] | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  async function read(file?: File) {
    if (!file) return
    setBusy('Читаю меню…')
    setError('')
    try {
      const form = new FormData()
      form.append('file', await shrink(file, 1800).catch(() => file), 'menu.jpg')
      const r = await api<Menu>('/api/ai/menu', { method: 'POST', body: form })
      if (!r) return
      setMenu(r)
      setVenue(r.venue)
      setChosen(new Set(r.items.map((d, i) => (d.estimated ? -1 : i)).filter((i) => i >= 0))) // estimates: only if picked
      if (!r.items.length) setError(r.note || 'Не нашёл блюд на фото.')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось прочитать меню')
    } finally {
      setBusy('')
    }
  }

  async function save() {
    if (!menu) return
    setBusy('Сохраняю…')
    setError('')
    try {
      const out = []
      for (const i of [...chosen].sort((a, b) => a - b)) {
        const d = menu.items[i]
        const { estimated, ...dish } = d
        const p = await api<Product & { shared: boolean }>('/api/products', postJson({ ...dish, brand: estimated ? null : venue.trim() || null }))
        if (p) out.push(p)
      }
      setSaved(out)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не сохранилось. Попробуй ещё раз')
    } finally {
      setBusy('')
    }
  }

  if (saved) {
    return (
      <>
        <p className="row-title strong">Сохранено: {saved.length}. Выбери, что добавить сейчас:</p>
        {saved.some((p) => p.shared) && <p className="sub pos">Спасибо! Часть блюд подтвердили другие, теперь они есть у всех.</p>}
        <div className="list scroll-list">
          {saved.map((p) => (
            <button className="row row-btn" key={p.id} onClick={() => onPick(p)}>
              <div className="row-main">
                <div className="row-title">{p.name}</div>
                <div className="row-sub">{p.brand ? `${p.brand} · ` : ''}{p.portion_g ? `${p.portion_name ?? 'порция'} ${p.portion_g} г · ` : ''}{Math.round(p.kcal)} ккал на 100 г</div>
              </div>
              <span className="row-end" aria-hidden="true"><Chevron dir="right" /></span>
            </button>
          ))}
        </div>
        <button className="link" onClick={onCancel}>Назад к поиску</button>
      </>
    )
  }

  return (
    <>
      <p className="sub">Сфотографируй меню или карточку блюда в приложении доставки. КБЖУ возьму с фото, а где их нет, оценю по обычному рецепту (≈). Подскажу, что влезает в остаток дня.</p>
      <label className={busy ? 'btn btn-ghost photo-btn disabled' : 'btn btn-ghost photo-btn'}>
        {busy || (menu ? 'Другое фото' : 'Сфоткать меню')}
        <input type="file" accept="image/*" hidden disabled={!!busy} onChange={(e) => { read(e.target.files?.[0]); e.target.value = '' }} />
      </label>
      {menu && menu.items.length > 0 && (
        <>
          <label className="field">
            <span>Заведение</span>
            <div className="input-wrap"><input value={venue} placeholder="Например, Додо Пицца" onChange={(e) => setVenue(e.target.value)} /></div>
          </label>
          <div className="list scroll-list">
            {menu.items.map((d, i) => (
              <label className="row row-btn check-row" key={i}>
                <input type="checkbox" checked={chosen.has(i)}
                  onChange={() => setChosen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })} />
                <div className="row-main">
                  <div className="row-title">{d.name}{(() => { const f = fitLabel(d, kcalLeft); return f && <span className={`fit-tag ${f.cls}`}>{f.text}</span> })()}</div>
                  <div className="row-sub">{d.portion_g ? `${d.portion_name} ${d.portion_g} г — ${d.estimated ? '≈' : ''}${Math.round((d.kcal * d.portion_g) / 100)} ккал · ` : ''}на 100 г: {d.estimated ? '≈' : ''}{Math.round(d.kcal)} ккал · Б {d.protein_g} · Ж {d.fat_g} · У {d.carbs_g}</div>
                </div>
              </label>
            ))}
          </div>
          <p className="sub">Сверь цифры с фото. Блюда будут видны только тебе, пока их не подтвердят ещё двое.{menu.items.some((d) => d.estimated) ? ' ≈ — оценка: КБЖУ не напечатаны, такие блюда видны только тебе.' : ''}</p>
          <button className="btn" disabled={!!busy || chosen.size === 0} onClick={save}>Сохранить выбранные ({chosen.size})</button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="link" onClick={onCancel}>Назад к поиску</button>
    </>
  )
}
