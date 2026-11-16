// Food logged without a connection waits on the phone and is sent when the network is back (metro, plane, roaming).
import { ApiError } from './telegram'

const KEY = 'setly-food-queue'
export type Pending = { body: Record<string, unknown>; name: string }

/** No connection, or the server/proxy is down: worth retrying later. A 4xx is a real answer — not queued. */
export const unreachable = (e: unknown) => !(e instanceof ApiError) || [502, 503, 504].includes(e.status)

export function pending(): Pending[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
}
function save(q: Pending[]) {
  try { if (q.length) localStorage.setItem(KEY, JSON.stringify(q)); else localStorage.removeItem(KEY) } catch { /* private mode */ }
}
export function enqueue(p: Pending) { save([...pending(), p]) }

/** Send in order; stop at the first network failure. Entries the server refuses (e.g. a day past the back-fill limit) are dropped. */
export async function flush(send: (body: Record<string, unknown>) => Promise<unknown>): Promise<number> {
  let q = pending(), sent = 0
  while (q.length) {
    try { await send(q[0].body); sent++ } catch (e) { if (unreachable(e)) break }
    q = q.slice(1)
    save(q)
  }
  return sent
}
