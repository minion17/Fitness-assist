// «Итоги недели» as a full-screen card: opens by itself once a week (Sunday evening or Monday), and from Прогресс.
// Shares to Telegram Stories when the client can, else as a message to a friend with the invite link.
import { useEffect, useState } from 'react'
import type { WeekDay } from './Home'
import { canStory, shareStory } from './story'
import { api, tg } from './telegram'
import { plural } from './plural'

const fmt = (n: number, d = 0) => n.toLocaleString('ru-RU', { maximumFractionDigits: d })
const dayName = (iso: string) => new Date(iso + 'T12:00').toLocaleDateString('ru-RU', { weekday: 'long' })
export default function WeekRecap({ days, goal, streak, weightDelta, onClose }: {
  days: WeekDay[]; goal: number; streak: number; weightDelta: number | null; onClose: () => void
}) {
  const [link, setLink] = useState<string | null>(null)
  useEffect(() => { if (!canStory()) api<{ invite_link: string | null }>('/api/friends').then((r) => setLink(r?.invite_link ?? null)).catch(() => {}) }, [])
  const logged = days.filter((d) => d.kcal > 0)
  const norm = logged.filter((d) => Math.abs(d.kcal - goal) <= 0.1 * goal).length
  const workouts = days.reduce((n, d) => n + d.workouts, 0)
  const water = days.filter((d) => d.water_ml > 0)
  const best = logged.length ? logged.reduce((a, d) => Math.abs(d.kcal - goal) < Math.abs(a.kcal - goal) ? d : a) : null
  const text = `Моя неделя в Setly: ${norm} из 7 дней в норме, ${workouts} ${plural(workouts, 'тренировка', 'тренировки', 'тренировок')}${streak > 1 ? `, серия ${streak} дн.` : ''} 💪`

  function share() {
    if (canStory()) { shareStory({ kind: 'week' }).catch(() => {}); return }
    const url = `https://t.me/share/url?url=${encodeURIComponent(link ?? 'https://t.me')}&text=${encodeURIComponent(text)}`
    if (tg?.openTelegramLink) tg.openTelegramLink(url)
    else window.open(url, '_blank')
  }

  return (
    <div className="recap" role="dialog" aria-modal="true" aria-label="Итоги недели">
      <button className="recap-close" aria-label="Закрыть" onClick={onClose}>✕</button>
      <p className="recap-kicker">Итоги недели</p>
      <h1 className="recap-title">{norm >= 5 ? 'Сильная неделя 🔥' : norm >= 3 ? 'Хорошая неделя' : 'Неделя позади'}</h1>
      <div className="recap-grid">
        <div className="recap-tile big"><b>{norm}<small>/7</small></b><span>дней в норме калорий</span></div>
        <div className="recap-tile"><b>{workouts}</b><span>{plural(workouts, 'тренировка', 'тренировки', 'тренировок')}</span></div>
        <div className="recap-tile"><b>{streak}</b><span>{plural(streak, 'день', 'дня', 'дней')} подряд</span></div>
        <div className="recap-tile"><b>{water.length ? fmt(water.reduce((n, d) => n + d.water_ml, 0) / water.length / 1000, 1) : '—'}</b><span>л воды в день</span></div>
        <div className="recap-tile"><b>{weightDelta === null ? '—' : `${weightDelta > 0 ? '+' : ''}${fmt(weightDelta, 1)}`}</b><span>кг за неделю</span></div>
      </div>
      {best && <p className="recap-best">Лучший день — {dayName(best.date)}: {fmt(best.kcal)} ккал при норме {fmt(goal)}</p>}
      <div className="recap-actions">
        {(canStory() || link) && <button className="btn" onClick={share}>{canStory() ? 'Опубликовать в истории' : 'Отправить другу'}</button>}
        <button className="btn btn-ghost" onClick={onClose}>Дальше</button>
      </div>
    </div>
  )
}
