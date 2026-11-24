// The challenge of the month: one theme for everyone, days counted from the diary; all participants and friends;
// a Stories card for the final (backend/api/monthly.py).
import { useEffect, useState } from 'react'
import { canStory, shareStory } from './story'
import { api, postJson } from './telegram'
import { Bar } from './ui'
import { haptic } from './haptics'
import { plural } from './plural'

type Row = { rank: number; name: string; score: number; me: boolean }
type Last = { emoji: string; title: string; unit: string; goal: number; score: number | null; rank: number | null; total: number | null; done: boolean }
export type MonthBoard = {
  emoji: string; title: string; goal: number; unit: string; hint: string; month: string; ends_at: string
  joined: boolean; total: number; top: Row[]; friends: Row[]; me: { rank: number; score: number; top_percent: number } | null; last: Last | null
}

/** "ноября": the genitive comes with a day number, which is then dropped */
/** "3 дня с тренировкой" */
const days = (n: number, unit: string) => `${n} ${plural(n, 'день', 'дня', 'дней')} ${unit}`
const monthOf = (iso: string) => new Date(iso + 'T12:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }).replace(/^\d+\s*/, '')
function left(iso: string): string {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5)
  return days <= 0 ? 'подводим итоги' : `ещё ${days} ${days % 10 === 1 && days % 100 !== 11 ? 'день' : [2, 3, 4].includes(days % 10) && ![12, 13, 14].includes(days % 100) ? 'дня' : 'дней'}`
}

function List({ rows }: { rows: Row[] }) {
  return (
    <ol className="league-list">
      {rows.map((r) => (
        <li key={`${r.rank}-${r.name}`} className={r.me ? 'me' : ''}>
          <span className="league-rank">{r.rank}</span><span className="league-name">{r.name}</span><span className="league-xp">{r.score}</span>
        </li>
      ))}
    </ol>
  )
}

export default function Month() {
  const [b, setB] = useState<MonthBoard | null>(null)
  const [error, setError] = useState('')
  const [scope, setScope] = useState<'all' | 'friends'>('all')
  const [sent, setSent] = useState(false) // the card was asked for in the chat
  useEffect(() => { api<MonthBoard>('/api/month').then((r) => r && setB(r)).catch(() => setError('Нет связи. Челлендж покажем, как только вернётся интернет')) }, [])
  if (error) return <p className="error">{error}</p>
  if (!b) return <p className="sub">Загружаем челлендж…</p>

  const join = () => { haptic('success'); api<MonthBoard>('/api/month/join', postJson({})).then((r) => r && setB(r)).catch(() => setError('Не получилось. Попробуй ещё раз')) }
  const story = () => shareStory({ kind: 'month' }).catch(() => setError('Не получилось открыть истории'))
  // Stories exist only in the phone app; everywhere the bot can send the same card to the chat to forward or save
  const toChat = () => { haptic('success'); api('/api/share', postJson({ kind: 'month' })).then(() => setSent(true)).catch(() => setError('Не получилось. Попробуй ещё раз')) }
  const shareRow = (final: boolean) => (
    <div className="month-share">
      {canStory() && <button className={final ? 'btn' : 'btn btn-ghost'} onClick={story}>{final ? 'Итог в истории' : 'В истории'}</button>}
      <button className="btn btn-ghost" disabled={sent} onClick={toChat}>{sent ? 'Карточка придёт в чат' : 'Карточкой в чат'}</button>
    </div>
  )
  const showLast = b.last && new Date().getDate() <= 7
  const rows = scope === 'friends' ? b.friends : b.top
  return (
    <>
      {showLast && b.last && (
        <section className="card month-final">
          <h2>{b.last.emoji} Итог: «{b.last.title}»</h2>
          <p>{days(b.last.score ?? 0, b.last.unit)} · {b.last.rank}-е место из {b.last.total}{b.last.done ? ' · цель взята 🎉' : ''}</p>
          {shareRow(true)}
        </section>
      )}
      <section className="card league month">
        <div className="league-head">
          <span className="league-medal" aria-hidden="true">{b.emoji}</span>
          <div><h2>{b.title}</h2><span className="sub">Челлендж {monthOf(b.month)} · {left(b.ends_at)}</span></div>
        </div>
        <p className="sub">{b.hint} Цель — {days(b.goal, b.unit)}: +100 XP. Участников: {b.total}.</p>
        {b.me ? <>
          <div className="month-me">
            <b>{b.me.score}</b><span>из {b.goal} · {b.me.rank}-е место{b.total >= 10 ? ` · топ-${b.me.top_percent} %` : ''}</span>
          </div>
          <Bar value={b.me.score} goal={b.goal} />
          {!showLast && shareRow(false)}
        </> : <button className="btn" onClick={join}>Участвовать</button>}
        {b.friends.length > 1 && (
          <div className="seg seg-row" role="tablist">
            <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>Все</button>
            <button aria-pressed={scope === 'friends'} onClick={() => setScope('friends')}>Друзья</button>
          </div>
        )}
        {rows.length ? <List rows={rows} /> : <p className="sub">Пока никого. Будь первым.</p>}
        {scope === 'all' && b.me && b.me.rank > b.top.length && <p className="sub">Ты на {b.me.rank}-м месте — до топ-10 не хватает {Math.max(1, (b.top[b.top.length - 1]?.score ?? 0) - b.me.score + 1)} дн.</p>}
      </section>
    </>
  )
}
