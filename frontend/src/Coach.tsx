// A coach sees a client's diary, workouts and weight because the client invited them (backend/api/coach.py).
// CoachAccess: the client's side (invite, who has access, end it). CoachClients: the coach's one screen for all clients.
import { useEffect, useState } from 'react'
import { haptic } from './haptics'
import { api, postJson, tg } from './telegram'

type Coach = { id: number; name: string; since: string | null }
type Client = {
  id: number; link_id: number; name: string; days_logged: number; kcal: number | null; kcal_pct: number | null
  protein: number | null; protein_per_kg: number | null; workouts: number; weight: number | null; weight_change: number | null
  last_workout: string | null; flags: string[]
}
type Detail = Client & {
  targets: { calories: number; protein: number; fat: number; carbs: number } | null
  days: { date: string; kcal: number; protein: number; fat: number; carbs: number; water_ml: number; workouts: number }[]
  workouts: { date: string; title: string; minutes: number; sets: number; tonnage: number; effort: string | null; after?: boolean }[]
}

const n = (x: number) => x.toLocaleString('ru-RU')
const dm = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'numeric' })
const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${String(Math.abs(x)).replace('.', ',')}`

export function CoachAccess() {
  const [coaches, setCoaches] = useState<Coach[] | null>(null)
  const [error, setError] = useState('')
  const load = () => api<Coach[]>('/api/coach/mine').then((r) => setCoaches(r ?? [])).catch(() => setCoaches([]))
  useEffect(() => { load() }, [])

  async function invite() {
    setError('')
    try {
      const r = await api<{ link: string | null }>('/api/coach/invite', { method: 'POST' })
      if (!r?.link) { setError('Бот пока не настроен. Попробуй позже'); return }
      haptic('success')
      const url = `https://t.me/share/url?url=${encodeURIComponent(r.link)}&text=${encodeURIComponent('Мой дневник питания и тренировки в Setly')}`
      if (tg?.openTelegramLink) tg.openTelegramLink(url)
      else window.open(url, '_blank')
    } catch (e) { setError(e instanceof Error && e.message ? e.message : 'Не получилось. Попробуй ещё раз') }
  }
  async function end(c: Coach) {
    await api(`/api/coach/links/${c.id}`, { method: 'DELETE' }).catch(() => {})
    load()
  }

  return (
    <section className="card coach-card" aria-label="Тренер">
      <h2>Тренер</h2>
      <p className="sub">Тренер или диетолог увидит дневник, тренировки и вес, а по понедельникам получит сводку недели.</p>
      {coaches?.map((c) => (
        <div className="row" key={c.id}>
          <div className="row-main"><span className="row-title">{c.name}</span>{c.since && <small className="sub"> · с {new Date(c.since).toLocaleDateString('ru-RU')}</small>}</div>
          <button className="link danger" onClick={() => end(c)}>Закрыть доступ</button>
        </div>
      ))}
      <button className="btn btn-ghost" onClick={invite}>{coaches?.length ? 'Пригласить ещё одного' : 'Пригласить тренера'}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}

export function CoachClients() {
  const [clients, setClients] = useState<Client[] | null>(null)
  const [open, setOpen] = useState<Detail | null>(null)
  const [note, setNote] = useState('')
  const load = () => api<Client[]>('/api/coach/clients').then((r) => setClients(r ?? [])).catch(() => setClients([]))
  useEffect(() => { load() }, [])
  useEffect(() => { // ?open=coach (the bot's buttons): straight here
    if (new URLSearchParams(window.location.search).get('open') === 'coach') document.querySelector('.coach-clients')?.scrollIntoView()
  }, [clients])
  if (!clients?.length) return null

  if (open) return (
    <section className="card coach-clients coach-detail" aria-label={`Клиент ${open.name}`}>
      <div className="card-head"><h2>{open.name}</h2><button className="link" onClick={() => { setOpen(null); setNote('') }}>← Все клиенты</button></div>
      <p className="sub">Норма: {open.targets ? `${n(open.targets.calories)} ккал · Б ${open.targets.protein} · Ж ${open.targets.fat} · У ${open.targets.carbs} г` : 'анкета не заполнена'}
        {open.weight ? ` · вес ${String(open.weight).replace('.', ',')} кг` : ''}{open.weight_change != null ? ` (${signed(open.weight_change)} за 2 нед.)` : ''}</p>
      <table className="coach-days">
        <thead><tr><th>День</th><th>Ккал</th><th>Б</th><th>Ж</th><th>У</th><th>🏋️</th></tr></thead>
        <tbody>{[...open.days].reverse().map((d) => (
          <tr key={d.date} className={d.kcal ? '' : 'coach-day-empty'}>
            <td>{dm(d.date)}</td><td>{d.kcal ? n(d.kcal) : '—'}</td><td>{d.kcal ? d.protein : ''}</td><td>{d.kcal ? d.fat : ''}</td><td>{d.kcal ? d.carbs : ''}</td><td>{d.workouts || ''}</td>
          </tr>
        ))}</tbody>
      </table>
      <h3>Тренировки за 2 недели</h3>
      {open.workouts.length ? open.workouts.map((w, i) => (
        <div className="row" key={i}><div className="row-main"><span className="row-title">{w.title}</span>
          <small className="sub"> {dm(w.date)} · {w.minutes} мин · {w.sets} подх.{w.tonnage ? ` · ${n(w.tonnage)} кг` : ''}{w.effort ? ` · ${{ easy: 'легко', ok: 'нормально', hard: 'тяжело' }[w.effort] ?? ''}` : ''}{w.after ? ' · записано после' : ''}</small></div></div>
      )) : <p className="sub">Не было.</p>}
      <button className="btn btn-ghost" onClick={() => { haptic('success'); api(`/api/coach/clients/${open.id}/report`, postJson({ days: 30 })).then(() => setNote('PDF-отчёт за 30 дней придёт тебе в чат с ботом')).catch(() => setNote('Не получилось. Попробуй ещё раз')) }}>📄 PDF-отчёт за 30 дней</button>
      {note && <p className="sub" role="status">{note}</p>}
      <button className="link danger" onClick={() => { api(`/api/coach/links/${open.link_id}`, { method: 'DELETE' }).then(() => { setOpen(null); load() }).catch(() => {}) }}>Убрать из клиентов</button>
    </section>
  )

  return (
    <section className="card coach-clients" aria-label="Мои клиенты">
      <h2>Мои клиенты · {clients.length}</h2>
      <p className="sub">Последние 7 дней. Сверху те, кому нужно внимание.</p>
      {clients.map((c) => (
        <button key={c.id} className="coach-client" onClick={() => api<Detail>(`/api/coach/clients/${c.id}`).then((d) => d && setOpen({ ...d, link_id: c.link_id }))}>
          <span className="coach-client-head"><b>{c.name}</b>{c.flags.map((f) => <i key={f} className="coach-flag">{f}</i>)}</span>
          <small>
            дневник {c.days_logged}/7{c.kcal ? ` · ${n(c.kcal)} ккал${c.kcal_pct ? ` (${c.kcal_pct} %)` : ''}` : ''}
            {c.protein_per_kg ? ` · белок ${String(c.protein_per_kg).replace('.', ',')} г/кг` : ''} · трен. {c.workouts}
            {c.weight_change != null ? ` · вес ${signed(c.weight_change)} кг` : ''}
          </small>
        </button>
      ))}
    </section>
  )
}
