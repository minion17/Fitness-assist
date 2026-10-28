// Minimal typing for the part of window.Telegram.WebApp we use.
type TgUser = { id: number; first_name?: string; last_name?: string; username?: string; photo_url?: string }

type WebApp = {
  initData: string
  initDataUnsafe: { user?: TgUser }
  ready(): void
  expand(): void
  setHeaderColor?(color: string): void
  setBackgroundColor?(color: string): void
  HapticFeedback?: { selectionChanged(): void }
}

declare global {
  interface Window {
    Telegram?: { WebApp: WebApp }
  }
}

export const tg: WebApp | undefined = window.Telegram?.WebApp
export const tgUser: TgUser | undefined = tg?.initDataUnsafe.user

export function initTelegram() {
  if (!tg) return
  tg.ready()
  tg.expand()
  tg.setHeaderColor?.('#16171a')
  tg.setBackgroundColor?.('#16171a')
}

/** Public reference data (products, programs) — works outside Telegram too. */
export async function publicGet<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

export const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/** Calls backend with signed initData; returns null outside Telegram. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  if (!tg?.initData) return null
  const res = await fetch(path, { ...init, headers: { ...init.headers, Authorization: `tma ${tg.initData}` } })
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return res.json()
}

/** Error with the backend's human-readable `detail` as the message. */
export class ApiError extends Error {
  status: number
  constructor(status: number, body: string) {
    let detail = body
    try { const d = JSON.parse(body).detail; if (typeof d === 'string') detail = d } catch { /* not JSON */ }
    super(detail)
    this.status = status
  }
}
