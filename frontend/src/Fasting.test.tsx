import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { inWindow, proteinPerMeal, windowEnd } from './Fasting'

it('window math: 16:8 from 12:00 ends at 20:00, 18:6 from 20:00 runs past midnight', () => {
  expect(windowEnd('12:00', 16)).toBe('20:00')
  expect(windowEnd('20:00', 18)).toBe('02:00')
  expect(inWindow({ eat_from: '20:00', eat_to: '02:00' }, new Date(2026, 2, 2, 1, 0))).toBe(true)
  expect(inWindow({ eat_from: '12:00', eat_to: '20:00' }, new Date(2026, 2, 2, 20, 0))).toBe(false)
  expect(proteinPerMeal(150, 16)).toBe(50)
  expect(proteinPerMeal(150, 18)).toBe(75)
})

it('setup needs the contraindications confirmed before it starts', async () => {
  const calls: [string, RequestInit | undefined][] = []
  vi.doMock('./telegram', async (orig) => ({
    ...(await orig<typeof import('./telegram')>()),
    api: async (url: string, init?: RequestInit) => { calls.push([url, init]); return { plan: null } },
  }))
  vi.resetModules()
  const { default: F } = await import('./Fasting')
  render(<F />)
  fireEvent.click(await screen.findByText('Интервальное голодание'))
  fireEvent.click(screen.getByRole('button', { name: /Интервальное голодание/, expanded: true }))
  expect(screen.queryByRole('radio', { name: /14:10/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Интервальное голодание/, expanded: false }))
  fireEvent.click(screen.getByRole('radio', { name: /14:10/ }))
  expect(screen.getByText('22:00')).toBeTruthy() // 12:00 + 10 h
  const start = screen.getByRole('button', { name: 'Начать' }) as HTMLButtonElement
  expect(start.disabled).toBe(true)
  fireEvent.click(screen.getByLabelText('Ничего из этого не про меня'))
  fireEvent.click(start)
  expect(JSON.parse(calls.at(-1)![1]!.body as string)).toMatchObject({ hours: 14, eat_from: '12:00', safe: true })
  vi.doUnmock('./telegram')
})
