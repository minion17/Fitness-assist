import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Progress from './Progress'

vi.mock('./haptics', () => ({ haptic: vi.fn() }))
afterEach(() => { cleanup(); sessionStorage.clear() })

test.each([null, '2026-11-20'])('opens an award, replays its artwork and closes without granting XP (%s)', (unlocked_at) => {
  render(<Progress canEdit={false} achievements={[{ code: 'norm_7', icon: '🎯', title: 'Точно в цель', hint: 'Семь дней в норме', progress: 0, target: 7, unlocked_at }]} freezes={0} body={null} />)
  fireEvent.click(screen.getByRole('tab', { name: 'Награды' }))
  fireEvent.click(screen.getByRole('button', { name: 'Открыть достижение: Точно в цель' }))
  const dialog = screen.getByRole('dialog')
  expect(screen.queryByText('+25 XP')).toBeNull()
  if (!unlocked_at) expect(screen.getByText('Пока не получено. Семь дней в норме')).toBeTruthy()
  const first = dialog.querySelector('.achievement-reveal')
  fireEvent.click(screen.getByRole('button', { name: 'Повторить анимацию награды' }))
  expect(dialog.querySelector('.achievement-reveal')).not.toBe(first)
  expect(first?.isConnected).toBe(false)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: 'Открыть достижение: Точно в цель' })).toBeTruthy()
})
