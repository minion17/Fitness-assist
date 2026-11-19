import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import FeedbackCard, { FeedbackForm } from './Feedback'
import { api } from './telegram'

vi.mock('./telegram', () => ({ api: vi.fn(async () => ({ ok: true })), ApiError: class extends Error {}, postJson: (b: unknown) => ({ method: 'POST', body: JSON.stringify(b) }) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

test('an idea goes to the team; too short is stopped here', async () => {
  render(<FeedbackCard />)
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
  expect(screen.getByRole('alert').textContent).toMatch(/пару слов/)
  fireEvent.click(screen.getByRole('button', { name: /не работает/ }))
  fireEvent.change(screen.getByLabelText('Сообщение'), { target: { value: 'Сканер не видит код' } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Спасибо/))
  expect(JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string)).toEqual({ kind: 'bug', text: 'Сканер не видит код', product_id: null })
})

test('wrong numbers on a product carry its id', async () => {
  render(<FeedbackForm kind="product" productId={42} />)
  expect(screen.queryByRole('button', { name: /Идея/ })).toBeNull()
  fireEvent.change(screen.getByLabelText('Сообщение'), { target: { value: 'белка 5, а не 18' } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
  await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled())
  expect(JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string)).toMatchObject({ kind: 'product', product_id: 42 })
})
