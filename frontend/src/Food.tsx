import { useEffect, useState } from 'react'
import type { Targets } from './profile'
import AiMeal from './AiMeal'
import { shrink } from './image'
import type { FoodIntent } from './Home'
import { readBarcode } from './barcode'
import MenuImport from './MenuImport'
import Scanner from './Scanner'
import { api, ApiError, postJson, publicGet } from './telegram'
import { MEALS, mealNow, type FoodDay, type FoodItem, type MealType, type Product } from './types'
import { Bar, Ring, Sheet } from './ui'

const DEFAULT_GOALS: Targets = { calories: 2000, protein: 120, fat: 70, carbs: 230 }
const MACROS = [
  { label: 'Белки', key: 'protein_g', goal: 'protein', color: 'var(--protein)' },
  { label: 'Жиры', key: 'fat_g', goal: 'fat', color: 'var(--fat)' },
  { label: 'Углеводы', key: 'carbs_g', goal: 'carbs', color: 'var(--carbs)' },
] as const

const r1 = (n: number) => Math.round(n * 10) / 10
type RecentProduct = Product & { last_amount_g: number }

const MEAL_TIME: Record<MealType, string> = { breakfast: '07:00', lunch: '13:00', dinner: '19:00', snack: '16:00' }
const nowSlot = () => new Date().toTimeString().slice(0, 5)

/** Breakfast, lunch, dinner always; each snack (by its start time) as its own card; all in time order. */
function mealGroups(day: FoodDay) {
  const groups = (['breakfast', 'lunch', 'dinner'] as MealType[]).map((meal) => ({
    key: meal as string, meal, slot: null as string | null, title: MEALS[meal], time: MEAL_TIME[meal],
    items: day.items.filter((i) => i.meal_type === meal),
  }))
  const snacks = new Map<string, FoodItem[]>()
  for (const i of day.items) if (i.meal_type === 'snack') snacks.set(i.snack_slot ?? '', [...(snacks.get(i.snack_slot ?? '') ?? []), i])
  for (const [slot, items] of snacks) {
    groups.push({ key: `snack-${slot}`, meal: 'snack', slot: slot || null, title: slot ? `Перекус ${slot}` : 'Перекус', time: slot || MEAL_TIME.snack, items })
  }
  return groups.sort((a, b) => a.time.localeCompare(b.time))
}

export default function Food({ day, targets, canEdit, onAdd, onDelete, aiEnabled = false, onAiDone = async () => {}, intent = null, onCopy = async () => {} }: {
  day: FoodDay
  targets?: Targets
  canEdit: boolean
  onAdd: (productId: number, grams: number, meal: MealType, slot?: string | null) => Promise<void>
  onDelete: (id: number) => Promise<void>
  aiEnabled?: boolean
  onAiDone?: (xp: number) => Promise<void>
  intent?: FoodIntent | null // shortcut from Home: open the matching sheet right away
  onCopy?: (fromDay: string, meal: MealType) => Promise<void>
}) {
  const goals = targets ?? DEFAULT_GOALS
  const [adding, setAdding] = useState<{ meal: MealType; slot?: string | null } | null>(intent === 'search' ? { meal: mealNow() } : null)
  const [confirm, setConfirm] = useState<number | null>(null)
  const [expandedMeals, setExpandedMeals] = useState<string[]>([])
  const [aiMode, setAiMode] = useState<'text' | 'photo' | null>(intent === 'search' ? null : intent)
  const t = day.totals
  const [yesterday, setYesterday] = useState<FoodDay | null>(null)
  const [copying, setCopying] = useState<MealType | null>(null)
  useEffect(() => {
    if (!canEdit) return
    const d = new Date(Date.now() - 864e5)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    api<FoodDay>(`/api/food-logs?day=${iso}`).then(setYesterday).catch(() => {})
  }, [canEdit])

  return (
    <>
      <h1>Питание</h1>
      <section className="card nutrition-summary">
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
      {canEdit && <button className="btn nutrition-add" onClick={() => setAdding({ meal: mealNow() })}>+ Добавить продукт</button>}
      {canEdit && aiEnabled && (
        <div className="ai-row">
          <button className="btn btn-ghost" onClick={() => setAiMode('text')}>✨ Текстом</button>
          <button className="btn btn-ghost" onClick={() => setAiMode('photo')}>📷 Фото</button>
        </div>
      )}

      <section className="meal-diary">
      <h2>Приёмы пищи</h2>
      {mealGroups(day).map(({ key, meal, slot, title, items }) => {
        const kcal = items.reduce((s, i) => s + i.kcal, 0)
        const main = meal !== 'snack'
        return (
          <section className="meal-group" key={key}>
            <button className="meal-toggle" aria-expanded={expandedMeals.includes(key)} onClick={() => setExpandedMeals(current => current.includes(key) ? current.filter(k => k !== key) : [...current, key])}>
              <h2>{title}</h2><span className="meal-chevron" aria-hidden="true">⌄</span>
            </button>
            <div className="meal-totals">{items.length === 0 ? 'Пока пусто'
              : `${Math.round(kcal)} ккал · Б ${Math.round(items.reduce((n, i) => n + i.protein_g, 0))} · Ж ${Math.round(items.reduce((n, i) => n + i.fat_g, 0))} · У ${Math.round(items.reduce((n, i) => n + i.carbs_g, 0))}`}</div>
            {expandedMeals.includes(key) && (items.length === 0 ? <p className="sub">Пока нет продуктов</p> : (
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
            ))}
            {canEdit && (
              <div className="meal-actions">
                <button className="link" onClick={() => setAdding({ meal, slot })}>+ Добавить</button>
                {main && items.length === 0 && yesterday?.items.some((i) => i.meal_type === meal) && (
                  <button className="link meal-repeat" disabled={copying === meal}
                    onClick={() => { setCopying(meal); onCopy(yesterday.date, meal).finally(() => setCopying(null)) }}>
                    ↻ Как вчера · {Math.round(yesterday.items.filter((i) => i.meal_type === meal).reduce((a, i) => a + i.kcal, 0))} ккал
                  </button>
                )}
              </div>
            )}
          </section>
        )
      })}
      {canEdit && <button className="link meal-snack" onClick={() => setAdding({ meal: 'snack', slot: nowSlot() })}>+ Перекус</button>}
      </section>
      {!canEdit && <p className="sub">Демо-режим: чтобы вести дневник, откройте приложение из Telegram.</p>}
      {aiMode && <AiMeal mode={aiMode} onClose={() => setAiMode(null)} onDone={onAiDone} />}
      {adding && <AddFood meal={adding.meal} slot={adding.slot} onClose={() => setAdding(null)} onAdd={onAdd} aiEnabled={aiEnabled} />}
    </>
  )
}

