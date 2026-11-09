// The last data the server sent, kept on the phone: the next open shows it instantly while fresh data loads.
import { tgUser } from './telegram'

const KEY = 'fa.snapshot'

export function saveSnapshot<T>(data: T): void {
  try { localStorage.setItem(KEY, JSON.stringify({ user: tgUser?.id, at: Date.now(), data })) } catch { /* full or private mode */ }
}

/** Snapshot of this Telegram user, if any (another account on the same phone never sees it). */
export function loadSnapshot<T>(): T | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return s && s.user === tgUser?.id && tgUser?.id ? (s.data as T) : null
  } catch { return null }
}

/** Charts for Прогресс, by period, kept the same way. */
export function cached<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(`fa.cache.${tgUser?.id}.${key}`) ?? 'null') } catch { return null }
}
export function cache<T>(key: string, value: T): void {
  try { localStorage.setItem(`fa.cache.${tgUser?.id}.${key}`, JSON.stringify(value)) } catch { /* ignore */ }
}
