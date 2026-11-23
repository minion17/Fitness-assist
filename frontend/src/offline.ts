// Records made without a connection (the gym basement, the metro, a plane) wait on the phone and go out by themselves
// when the network is back, in the order they were made: food, water, habits, a whole workout with its sets.
//
// Something created offline (a workout, a set) gets a local negative id; later records point at it by that id in
// their path (/api/workout-logs/-123/sets) and are rewritten to the real id once the server has created it.
import { ApiError } from './telegram'

const KEY = 'setly-offline-queue'
const OLD_FOOD_KEY = 'setly-food-queue' // the first queue: food only
const IDS = 'setly-offline-ids'
const KEEP_IDS_MS = 3 * 24 * 3600_000

export type Job = {
  path: string
  method?: string // POST by default
  body?: Record<string, unknown>
  local?: number // this job creates the object known locally by this (negative) id
  name?: string
  kind?: 'food' | 'water' | 'habit' | 'workout'
}

/** Worth retrying later: no connection, the server or the tunnel down, or the Telegram sign-in went stale while
 * offline (fixed by reopening). Any other answer is final — a refused record is dropped, not retried forever. */
export const unreachable = (e: unknown) => !(e instanceof ApiError) || [401, 429, 502, 503, 504].includes(e.status)

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback }
}
function write(key: string, value: unknown, keep: boolean) {
  try { if (keep) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key) } catch { /* private mode */ }
}

export function pending(): Job[] {
  const old = read<{ body: Record<string, unknown>; name: string }[]>(OLD_FOOD_KEY, [])
  if (old.length) { // an app version ago: move them over once
    const q = [...read<Job[]>(KEY, []), ...old.map((p): Job => ({ path: '/api/food-logs', body: p.body, name: p.name, kind: 'food' }))]
    write(KEY, q, true)
    write(OLD_FOOD_KEY, null, false)
    return q
  }
  return read<Job[]>(KEY, [])
}
const save = (q: Job[]) => {
  write(KEY, q, q.length > 0)
  try { window.dispatchEvent(new Event(CHANGED)) } catch { /* no window in tests of plain logic */ }
}
/** Fired on window whenever the queue changes: the "ждут связи" counter follows it. */
export const CHANGED = 'setly-offline-queue'

export function enqueue(job: Job) { save([...pending(), job]) }

let counter = 0
/** A fresh local id for something created offline: negative, so it never collides with a server id. */
export const localId = () => -(Date.now() * 1000 + (counter++ % 1000))

/** The server id a local one became, or the id itself if it's already real (or not sent yet). */
export function real(id: number): number {
  return id < 0 ? read<Record<string, [number, number]>>(IDS, {})[id]?.[0] ?? id : id
}

/** Anything still queued for this object (its own creation, or records that point at it)? Then new records for it
 * queue up behind instead of overtaking: a set must not reach the server before its workout. */
export const waitingOn = (id: number) => pending().some((j) => j.local === id || j.path.split('/').includes(String(id)))
// shortcut: a numeric path segment is taken as an object id (/api/habits/7/check): fine for this API's paths

/** An unsent record taken back (a set undone before it ever left the phone): true if it was still in the queue. */
export function cancel(local: number): boolean {
  const q = pending()
  const left = q.filter((j) => j.local !== local && !j.path.split('/').includes(String(local)))
  save(left)
  return left.length < q.length
}

/** Send in order; stop at the first network failure. Returns how many went through. */
export async function flush(send: (path: string, init: RequestInit) => Promise<unknown>): Promise<number> {
  let q = pending(), sent = 0
  const ids = read<Record<string, [number, number]>>(IDS, {})
  for (const [k, [, at]] of Object.entries(ids)) if (Date.now() - at > KEEP_IDS_MS) delete ids[k]
  const keep = () => write(IDS, ids, Object.keys(ids).length > 0)
  while (q.length) {
    const job = q[0]
    const path = job.path.split('/').map((s) => (/^-\d+$/.test(s) ? String(ids[s]?.[0] ?? s) : s)).join('/')
    if (!/\/-\d+(\/|$)/.test(path)) { // else its parent never made it to the server: nothing to attach it to
      try {
        const r = await send(path, { method: job.method ?? 'POST', ...(job.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.body) } : {}) })
        sent++
        const id = (r as { id?: unknown } | null)?.id
        if (job.local && typeof id === 'number') ids[job.local] = [id, Date.now()]
      } catch (e) {
        if (unreachable(e)) break
      }
    }
    q = q.slice(1)
    save(q)
    keep()
  }
  keep()
  return sent
}

const resolve = (path: string) => path.split('/').map((p) => (/^-\d+$/.test(p) ? String(real(Number(p))) : p)).join('/')

/** Send now if possible. Queued instead — and `{ queued: true }` returned — when there's no connection, or when it
 * belongs to something still waiting in the queue (a set of a workout not created yet), so the order holds.
 * Other errors are thrown. */
export async function sendOrQueue<T>(job: Job, send: (path: string, init: RequestInit) => Promise<T | null>):
    Promise<{ queued: true } | { queued: false; value: T | null }> {
  const path = resolve(job.path)
  const behind = path.split('/').some((p) => /^-?\d+$/.test(p) && (Number(p) < 0 || waitingOn(Number(p))))
  if (!behind) {
    try {
      return { queued: false, value: await send(path, { method: job.method ?? 'POST', ...(job.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.body) } : {}) }) }
    } catch (e) {
      if (!unreachable(e)) throw e
    }
  }
  enqueue({ ...job, path })
  return { queued: true }
}
