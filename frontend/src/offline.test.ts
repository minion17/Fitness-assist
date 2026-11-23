import { beforeEach, expect, test } from 'vitest'
import { ApiError } from './telegram'
import { cancel, enqueue, flush, localId, pending, real, unreachable, waitingOn } from './offline'

beforeEach(() => localStorage.clear())

const food = (n: number) => ({ path: '/api/food-logs', body: { n }, name: String(n), kind: 'food' as const })

test('offline queue: sent in order, stops at a network failure, drops what the server refuses', async () => {
  enqueue(food(1)); enqueue(food(2)); enqueue(food(3))
  const sent: unknown[] = []
  let fail: unknown = null
  const send = async (_: string, init: RequestInit) => {
    const n = JSON.parse(init.body as string).n
    if (fail && n === 2) throw fail
    sent.push(n)
  }
  fail = new TypeError('Failed to fetch')
  expect(await flush(send)).toBe(1)
  expect(pending().map((p) => p.name)).toEqual(['2', '3']) // kept for later
  fail = new ApiError(422, '{"detail":"Дописать можно только последние 30 дней"}')
  expect(await flush(send)).toBe(1) // 2 refused and dropped, 3 sent
  expect(pending()).toEqual([])
  expect(sent).toEqual([1, 3])
  expect(unreachable(new ApiError(503, ''))).toBe(true)
  expect(unreachable(new ApiError(401, ''))).toBe(true) // the sign-in went stale offline: reopen and retry
  expect(unreachable(new ApiError(404, ''))).toBe(false)
})

test('a workout made offline: its sets wait behind it and get its real id; an undone set never leaves', async () => {
  const w = localId(), s1 = localId(), s2 = localId()
  expect(w).toBeLessThan(0)
  enqueue({ path: '/api/workout-logs', body: { title: 'Ноги' }, local: w, kind: 'workout' })
  enqueue({ path: `/api/workout-logs/${w}/sets`, body: { reps: 8 }, local: s1, kind: 'workout' })
  enqueue({ path: `/api/workout-logs/${w}/sets`, body: { reps: 9 }, local: s2, kind: 'workout' })
  expect(waitingOn(w)).toBe(true)
  expect(cancel(s2)).toBe(true) // undone before sending
  enqueue({ path: `/api/workout-logs/${w}/complete`, kind: 'workout' })
  const calls: string[] = []
  let next = 500
  expect(await flush(async (path) => { calls.push(path); return { id: next++ } })).toBe(3)
  expect(calls).toEqual(['/api/workout-logs', '/api/workout-logs/500/sets', '/api/workout-logs/500/complete'])
  expect(real(w)).toBe(500) // the open workout screen keeps working with the server id
  expect(real(42)).toBe(42)
  expect(waitingOn(w)).toBe(false)
})

test('a record whose parent was refused is dropped, not stuck', async () => {
  const w = localId()
  enqueue({ path: '/api/workout-logs', body: {}, local: w })
  enqueue({ path: `/api/workout-logs/${w}/sets`, body: {} })
  enqueue(food(7))
  const calls: string[] = []
  await flush(async (path) => { calls.push(path); if (path === '/api/workout-logs') throw new ApiError(422, '') })
  expect(calls).toEqual(['/api/workout-logs', '/api/food-logs'])
  expect(pending()).toEqual([])
})

test('the first, food-only queue is carried over', () => {
  localStorage.setItem('setly-food-queue', JSON.stringify([{ name: 'Творог', body: { product_id: 1 } }]))
  expect(pending()).toEqual([{ path: '/api/food-logs', body: { product_id: 1 }, name: 'Творог', kind: 'food' }])
  expect(localStorage.getItem('setly-food-queue')).toBeNull()
})
