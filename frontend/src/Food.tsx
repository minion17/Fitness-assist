import { useEffect, useState } from 'react'
import type { Targets } from './profile'
import AiMeal from './AiMeal'
import type { FoodIntent } from './Home'
import { api, publicGet } from './telegram'
import { MEALS, mealNow, type FoodDay, type MealType, type Product } from './types'
import { Bar, Ring, Sheet } from './ui'

const DEFAULT_GOALS: Targets = { calories: 2000, protein: 120, fat: 70, carbs: 230 }
const MACROS = [
  { label: 'Белки', key: 'protein_g', goal: 'protein', color: 'var(--protein)' },
  { label: 'Жиры', key: 'fat_g', goal: 'fat', color: 'var(--fat)' },
  { label: 'Углеводы', key: 'carbs_g', goal: 'carbs', color: 'var(--carbs)' },
] as const

const r1 = (n: number) => Math.round(n * 10) / 10

export default function Food({ day, targets, canEdit, onAdd, onDelete, aiEnabled = false, onAiDone = async () => {}, intent = null }: {
  day: FoodDay
  targets?: Targets
  canEdit: boolean
  onAdd: (productId: number, grams: number, meal: MealType) => Promise<void>
  onDelete: (id: number) => Promise<void>
  aiEnabled?: boolean
  onAiDone?: (xp: number) => Promise<void>
  intent?: FoodIntent | null // shortcut from Home: open the matching sheet right away
}) {
  const goals = targets ?? DEFAULT_GOALS
  const [adding, setAdding] = useState<MealType | null>(intent === 'search' ? mealNow() : null)
  const [confirm, setConfirm] = useState<number | null>(null)
  const [aiMode, setAiMode] = useState<'text' | 'photo' | null>(intent === 'search' ? null : intent)
  const t = day.totals

  return (
    <>
      <h1>Питание</h1>
      <section className="card">
        <div className="card-head"><h2>КБЖУ за сегодня</h2><span className="sub">{Math.round(t.kcal)} / {goals.calories}</span></div>
        <div className="ring-wrap">
          <Ring value={t.kcal} goal={goals.calories} />
          <div className="macros">
            {MACROS.map((m) => (
              <div key={m.key}>
                <div className="macro-row"><span>{m.label}</span><span>{Math.round(t[m.key])} / {goals[m.goal]} г</span></div>
                <Bar value={t[m.key]} goal={goals[m.goal]} color={m.color} />
              </div>
            ))}
          </div>
        </div>
        {!targets && <span className="sub">Ориентир по умолчанию — заполните анкету в профиле, чтобы получить свою норму.</span>}
      </section>
      {canEdit && <button className="btn" onClick={() => setAdding(mealNow())}>+ Добавить продукт</button>}
      {canEdit && aiEnabled && (
        <div className="ai-row">
          <button className="btn btn-ghost" onClick={() => setAiMode('text')}>✨ Текстом</button>
          <button className="btn btn-ghost" onClick={() => setAiMode('photo')}>📷 Фото</button>
        </div>
      )}

      {(Object.keys(MEALS) as MealType[]).map((meal) => {
        const items = day.items.filter((i) => i.meal_type === meal)
        const kcal = items.reduce((s, i) => s + i.kcal, 0)
        return (
          <section className="card" key={meal}>
            <div className="card-head">
              <h2>{MEALS[meal]}</h2>
              <span className="sub">{items.length ? `${Math.round(kcal)} ккал` : ''}</span>
            </div>
            {items.length > 0 && (
              <div className="list">
                {items.map((i) => (
                  <div className="row" key={i.id}>
                    <div className="row-main">
                      <div className="row-title">{i.product.name}</div>
                      <div className="row-sub">{i.amount_g} г · Б {r1(i.protein_g)} · Ж {r1(i.fat_g)} · У {r1(i.carbs_g)}</div>
                    </div>
                    {confirm === i.id ? (
                      <div className="confirm">
                        <button className="link danger" onClick={() => onDelete(i.id).finally(() => setConfirm(null))}>Удалить</button>
                        <button className="link" onClick={() => setConfirm(null)}>Отмена</button>
                      </div>
                    ) : (
                      <>
                        <div className="row-end">{Math.round(i.kcal)} ккал</div>
                        {canEdit && <button className="icon-btn" aria-label={`Удалить ${i.product.name}`} onClick={() => setConfirm(i.id)}>✕</button>}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {canEdit && <button className="link add-link" onClick={() => setAdding(meal)}>+ Добавить</button>}
          </section>
        )
      })}
      {!canEdit && <p className="sub">Демо-режим: чтобы вести дневник, откройте приложение из Telegram.</p>}
      {aiMode && <AiMeal mode={aiMode} onClose={() => setAiMode(null)} onDone={onAiDone} />}
      {adding && <AddFood meal={adding} onClose={() => setAdding(null)} onAdd={onAdd} />}
    </>
  )
}

function AddFood({ meal: initialMeal, onClose, onAdd }: {
  meal: MealType
  onClose: () => void
  onAdd: (productId: number, grams: number, meal: MealType) => Promise<void>
}) {
  const [meal, setMeal] = useState(initialMeal)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Product[] | null>(null)
  const [picked, setPicked] = useState<Product | null>(null)
  const [grams, setGrams] = useState('100')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (q.trim().length < 2) return
    let stale = false
    const timer = setTimeout(() => {
      const url = `/api/products/search?q=${encodeURIComponent(q.trim())}`
      // signed request also returns the user's own products; outside Telegram fall back to the public catalog
      api<Product[]>(url).then((r) => r ?? publicGet<Product[]>(url))
        .then((r) => !stale && setResults(r))
        .catch(() => !stale && setError('Поиск недоступен — проверьте соединение'))
    }, 300) // wait for the user to stop typing
    return () => { stale = true; clearTimeout(timer) }
  }, [q])

  const g = Number(grams.replace(',', '.'))
  const valid = Number.isFinite(g) && g > 0 && g <= 5000

  async function add() {
    if (!picked || !valid) return
    setBusy(true)
    setError('')
    try {
      await onAdd(picked.id, g, meal)
      onClose()
    } catch {
      setError('Не удалось добавить. Попробуйте ещё раз.')
      setBusy(false)
    }
  }

  return (
    <Sheet title="Добавить продукт" onClose={onClose}>
      <div className="seg seg-4">
        {(Object.keys(MEALS) as MealType[]).map((m) => (
          <button type="button" key={m} aria-pressed={meal === m} onClick={() => setMeal(m)}>{MEALS[m]}</button>
        ))}
      </div>

      {!picked ? (
        <>
          <div className="input-wrap">
            <input autoFocus placeholder="Поиск: творог, гречка…" value={q}
              onChange={(e) => { setQ(e.target.value); setError(''); if (e.target.value.trim().length < 2) setResults(null) }} />
          </div>
          {results && results.length === 0 && <p className="sub">Ничего не найдено. Если база продуктов ещё пустая — её скоро наполнят.</p>}
          {results && results.length > 0 && (
            <div className="list scroll-list">
              {results.map((p) => (
                <button className="row row-btn" key={p.id} onClick={() => setPicked(p)}>
                  <div className="row-main">
                    <div className="row-title">{p.name}</div>
                    <div className="row-sub">{p.brand ? `${p.brand} · ` : ''}на 100 г: Б {p.protein_g} · Ж {p.fat_g} · У {p.carbs_g}</div>
                  </div>
                  <div className="row-end">{Math.round(p.kcal)} ккал</div>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="row">
            <div className="row-main">
              <div className="row-title">{picked.name}</div>
              <div className="row-sub">{picked.brand ?? ''}</div>
            </div>
            <button className="link" onClick={() => setPicked(null)}>Другой</button>
          </div>
          <label className="field">
            <span>Количество</span>
            <div className="input-wrap">
              <input inputMode="decimal" autoFocus value={grams} onChange={(e) => setGrams(e.target.value)} />
              <i>г</i>
            </div>
          </label>
          {valid && (
            <p className="sub">
              {Math.round((picked.kcal * g) / 100)} ккал · Б {r1((picked.protein_g * g) / 100)} · Ж {r1((picked.fat_g * g) / 100)} · У {r1((picked.carbs_g * g) / 100)}
            </p>
          )}
          <button className="btn" disabled={!valid || busy} onClick={add}>{busy ? 'Добавляем…' : `Добавить в «${MEALS[meal]}»`}</button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </Sheet>
  )
}
