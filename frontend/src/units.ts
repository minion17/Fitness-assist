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
