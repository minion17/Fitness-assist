// "Меню ресторана": AI reads dishes with printed nutrition from a menu / delivery-app photo; the user picks what to keep.
// Saved as the user's own products (brand = restaurant); identical entries from 3 users become shared (see backend).
import { useState } from 'react'
import { shrink } from './image'
import { api, ApiError, postJson } from './telegram'
import type { Product } from './types'

type Dish = { name: string; kcal: number; protein_g: number; fat_g: number; carbs_g: number; portion_g: number | null; portion_name: string }
type Menu = { venue: string; items: Dish[]; note: string }

export default function MenuImport({ onPick, onCancel }: { onPick: (p: Product) => void; onCancel: () => void }) {
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
      setChosen(new Set(r.items.map((_, i) => i)))
      if (!r.items.length) setError(r.note || 'Не нашёл блюд с КБЖУ на фото.')
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
        const p = await api<Product & { shared: boolean }>('/api/products', postJson({ ...d, brand: venue.trim() || null }))
        if (p) out.push(p)
      }
      setSaved(out)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось сохранить')
    } finally {
      setBusy('')
    }
  }

  if (saved) {
    return (
      <>
        <p className="row-title strong">Сохранено: {saved.length}. Выберите, что добавить сейчас:</p>
        {saved.some((p) => p.shared) && <p className="sub pos">Спасибо! Часть блюд подтвердили другие пользователи — теперь они доступны всем.</p>}
        <div className="list scroll-list">
          {saved.map((p) => (
            <button className="row row-btn" key={p.id} onClick={() => onPick(p)}>
              <div className="row-main">
                <div className="row-title">{p.name}</div>
                <div className="row-sub">{p.brand ? `${p.brand} · ` : ''}{p.portion_g ? `${p.portion_name ?? 'порция'} ${p.portion_g} г · ` : ''}{Math.round(p.kcal)} ккал на 100 г</div>
              </div>
              <span className="row-end">›</span>
            </button>
          ))}
        </div>
        <button className="link" onClick={onCancel}>Назад к поиску</button>
      </>
    )
  }

  return (
    <>
      <p className="sub">Сфотографируйте меню или карточку блюда в приложении доставки — раскройте «Пищевую ценность», чтобы цифры были видны. Сохраню только то, где КБЖУ напечатаны.</p>
      <label className={busy ? 'btn btn-ghost photo-btn disabled' : 'btn btn-ghost photo-btn'}>
        {busy || (menu ? '📷 Другое фото' : '📷 Сфоткать меню')}
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
                  <div className="row-title">{d.name}</div>
                  <div className="row-sub">{d.portion_g ? `${d.portion_name} ${d.portion_g} г · ` : ''}на 100 г: {Math.round(d.kcal)} ккал · Б {d.protein_g} · Ж {d.fat_g} · У {d.carbs_g}</div>
                </div>
              </label>
            ))}
          </div>
          <p className="sub">Сверьте цифры с фото. Блюда будут видны только вам, пока их не подтвердят ещё двое.</p>
          <button className="btn" disabled={!!busy || chosen.size === 0} onClick={save}>Сохранить выбранные ({chosen.size})</button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="link" onClick={onCancel}>Назад к поиску</button>
    </>
  )
}
