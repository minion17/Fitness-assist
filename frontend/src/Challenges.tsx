// Group challenges among friends: tick a day, see everyone's progress, XP at the end for 80%+.
import { useCallback, useEffect, useState } from 'react'
import { api, postJson } from './telegram'
import { Bar } from './ui'
import { haptic } from './haptics'

type Member = { name: string; me: boolean; joined: boolean; done: number; today: boolean }
type Ch = { id: number; title: string; emoji: string; days: number; day: number; end_day: string; finished: boolean; mine: boolean; invited: boolean; members: Member[] }
const TEMPLATES = [
  { emoji: '🍬', title: 'Без сладкого' }, { emoji: '🏃', title: 'Зарядка каждый день' }, { emoji: '👟', title: '10 000 шагов' },
  { emoji: '🍔', title: 'Без фастфуда' }, { emoji: '💧', title: '2 литра воды' }, { emoji: '😴', title: 'Спать до 23:00' },
]

export default function Challenges({ friends }: { friends: { id: number; name: string }[] }) {
  const [list, setList] = useState<Ch[] | null>(null)
  const [form, setForm] = useState<{ emoji: string; title: string; days: number; ids: number[] } | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => api<Ch[]>('/api/challenges').then((r) => setList(Array.isArray(r) ? r : [])).catch(() => setList([])), [])
  useEffect(() => { load() }, [load])

  async function act(run: () => Promise<unknown>) {
    setError('')
    try { await run(); await load() } catch (e) { setError(e instanceof Error && e.message ? e.message : 'Не получилось') }
  }
  function tick(c: Ch, done: boolean) {
    haptic('light')
    setList((l) => l?.map((x) => (x.id === c.id ? { ...x, members: x.members.map((m) => (m.me ? { ...m, today: done, done: m.done + (done ? 1 : -1) } : m)) } : x)) ?? l)
    act(() => api(`/api/challenges/${c.id}/check`, postJson({ done })))
  }

  if (list === null) return null
  return (
    <section className="card challenges">
      <div className="card-head"><h2>Челленджи</h2>
        {friends.length > 0 && !form && <button className="link" onClick={() => setForm({ ...TEMPLATES[0], days: 7, ids: [] })}>+ Новый</button>}</div>
      {!list.length && !form && <p className="sub">{friends.length ? 'Вместе с друзьями: «Без сладкого», «Зарядка» — отмечаешься каждый день, видишь прогресс друг друга. За 80% дней — +50 XP.' : 'Позови друга — и запускай челленджи вместе.'}</p>}
      {form && (
        <div className="challenge-form">
          <div className="habit-chips">
            {TEMPLATES.map((t) => <button key={t.title} className="habit-chip" aria-pressed={form.title === t.title} onClick={() => setForm({ ...form, ...t })}>{t.emoji} {t.title}</button>)}
          </div>
          <div className="input-wrap"><input aria-label="Название челленджа" maxLength={60} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value, emoji: '🔥' })} /></div>
          <div className="seg seg-row">
            {[7, 14, 30].map((d) => <button key={d} aria-pressed={form.days === d} onClick={() => setForm({ ...form, days: d })}>{d} дней</button>)}
          </div>
          <span className="sub">Кого позвать</span>
          <div className="habit-chips">
            {friends.map((f) => (
              <button key={f.id} className="habit-chip" aria-pressed={form.ids.includes(f.id)}
                onClick={() => setForm({ ...form, ids: form.ids.includes(f.id) ? form.ids.filter((x) => x !== f.id) : [...form.ids, f.id] })}>{f.name}</button>
            ))}
          </div>
          <button className="btn" disabled={!form.ids.length || form.title.trim().length < 2}
            onClick={() => act(() => api('/api/challenges', postJson({ title: form.title, emoji: form.emoji, days: form.days, friend_ids: form.ids }))).then(() => setForm(null))}>
            Позвать {form.ids.length ? `(${form.ids.length})` : ''}
          </button>
          <button className="link" onClick={() => setForm(null)}>Отмена</button>
        </div>
      )}
      {list.map((c) => {
        const me = c.members.find((m) => m.me)
        const joined = c.members.filter((m) => m.joined)
        return (
          <div className="challenge" key={c.id}>
            <div className="challenge-head">
              <span className="challenge-emoji" aria-hidden="true">{c.emoji}</span>
              <div><b>{c.title}</b><span className="sub">{c.finished ? 'Завершён' : `День ${c.day} из ${c.days}`}</span></div>
              {me?.joined && !c.finished && (
                <button className="habit-chip" aria-pressed={me.today} onClick={() => tick(c, !me.today)}>{me.today ? '✓ Сегодня' : 'Отметить день'}</button>
              )}
            </div>
            {c.invited ? (
              <div className="row-actions">
                <button className="btn" onClick={() => act(() => api(`/api/challenges/${c.id}/join`, { method: 'POST' }))}>Принять</button>
                <button className="link" onClick={() => act(() => api(`/api/challenges/${c.id}/leave`, { method: 'POST' }))}>Отказаться</button>
              </div>
            ) : joined.map((m) => (
              <div className="challenge-member" key={m.name}>
                <span>{m.name}{m.today ? ' ✓' : ''}</span>
                <Bar value={m.done} goal={c.days} />
                <span className="sub">{m.done}/{c.days}</span>
              </div>
            ))}
            {!c.invited && c.members.some((m) => !m.joined) && <span className="sub">Ждём ответа: {c.members.filter((m) => !m.joined).map((m) => m.name).join(', ')}</span>}
          </div>
        )
      })}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