function AddFood({ meal: initialMeal, slot = null, onClose, onAdd, aiEnabled = false }: {
  meal: MealType
  slot?: string | null
  aiEnabled?: boolean
  onClose: () => void
  onAdd: (productId: number, grams: number, meal: MealType, slot?: string | null) => Promise<void>
}) {
  const [meal, setMeal] = useState(initialMeal)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Product[] | null>(null)
  const [picked, setPicked] = useState<Product | null>(null)
  const [grams, setGrams] = useState('100')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [list, setList] = useState<'recent' | 'favorites'>('recent')
  const [custom, setCustom] = useState<false | true | 'notFound'>(false)
  const [lastCode, setLastCode] = useState<string | null>(null) // unknown scanned code, linked to the custom product
  const [scan, setScan] = useState<'idle' | 'busy' | 'manual'>('idle')
  const [code, setCode] = useState('')
  const [scanner, setScanner] = useState(false)
  const [menuMode, setMenuMode] = useState(false)
  const [thanks, setThanks] = useState(false)
  const [recent, setRecent] = useState<RecentProduct[] | null>(null)
  const [favorites, setFavorites] = useState<Product[] | null>(null)

  useEffect(() => {
    api<RecentProduct[]>('/api/products/recent').then(setRecent).catch(() => {})
    api<Product[]>('/api/favorites').then(setFavorites).catch(() => {})
  }, [])

  const isFav = picked != null && favorites?.some((f) => f.id === picked.id)
  async function toggleFav(p: Product) {
    const was = favorites?.some((f) => f.id === p.id)
    setFavorites((fs) => (was ? (fs ?? []).filter((f) => f.id !== p.id) : [p, ...(fs ?? [])])) // optimistic
    try { await api(`/api/favorites/${p.id}`, { method: was ? 'DELETE' : 'PUT' }) } catch { setError('Не удалось обновить избранное') }
  }
  async function lookup(c: string) {
    setScan('busy')
    setError('')
    try {
      const p = await api<Product>(`/api/products/barcode/${c}`)
      if (p) { pick(p); setScan('idle'); return }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { setScan('idle'); setLastCode(c); setCustom('notFound'); return }
      setError(e instanceof ApiError ? e.message : 'Не удалось связаться с сервером')
    }
    setScan('manual')
  }
  async function onPhoto(file?: File) {
    if (!file) return
    setScan('busy')
    setError('')
    const c = await readBarcode(file).catch(() => null)
    if (c) return lookup(c)
    setError('Не получилось распознать штрихкод. Сфотографируйте ближе и ровнее или введите цифры.')
    setScan('manual')
  }

  function pick(p: Product | RecentProduct) {
    setPicked(p)
    if ('last_amount_g' in p) setGrams(String(p.last_amount_g))
    else if (p.portion_g) setGrams(String(p.portion_g))
  }

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
      await onAdd(picked.id, g, meal, meal === 'snack' ? slot : null)
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

      {custom && !picked ? (
        <CustomProduct aiEnabled={aiEnabled} barcode={custom === 'notFound' ? lastCode : null} onCreated={(p) => { setCustom(false); setError(''); setThanks(!!p.shared); pick(p) }} onCancel={() => { setCustom(false); setError('') }} />
      ) : menuMode && !picked ? (
        <MenuImport onPick={(p) => { setMenuMode(false); pick(p) }} onCancel={() => setMenuMode(false)} />
      ) : !picked ? (
        <>
          <div className="input-wrap">
            <input autoFocus placeholder="Поиск: творог, гречка…" value={q}
              onChange={(e) => { setQ(e.target.value); setError(''); if (e.target.value.trim().length < 2) setResults(null) }} />
          </div>
          {recent && (
            <div className="meal-actions">
              <button type="button" className="link" disabled={scan === 'busy'} onClick={() => { setError(''); setScanner(true) }}>
                {scan === 'busy' ? 'Ищем товар…' : '▥ Сканировать штрихкод'}
              </button>
              <button type="button" className="link" onClick={() => setCustom(true)}>+ Свой продукт</button>
              {aiEnabled && <button type="button" className="link" onClick={() => setMenuMode(true)}>📷 Меню ресторана</button>}
            </div>
          )}
          {scan === 'manual' && (
            <div className="code-row">
              <div className="input-wrap">
                <input inputMode="numeric" placeholder="Цифры под штрихкодом" value={code} aria-label="Цифры штрихкода"
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 14))} />
              </div>
              <button className="btn btn-side" disabled={code.length < 8} onClick={() => lookup(code)}>Найти</button>
            </div>
          )}
          {q.trim().length < 2 && recent && favorites && (
            <>
              <div className="seg seg-inline">
                <button type="button" aria-pressed={list === 'recent'} onClick={() => setList('recent')}>Недавние</button>
                <button type="button" aria-pressed={list === 'favorites'} onClick={() => setList('favorites')}>Избранное</button>
              </div>
              {(list === 'recent' ? recent : favorites).length === 0 ? (
                <p className="sub">{list === 'recent' ? 'Здесь появятся продукты, которые вы добавляли.' : 'Отметьте продукт звёздочкой — он появится здесь.'}</p>
              ) : (
                <div className="list scroll-list">
                  {(list === 'recent' ? recent : favorites).map((p) => (
                    <button className="row row-btn" key={p.id} onClick={() => pick(p)}>
                      <div className="row-main">
                        <div className="row-title">{p.name}</div>
                        <div className="row-sub">{'last_amount_g' in p ? `${p.last_amount_g} г · ${Math.round((p.kcal * Number(p.last_amount_g)) / 100)} ккал` : `${Math.round(p.kcal)} ккал на 100 г`}</div>
                      </div>
                      <span className="row-end">›</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {results && results.length === 0 && <p className="sub">Ничего не найдено. Отсканируйте штрихкод или добавьте свой продукт.</p>}
          {results && results.length > 0 && (
            <div className="list scroll-list">
              {results.map((p) => (
                <button className="row row-btn" key={p.id} onClick={() => pick(p)}>
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
            {favorites && (
              <button className={isFav ? 'icon-btn star on' : 'icon-btn star'} aria-pressed={isFav} aria-label="В избранное" onClick={() => toggleFav(picked)}>
                {isFav ? '★' : '☆'}
              </button>
            )}
            <button className="link" onClick={() => setPicked(null)}>Другой</button>
          </div>
          {thanks && <p className="sub pos">Спасибо! Этот продукт подтвердили и другие — теперь он доступен всем.</p>}
          {picked.portion_g ? (
            <div className="seg seg-row portions">
              {[0.5, 1, 2].map((k) => {
                const v = String(Math.round(picked.portion_g! * k))
                return (
                  <button type="button" key={k} aria-pressed={grams === v} onClick={() => setGrams(v)}>
                    {k === 1 ? `1 ${picked.portion_name ?? 'порция'}` : k === 0.5 ? '½' : '×2'} · {v} г
                  </button>
                )
              })}
            </div>
          ) : null}
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
      {scanner && (
        <Scanner onCode={(c) => { setScanner(false); lookup(c) }} onClose={() => setScanner(false)}
          onPhoto={(f) => { setScanner(false); onPhoto(f) }} onManual={() => { setScanner(false); setScan('manual') }} />
      )}
    </Sheet>
  )
}

type Label = { found: true; name: string; kcal: number; protein_g: number; fat_g: number; carbs_g: number; note: string } | { found: false; note: string }

function CustomProduct({ barcode, aiEnabled, onCreated, onCancel }: {
  barcode: string | null; aiEnabled: boolean; onCreated: (p: Product & { shared?: boolean }) => void; onCancel: () => void
}) {
  const [v, setV] = useState({ name: '', kcal: '', protein_g: '', fat_g: '', carbs_g: '', brand: '', portion_g: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [hint, setHint] = useState('')
  const num = (x: string) => Number(x.replace(',', '.'))

  async function readLabel(file?: File) {
    if (!file) return
    setReading(true)
    setError('')
    setHint('')
    try {
      const form = new FormData()
      form.append('file', await shrink(file, 1600).catch(() => file), 'label.jpg')
      const r = await api<Label>('/api/ai/label', { method: 'POST', body: form })
      if (!r) return
      if (!r.found) { setError(r.note); return }
      const s = (n: number) => String(n).replace('.', ',')
      setV((old) => ({ ...old, name: old.name || r.name, kcal: s(r.kcal), protein_g: s(r.protein_g), fat_g: s(r.fat_g), carbs_g: s(r.carbs_g) }))
      setHint(r.note || 'Проверьте цифры с упаковкой и сохраните.')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось прочитать этикетку')
    } finally {
      setReading(false)
    }
  }
  const fields = [['kcal', 'Ккал', 900], ['protein_g', 'Белки, г', 100], ['fat_g', 'Жиры, г', 100], ['carbs_g', 'Углеводы, г', 100]] as const

  async function save() {
    if (v.name.trim().length < 2) return setError('Введите название')
    for (const [k, label, max] of fields) {
      const n = num(v[k])
      if (v[k] === '' || !Number.isFinite(n) || n < 0 || n > max) return setError(`${label}: от 0 до ${max}`)
    }
    if (num(v.protein_g) + num(v.fat_g) + num(v.carbs_g) > 100) return setError('Белков, жиров и углеводов вместе не больше 100 г')
    const portion = v.portion_g ? num(v.portion_g) : null
    if (portion !== null && !(portion > 0 && portion <= 3000)) return setError('Порция: от 1 до 3000 г')
    setBusy(true)
    try {
      const p = await api<Product & { shared: boolean }>('/api/products', postJson({
        name: v.name, kcal: num(v.kcal), protein_g: num(v.protein_g), fat_g: num(v.fat_g), carbs_g: num(v.carbs_g),
        brand: v.brand.trim() || null, portion_g: portion, ...(barcode ? { barcode } : {}),
      }))
      if (p) onCreated(p)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось сохранить')
      setBusy(false)
    }
  }

  return (
    <>
      {barcode && <p className="row-title strong">Товара {barcode} пока нет в базе — добавьте его один раз, дальше он будет находиться по штрихкоду.</p>}
      <p className="sub">Значения — на 100 г, они есть на упаковке. Продукт будет виден только вам.</p>
      {aiEnabled && (
        <label className={reading ? 'btn btn-ghost photo-btn disabled' : 'btn btn-ghost photo-btn'}>
          {reading ? 'Читаю этикетку…' : '📷 Сфоткать этикетку — заполню сам'}
          <input type="file" accept="image/*" capture="environment" hidden disabled={reading}
            onChange={(e) => { readLabel(e.target.files?.[0]); e.target.value = '' }} />
        </label>
      )}
      {hint && <p className="sub pos">{hint}</p>}
      <label className="field">
        <span>Название</span>
        <div className="input-wrap"><input autoFocus value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></div>
      </label>
      <div className="grid2">
        {fields.map(([k, label]) => (
          <label className="field" key={k}>
            <span>{label}</span>
            <div className="input-wrap"><input inputMode="decimal" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></div>
          </label>
        ))}
      </div>
      <div className="grid2">
        <label className="field">
          <span>Бренд / заведение</span>
          <div className="input-wrap"><input value={v.brand} placeholder="необязательно" onChange={(e) => setV({ ...v, brand: e.target.value })} /></div>
        </label>
        <label className="field">
          <span>Порция, г</span>
          <div className="input-wrap"><input inputMode="decimal" value={v.portion_g} placeholder="необязательно" onChange={(e) => setV({ ...v, portion_g: e.target.value })} /></div>
        </label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" disabled={busy} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить продукт'}</button>
      <button className="link" onClick={onCancel}>Назад к поиску</button>
    </>
  )
}
