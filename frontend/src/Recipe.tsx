// A home dish from catalog products: per 100 g is computed from the ingredients and, if weighed, the cooked pot.
import { useEffect, useState } from 'react'
import { api, postJson } from './telegram'
import type { Product } from './types'

type Macros = { kcal: number; protein_g: number; fat_g: number; carbs_g: number }
type Ing = Macros & { product_id: number; name: string; grams: string }
export type RecipeData = Product & { ingredients: (Macros & { product_id: number; name: string; grams: number })[]; cooked_g: number | null; servings: number | null }

const num = (s: string) => Number(s.replace(',', '.'))

export default function RecipeEditor({ initial, onSaved, onCancel }: {
  initial?: RecipeData | null
  onSaved: (p: Product) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [ings, setIngs] = useState<Ing[]>(initial?.ingredients.map((i) => ({ ...i, grams: String(i.grams) })) ?? [])
  const [cooked, setCooked] = useState(initial?.cooked_g ? String(initial.cooked_g) : '')
  const [servings, setServings] = useState(initial?.servings ? String(initial.servings) : '')
  const [q, setQ] = useState('')
  const [found, setFound] = useState<Product[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (q.trim().length < 2) return
    let stale = false
    const t = setTimeout(() => {
      api<Product[]>(`/api/products/search?q=${encodeURIComponent(q.trim())}&quiet=1`).then((r) => !stale && setFound((r ?? []).slice(0, 6))).catch(() => {})
    }, 300)
    return () => { stale = true; clearTimeout(t) }
  }, [q])

  const raw = ings.reduce((s, i) => s + (num(i.grams) || 0), 0)
  const weight = num(cooked) > 0 ? num(cooked) : raw
  const sum = (k: keyof Macros) => ings.reduce((s, i) => s + (i[k] * (num(i.grams) || 0)) / 100, 0)
  const per100 = (k: keyof Macros) => (weight > 0 ? (sum(k) * 100) / weight : 0)
  const portion = num(servings) >= 1 ? Math.round(weight / Math.round(num(servings))) : null

  function add(p: Product) {
    if (!ings.some((i) => i.product_id === p.id)) {
      setIngs([...ings, { product_id: p.id, name: p.name, grams: String(p.piece_g ?? 100), kcal: p.kcal, protein_g: p.protein_g, fat_g: p.fat_g, carbs_g: p.carbs_g }])
    }
    setQ(''); setFound([])
  }

  async function save() {
    setError('')
    if (!name.trim()) return setError('Назови блюдо')
    if (!ings.length) return setError('Добавь хотя бы один продукт')
    if (ings.some((i) => !(num(i.grams) > 0 && num(i.grams) <= 10000))) return setError('Граммы: от 1 до 10 000')
    if (cooked && !(num(cooked) > 0)) return setError('Вес готового блюда — число в граммах')
    setBusy(true)
    try {
      const body = { name: name.trim(), ingredients: ings.map((i) => ({ product_id: i.product_id, grams: num(i.grams) })),
        cooked_g: cooked ? num(cooked) : null, servings: servings ? Math.round(num(servings)) : null }
      const r = await api<Product>(initial ? `/api/recipes/${initial.id}` : '/api/recipes', { ...postJson(body), method: initial ? 'PUT' : 'POST' })
      if (r) onSaved(r)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Не получилось сохранить')
      setBusy(false)
    }
  }

  return (
    <div className="recipe">
      <p className="sub">Собери блюдо из продуктов — посчитаем КБЖУ на 100 г. Потом записывай его тарелками или граммами.</p>
      <label className="field"><span>Название</span>
        <div className="input-wrap"><input value={name} maxLength={120} placeholder="Например, борщ мамин" onChange={(e) => setName(e.target.value)} /></div>
      </label>
      {ings.map((i, n) => (
        <div className="recipe-ing" key={i.product_id}>
          <span className="recipe-ing-name">{i.name}</span>
          <div className="input-wrap"><input inputMode="decimal" aria-label={`${i.name}, граммы`} value={i.grams}
            onChange={(e) => setIngs(ings.map((x, k) => (k === n ? { ...x, grams: e.target.value } : x)))} /><i>г</i></div>
          <button className="link" aria-label={`Убрать ${i.name}`} onClick={() => setIngs(ings.filter((_, k) => k !== n))}>✕</button>
        </div>
      ))}
      <div className="input-wrap"><input placeholder="+ продукт: свёкла, говядина…" value={q} aria-label="Добавить продукт в рецепт" onChange={(e) => setQ(e.target.value)} /></div>
      {q.trim().length >= 2 && found.length > 0 && (
        <div className="list">
          {found.map((p) => (
            <button className="row row-btn" key={p.id} onClick={() => add(p)}>
              <div className="row-main"><div className="row-title">{p.name}</div><div className="row-sub">{p.brand ? `${p.brand} · ` : ''}{Math.round(p.kcal)} ккал на 100 г</div></div>
              <div className="row-end">+</div>
            </button>
          ))}
        </div>
      )}
      <div className="grid2">
        <label className="field"><span>Вес готового, г</span>
          <div className="input-wrap"><input inputMode="decimal" value={cooked} placeholder={raw ? String(Math.round(raw)) : 'необязательно'} onChange={(e) => setCooked(e.target.value)} /></div>
        </label>
        <label className="field"><span>Порций</span>
          <div className="input-wrap"><input inputMode="numeric" value={servings} placeholder="необязательно" onChange={(e) => setServings(e.target.value)} /></div>
        </label>
      </div>
      <p className="sub">Взвесь кастрюлю с готовым блюдом (без кастрюли) — тогда учтём выкипевшую воду.</p>
      {ings.length > 0 && weight > 0 && (
        <p className="recipe-total"><b>{Math.round(per100('kcal'))} ккал</b> на 100 г · Б {per100('protein_g').toFixed(1)} · Ж {per100('fat_g').toFixed(1)} · У {per100('carbs_g').toFixed(1)}
          {portion && <><br />Порция {portion} г — {Math.round((per100('kcal') * portion) / 100)} ккал</>}</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row-actions">
        <button className="btn" disabled={busy} onClick={save}>{busy ? 'Сохраняем…' : initial ? 'Сохранить' : 'Сохранить рецепт'}</button>
        <button className="btn btn-ghost" onClick={onCancel}>Отмена</button>
      </div>
    </div>
  )
}
