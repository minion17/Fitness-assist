// Ways to count a product besides grams: pieces, its portion, ml and glasses for drinks, spoons. Everything turns into grams.
import type { Product } from './types'

export type Unit = { label: string; g: number } // grams in one unit

export function unitsFor(p: Product): Unit[] {
  const out: Unit[] = [{ label: 'г', g: 1 }]
  const add = (label: string | null | undefined, g: number | null | undefined) => {
    if (label && g && g > 0 && !out.some((u) => u.label === label)) out.push({ label, g })
  }
  add(p.piece_name ?? 'шт', p.piece_g)
  add(p.portion_name ?? 'порция', p.portion_g)
  if (p.ml_g) { add('мл', p.ml_g); add('стакан', 250 * p.ml_g) }
  if (p.tbsp_g) { add('ст. л.', p.tbsp_g); add('ч. л.', Math.round((p.tbsp_g / 3) * 10) / 10) }
  return out
}

const BIG_PACK = 300 // g: a whole litre of milk or a kilo of flour is rarely eaten at once

/** What a product is usually counted in: one piece or portion (a small package too), a glass of a drink, else 100 g. */
export function defaultAmount(p: Product): { unit: Unit; qty: number } {
  const us = unitsFor(p)
  const one = (label: string, g?: number | null) => (g && !(label === 'упаковка' && g > BIG_PACK) ? us.find((u) => u.label === label) : undefined)
  const piece = one(p.piece_name ?? 'шт', p.piece_g) ?? one(p.portion_name ?? 'порция', p.portion_g)
  if (piece) return { unit: piece, qty: 1 }
  const ml = us.find((u) => u.label === 'мл')
  if (ml) return { unit: ml, qty: 200 }
  return { unit: us[0], qty: 100 }
}

/** "1,5" for display */
export const fmtQty = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',')

// "яйцо 2", "гречка 150", "молоко 200 мл", "2 банана", "сметана 1 ст. л." -> the search text and the amount
const AMOUNT = /(^|\s)(\d+(?:[.,]\d+)?)\s*(шт\S*|штук\S*|кг|гр?\.?|грамм\S*|мл|л|литр\S*|стакан\S*|ст\.?\s?л\.?|ч\.?\s?л\.?|ложк\S*|ломтик\S*|кус\S*|порци\S*|упак\S*|бутыл\S*|банк\S*)?(?=\s|$)/i

export type Wanted = { qty: number; unit: string | null } // unit as typed, null = just a number

export function parseQuery(q: string): { text: string; wanted: Wanted | null } {
  const m = AMOUNT.exec(q)
  if (!m) return { text: q.trim(), wanted: null }
  const text = (q.slice(0, m.index) + ' ' + q.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim()
  return { text, wanted: { qty: Number(m[2].replace(',', '.')), unit: m[3]?.toLowerCase() ?? null } }
}

/** The unit and amount to open a picked product with, from what was typed; null if it doesn't fit this product. */
export function applyWanted(p: Product, w: Wanted): { unit: Unit; qty: number } | null {
  const us = unitsFor(p)
  const by = (label: string) => us.find((u) => u.label === label)
  const piece = us.find((u) => u.label === (p.piece_name ?? 'шт') && p.piece_g)
  const portion = us.find((u) => u.label === (p.portion_name ?? 'порция') && p.portion_g)
  const u = w.unit
  if (!u) {
    if (w.qty >= 20) return { unit: by('мл') ?? us[0], qty: w.qty } // "гречка 150" — grams; a drink — ml
    const one = piece ?? portion // "яйцо 2" — pieces, if the product has them
    return one && Number.isInteger(w.qty) && w.qty <= 10 ? { unit: one, qty: w.qty } : null
  }
  if (/^г|^грамм/.test(u)) return { unit: us[0], qty: w.qty }
  if (u === 'кг') return { unit: us[0], qty: w.qty * 1000 }
  if (u === 'мл') return by('мл') ? { unit: by('мл')!, qty: w.qty } : { unit: us[0], qty: w.qty }
  if (u === 'л' || u.startsWith('литр')) return by('мл') ? { unit: by('мл')!, qty: w.qty * 1000 } : null
  const found =
    u.startsWith('стакан') ? by('стакан')
    : /^ст|^ложк/.test(u) ? by('ст. л.')
    : u.startsWith('ч') ? by('ч. л.')
    : u.startsWith('упак') || u.startsWith('бутыл') || u.startsWith('банк') ? (by('упаковка') ?? piece)
    : u.startsWith('порци') ? portion
    : piece // шт, ломтик, кусок
  return found ? { unit: found, qty: w.qty } : null
}

// "1 ломтик", "2 ломтика", "5 ломтиков", "1,5 ломтика"
const FORMS: Record<string, [string, string, string]> = {
  'ломтик': ['ломтик', 'ломтика', 'ломтиков'], 'кусок': ['кусок', 'куска', 'кусков'], 'зубчик': ['зубчик', 'зубчика', 'зубчиков'],
  'стакан': ['стакан', 'стакана', 'стаканов'], 'стаканчик': ['стаканчик', 'стаканчика', 'стаканчиков'], 'шарик': ['шарик', 'шарика', 'шариков'],
  'кубик': ['кубик', 'кубика', 'кубиков'], 'лист': ['лист', 'листа', 'листов'], 'боул': ['боул', 'боула', 'боулов'],
  'половинка': ['половинка', 'половинки', 'половинок'], 'упаковка': ['упаковка', 'упаковки', 'упаковок'], 'порция': ['порция', 'порции', 'порций'],
  'тарелка': ['тарелка', 'тарелки', 'тарелок'], 'долька': ['долька', 'дольки', 'долек'], 'коробочка': ['коробочка', 'коробочки', 'коробочек'],
  'пицца': ['пицца', 'пиццы', 'пицц'], 'мерная ложка': ['мерная ложка', 'мерные ложки', 'мерных ложек'],
}

export function unitWord(label: string, qty: number): string {
  const f = FORMS[label]
  if (!f) return label // г, мл, шт, ст. л. don't change
  if (!Number.isInteger(qty)) return f[1]
  const n10 = qty % 10, n100 = qty % 100
  return n10 === 1 && n100 !== 11 ? f[0] : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? f[1] : f[2]
}
