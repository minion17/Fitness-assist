// Weekly league: 20 people of one tier by XP this week; top 5 go up, bottom 5 go down.
import { useEffect, useState } from 'react'
import { api } from './telegram'

type Board = {
  tier: number; tier_name: string; next_tier: string | null; ends_at: string; promote: number; demote: number
  members: { rank: number; name: string; xp: number; me: boolean }[]
}
const MEDALS = ['🥉', '🥈', '🥇', '💠', '💎']

function left(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5)
  return ms <= 0 ? 'подводим итоги' : d > 0 ? `ещё ${d} д ${h} ч` : `ещё ${h} ч`
}

export default function League() {
  const [b, setB] = useState<Board | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { api<Board>('/api/league').then(setB).catch(() => setError('Нет связи — лигу покажем, как только вернётся интернет')) }, [])
  if (error) return <p className="error">{error}</p>
  if (!b) return <p className="sub">Загружаем лигу…</p>
  const n = b.members.length
  return (
    <section className="card league">
      <div className="league-head">
        <span className="league-medal" aria-hidden="true">{MEDALS[b.tier]}</span>
        <div><h2>Лига «{b.tier_name}»</h2><span className="sub">{left(b.ends_at)} · XP за эту неделю</span></div>
      </div>
      <p className="sub">{b.promote ? `Первые ${b.promote} поднимутся в «${b.next_tier}»` : 'Это высшая лига — держитесь в ней'}
        {b.demote ? `, последние ${b.demote} опустятся.` : '.'} XP дают еда, вода, тренировки, задания.</p>
      {n === 1 && <p className="sub">Вы первый в группе на этой неделе — соперники появятся, когда зайдут другие.</p>}
      <ol className="league-list">
        {b.members.map((m) => (
          <li key={m.rank} className={[m.me ? 'me' : '', m.rank <= b.promote ? 'up' : '', b.demote && m.rank > n - b.demote ? 'down' : ''].join(' ')}>
            <span className="league-rank">{m.rank}</span>
            <span className="league-name">{m.name}</span>
            <span className="league-xp">{m.xp} XP</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
