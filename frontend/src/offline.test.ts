import { beforeEach, expect, test } from 'vitest'
import { ApiError } from './telegram'
import { enqueue, flush, pending, unreachable } from './offline'

beforeEach(() => localStorage.clear())

test('offline queue: sent in order, stops at a network failure, drops what the server refuses', async () => {
  enqueue({ name: 'a', body: { n: 1 } }); enqueue({ name: 'b', body: { n: 2 } }); enqueue({ name: 'c', body: { n: 3 } })
  const sent: unknown[] = []
  let fail: unknown = null
  const send = async (b: Record<string, unknown>) => { if (fail && b.n === 2) throw fail; sent.push(b.n) }
  fail = new TypeError('Failed to fetch')
  expect(await flush(send)).toBe(1)
  expect(pending().map((p) => p.name)).toEqual(['b', 'c']) // kept for later
  fail = new ApiError(422, '{"detail":"Дописать можно только последние 30 дней"}')
  expect(await flush(send)).toBe(1) // b refused and dropped, c sent
  expect(pending()).toEqual([])
  expect(sent).toEqual([1, 3])
  expect(unreachable(new ApiError(503, ''))).toBe(true)
  expect(unreachable(new ApiError(404, ''))).toBe(false)
})
