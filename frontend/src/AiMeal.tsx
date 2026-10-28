import { useState } from 'react'
import { api, ApiError, postJson } from './telegram'
import { MEALS, mealNow, type MealType } from './types'
import { Sheet } from './ui'

type DraftItem = {
  product_id: number | null; name: string; grams: number; from_catalog: boolean
  kcal_100g: number; protein_100g: number; fat_100g: number; carbs_100g: number
}
type Draft = { meal_type: MealType | null; items: DraftItem[]; note: string }

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Не удалось связаться с сервером')

/** Downscale on the phone: smaller upload, cheaper AI call. */
async function shrink(file: File, max = 1280): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * k)
  canvas.height = Math.round(bitmap.height * k)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('jpeg'))), 'image/jpeg', 0.85))
}

export default function AiMeal({ mode, onClose, onDone }: {
  mode: 'text' | 'photo'
  onClose: () => void
  onDone: (xp: number) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [meal, setMeal] = useState<MealType>(mealNow())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run(request: () => Promise<Draft | null>) {
    setBusy(true)
    setError('')
    try {
      const d = await request()
      if (d) { setDraft(d); if (d.meal_type) setMeal(d.meal_type) }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const fromText = () => run(() => api<Draft>('/api/ai/meal/text', postJson({ text: text.trim() })))
  const fromPhoto = (file: File) => run(async () => {
    const form = new FormData()
    form.append('file', await shrink(file).catch(() => file), 'meal.jpg')
    return api<Draft>('/api/ai/meal/photo', { method: 'POST', body: form })
  })

  const setGrams = (i: number, v: string) =>
    setDraft((d) => d && { ...d, items: d.items.map((it, j) => (j === i ? { ...it, grams: Number(v.replace(',', '.')) || 0 } : it)) })
  const remove = (i: number) => setDraft((d) => d && { ...d, items: d.items.filter((_, j) => j !== i) })

  const items = draft?.items ?? []
  const valid = items.length > 0 && items.every((it) => it.grams > 0 && it.grams <= 3000)
  const total = Math.round(items.reduce((s, it) => s + (it.kcal_100g * it.grams) / 100, 0))

  async function confirm() {
    await run(async () => {
      const r = await api<{ xp_awarded: number }>('/api/ai/meal/confirm', postJson({ meal_type: meal, items }))
      await onDone(r?.xp_awarded ?? 0)
      onClose()
      return null
    })
  }

  return (
    <Sheet title={mode === 'text' ? 'Описать, что съели' : 'Еда по фото'} onClose={onClose}>
      {!draft && mode === 'text' && (
        <>
          <textarea className="textarea" rows={3} autoFocus maxLength={1000} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Например: тарелка гречки с куриной грудкой, огурец и чай с ложкой сахара" />
          <button className="btn" disabled={busy || text.trim().length < 2} onClick={fromText}>{busy ? 'Распознаём…' : 'Распознать'}</button>
        </>
      )}
      {!draft && mode === 'photo' && (
        <label className={`btn photo-btn${busy ? ' disabled' : ''}`}>
          {busy ? 'Распознаём фото…' : '📷 Сфотографировать или выбрать фото'}
          <input type="file" accept="image/*" hidden disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) fromPhoto(f); e.target.value = '' }} />
        </label>
      )}

      {draft && (
        <>
          <div className="seg seg-4">
            {(Object.keys(MEALS) as MealType[]).map((m) => (
              <button type="button" key={m} aria-pressed={meal === m} onClick={() => setMeal(m)}>{MEALS[m]}</button>
            ))}
          </div>
          {draft.note && <p className="sub">{draft.note}</p>}
          {items.length === 0 && <p className="sub">Не удалось распознать еду. Попробуйте описать подробнее или сделать другое фото.</p>}
          <div className="list">
            {items.map((it, i) => (
              <div className="row" key={i}>
                <div className="row-main">
                  <div className="row-title">{it.name}</div>
                  <div className="row-sub">
                    <span className={it.from_catalog ? 'tag' : 'tag tag-ai'}>{it.from_catalog ? 'из базы' : 'оценка AI'}</span>
                    {' '}{Math.round((it.kcal_100g * it.grams) / 100)} ккал
                  </div>
                </div>
                <div className="input-wrap grams"><input inputMode="decimal" aria-label={`${it.name}, граммы`}
                  value={it.grams || ''} onChange={(e) => setGrams(i, e.target.value)} /><i>г</i></div>
                <button className="icon-btn" aria-label={`Убрать ${it.name}`} onClick={() => remove(i)}>✕</button>
              </div>
            ))}
          </div>
          {items.length > 0 && <p className="sub">Итого ≈ {total} ккал. Проверьте граммы — AI оценивает порции примерно.</p>}
          <button className="btn" disabled={!valid || busy} onClick={confirm}>{busy ? 'Добавляем…' : `Добавить в «${MEALS[meal]}»`}</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => { setDraft(null); setError('') }}>Заново</button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </Sheet>
  )
}
