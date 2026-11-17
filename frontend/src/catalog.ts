// Products kept on the phone: search answers from the first letter (the server search follows and has the last word),
// and an added product shows in the diary at once, before the server confirms.
import { api } from './telegram'
import type { Product } from './types'

const KEY = 'setly-catalog'
const MAX_AGE = 24 * 3600e3
type Local = Product & { mine?: boolean }
type Store = { at: number; items: Local[] }

let mem: Store | null = null
function store(): Store {
  if (!mem) {
    try { mem = JSON.parse(localStorage.getItem(KEY) || 'null') } catch { /* broken or blocked */ }
    mem ??= { at: 0, items: [] }
  }
  return mem
}
function save(s: Store) {
  mem = s
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* full or private mode: memory only */ }
}

/** Products the app has seen this session (search results, recent, picked): enough to draw an entry before the server answers. */
export const known = new Map<number, Product>()
export function remember(p: Product) {
  known.set(p.id, p)
}

/** After logging: the product is "mine" now and comes first in local search. */
export function eaten(p: Product) {
  remember(p)
  const s = store()
  save({ ...s, items: [{ ...p, mine: true }, ...s.items.filter((i) => i.id !== p.id)] })
}

/** Refresh once a day, in the background after startup. */
export async function syncCatalog(force = false) {
  if (!force && Date.now() - store().at < MAX_AGE) return
  const items = await api<Local[]>('/api/products/local')
  if (items) save({ at: Date.now(), items })
}

const norm = (s: string) => s.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/[^a-zа-я0-9%.,]+/g, ' ').trim()

/** A typed word matches a name word from its start; a longer one also with a changed ending ("яйца" → "яйцо"). */
function wordHit(word: string, names: string[]) {
  const stem = word.length >= 4 ? word.slice(0, -1) : word
  return names.some((n) => n.startsWith(word) || n.startsWith(stem))
}

export function localSearch(text: string, limit = 12): Product[] {
  const words = norm(text).split(' ').filter(Boolean)
  if (!words.length || words.join('').length < 2) return []
  const hits: { p: Local; rank: number }[] = []
  for (const p of store().items) {
    const names = norm(p.name).split(' ')
    if (!words.every((w) => wordHit(w, names))) continue
    hits.push({ p, rank: (p.mine ? 0 : 4) + (names[0].startsWith(words[0]) ? 0 : 2) + (p.brand ? 1 : 0) })
  }
  hits.sort((a, b) => a.rank - b.rank || a.p.name.length - b.p.name.length)
  return hits.slice(0, limit).map((h) => h.p)
}
