// "Друзья" (in Прогресс): invite link, weekly leaderboard, friendly duels and a share card sent by the bot.
import { useCallback, useEffect, useState } from 'react'
import { api, postJson, tg } from './telegram'

type Row = { id: number; name: string; me: boolean; level: number; week_xp: number; streak: number; registered: boolean }
type Duel = {
  id: number; metric: 'xp' | 'workouts'; days: number; status: 'pending' | 'active' | 'done'; incoming: boolean
  rival: string; rival_id: number; ends_at: string | null; result: 'win' | 'loss' | 'draw' | null; me?: number; them?: number
}
const METRIC = { xp: 'XP', workouts: 'тренировки' }
const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000))
const dayWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дня' : 'дней')

export default function Friends() {
  const [board, setBoard] = useState<Row[] | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [duels, setDuels] = useState<Duel[]>([])
  const [challenge, setChallenge] = useState<{ friend: Row; metric: 'xp' | 'workouts'; days: 3 | 7 } | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => Promise.all([
    api<{ invite_link: string | null; board: Row[] }>('/api/friends').then((r) => { if (r) { setBoard(r.board); setLink(r.invite_link) } }),
    api<Duel[]>('/api/duels').then((r) => r && setDuels(r)),
  ]).catch(() => setError('Не удалось загрузить друзей. Проверьте соединение.')), [])
  useEffect(() => { load() }, [load])

  async function act(run: () => Promise<unknown>, done = '') {
    setError(''); setNote('')
    try { await run(); if (done) setNote(done); await load() } catch (e) { setError(e instanceof Error && e.message ? e.message : 'Не получилось. Попробуйте ещё раз.') }
  }

  function invite() {
    if (!link) return
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Давай вместе в Setly: дневник, тренировки и дуэли 💪')}`
    if (tg?.openTelegramLink) tg.openTelegramLink(url)
    else window.open(url, '_blank')
  }

  if (!board) return error ? <p className="error">{error}</p> : null
  const friends = board.filter((r) => !r.me)
  const open = duels.filter((d) => d.status !== 'done')
  const recent = duels.filter((d) => d.status === 'done').slice(0, 3)

  return (
    <>
      <section className="card friends-hero">
        <h2>{friends.length ? 'Друзья' : 'Вместе проще не бросить'}</h2>
        <p className="sub">{friends.length
          ? 'Рейтинг недели, дуэли и общий азарт.'
          : 'Отправьте другу ссылку. Когда он её откроет, вы появитесь друг у друга в списке: будет общий рейтинг недели и дуэли.'}
          {' '}+50 XP за каждого нового друга, который пользуется Setly хотя бы 3 дня.</p>
        <div className="friends-actions">
          <button className="btn" disabled={!link} onClick={invite}>Пригласить друга</button>
          <button className="btn btn-ghost" onClick={() => act(() => api('/api/share', { method: 'POST' }), 'Карточка недели придёт в чат с ботом — перешлите её кому угодно.')}>Поделиться неделей</button>
        </div>
        {!link && <p className="sub">Ссылка появится, когда бот будет запущен.</p>}
      </section>
      {note && <p className="sub friends-note" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {open.length > 0 && (
        <section className="card">
          <h2>Дуэли</h2>
          {open.map((d) => (
            <div key={d.id} className="duel">
              <div className="duel-main">
                <b>{d.rival}</b>
                <span className="sub">{METRIC[d.metric]} · {d.days} {dayWord(d.days)}{d.status === 'active' && d.ends_at ? ` · осталось ${daysLeft(d.ends_at)} ${dayWord(daysLeft(d.ends_at))}` : ''}</span>
              </div>
              {d.status === 'active' && <span className={`duel-score${(d.me ?? 0) >= (d.them ?? 0) ? ' ahead' : ''}`}>{d.me} : {d.them}</span>}
              {d.status === 'pending' && (d.incoming ? (
                <div className="duel-answer">
                  <button className="btn" onClick={() => act(() => api(`/api/duels/${d.id}/accept`, { method: 'POST' }), 'Дуэль началась!')}>Принять</button>
                  <button className="link" onClick={() => act(() => api(`/api/duels/${d.id}/decline`, { method: 'POST' }))}>Отказаться</button>
                </div>
              ) : <span className="sub">ждём ответа</span>)}
            </div>
          ))}
        </section>
      )}

      {friends.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Рейтинг недели</h2><span className="sub">XP с понедельника</span></div>
          <ol className="board">
            {board.map((r, i) => (
              <li key={r.id} className={r.me ? 'me' : ''}>
                <span className="board-place">{i + 1}</span>
                <div className="board-who">
                  <b>{r.me ? 'Вы' : r.name}</b>
                  <span className="sub">Ур. {r.level} · 🔥 {r.streak}</span>
                </div>
                <span className="board-xp">{r.week_xp.toLocaleString('ru-RU')} XP</span>
                {!r.me && !r.registered && <span className="sub">без анкеты</span>}
                {!r.me && r.registered && !open.some((d) => d.rival_id === r.id) && (
                  <button className="link" aria-label={`Вызвать ${r.name} на дуэль`} onClick={() => setChallenge({ friend: r, metric: 'xp', days: 7 })}>Дуэль</button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {challenge && (
        <section className="card duel-form" aria-label="Новая дуэль">
          <h2>Дуэль с {challenge.friend.name}</h2>
          <p className="sub">Без ставок: победитель получает +40 XP и бустер ×1,5 XP на 24 часа. Награда — если оба с Setly больше недели и оба участвовали; с одним другом — раз в 2 недели.</p>
          <div className="seg seg-row" role="group" aria-label="Что считаем">
            {(['xp', 'workouts'] as const).map((m) => <button key={m} aria-pressed={challenge.metric === m} onClick={() => setChallenge({ ...challenge, metric: m })}>{m === 'xp' ? 'XP' : 'Тренировки'}</button>)}
          </div>
          <div className="seg seg-row" role="group" aria-label="Срок">
            {([3, 7] as const).map((n) => <button key={n} aria-pressed={challenge.days === n} onClick={() => setChallenge({ ...challenge, days: n })}>{n} {dayWord(n)}</button>)}
          </div>
          <div className="friends-actions">
            <button className="btn" onClick={() => act(async () => {
              await api('/api/duels', postJson({ friend_id: challenge.friend.id, metric: challenge.metric, days: challenge.days }))
              setChallenge(null)
            }, 'Вызов отправлен — бот сообщит другу.')}>Вызвать</button>
            <button className="btn btn-ghost" onClick={() => setChallenge(null)}>Отмена</button>
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="card">
          <h2>Прошедшие дуэли</h2>
          {recent.map((d) => (
            <div key={d.id} className="duel">
              <div className="duel-main"><b>{d.rival}</b><span className="sub">{METRIC[d.metric]} · {d.me} : {d.them}</span></div>
              <span className={`duel-result ${d.result}`}>{d.result === 'win' ? 'Победа' : d.result === 'loss' ? 'Поражение' : 'Ничья'}</span>
            </div>
          ))}
        </section>
      )}
    </>
  )
}
