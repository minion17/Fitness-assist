import { useEffect, useState } from 'react'
import { nutrition, profile, progress, workout } from './demo'
import { api, initTelegram, tg, tgUser } from './telegram'

type Tab = 'home' | 'food' | 'workouts' | 'profile'

const ICONS: Record<Tab, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  food: 'M7 3v8a2 2 0 0 0 2 2v8M5 3v5M9 3v5M17 3c-2 0-3 2-3 5s1 4 3 4v9',
  workouts: 'M6 8v8M3 10v4M18 8v8M21 10v4M6 12h12',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6',
}
const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: 'Главная' },
  { id: 'food', label: 'Питание' },
  { id: 'workouts', label: 'Тренировки' },
  { id: 'profile', label: 'Профиль' },
]

const name = tgUser?.first_name ?? 'Гость'
const pct = (a: number, b: number) => `${Math.min(100, Math.round((a / b) * 100))}%`

function Bar({ value, goal, color = 'var(--accent)' }: { value: number; goal: number; color?: string }) {
  return (
    <div className="bar">
      <i style={{ width: pct(value, goal), background: color }} />
    </div>
  )
}

function Ring({ value, goal }: { value: number; goal: number }) {
  const r = 42
  const c = 2 * Math.PI * r
  const frac = Math.min(1, value / goal)
  return (
    <svg width="104" height="104" viewBox="0 0 104 104" role="img" aria-label={`${value} из ${goal} ккал`}>
      <circle cx="52" cy="52" r={r} fill="none" stroke="var(--card-2)" strokeWidth="9" />
      <circle cx="52" cy="52" r={r} fill="none" stroke="var(--accent)" strokeWidth="9" strokeLinecap="round"
        strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 52 52)" />
      <text x="52" y="50" textAnchor="middle" fill="var(--text)" fontSize="20" fontWeight="650">{goal - value}</text>
      <text x="52" y="67" textAnchor="middle" fill="var(--muted)" fontSize="11">ккал осталось</text>
    </svg>
  )
}

function Home({ go }: { go: (t: Tab) => void }) {
  const c = nutrition.calories
  return (
    <>
      <div>
        <p className="hello">Сегодня</p>
        <h1>Привет, {name}</h1>
      </div>
      <section className="card">
        <div className="card-head"><h2>Питание</h2><button className="link" onClick={() => go('food')}>Открыть</button></div>
        <div className="stat">{c.eaten}<small>/ {c.goal} ккал</small></div>
        <Bar value={c.eaten} goal={c.goal} />
      </section>
      <section className="card">
        <div className="card-head"><h2>Тренировка дня</h2><button className="link" onClick={() => go('workouts')}>Открыть</button></div>
        <div className="row-title">{workout.today}</div>
        <div className="sub">{workout.exercises.length} упражнения · {workout.program}</div>
      </section>
      <div className="grid2">
        <section className="card">
          <span className="sub">Вес</span>
          <div className="stat">{progress.weight}<small>кг</small></div>
          <span className="sub pos">{progress.delta} кг за месяц</span>
        </section>
        <section className="card">
          <span className="sub">Тренировки</span>
          <div className="stat">{progress.workoutsThisWeek}<small>/ {progress.workoutsGoal}</small></div>
          <Bar value={progress.workoutsThisWeek} goal={progress.workoutsGoal} />
        </section>
      </div>
    </>
  )
}

function Food() {
  const c = nutrition.calories
  return (
    <>
      <h1>Питание</h1>
      <section className="card">
        <div className="card-head"><h2>КБЖУ за сегодня</h2><span className="sub">{c.eaten} / {c.goal}</span></div>
        <div className="ring-wrap">
          <Ring value={c.eaten} goal={c.goal} />
          <div className="macros">
            {nutrition.macros.map((m) => (
              <div key={m.key}>
                <div className="macro-row"><span>{m.key}</span><span>{m.eaten} / {m.goal} г</span></div>
                <Bar value={m.eaten} goal={m.goal} color={m.color} />
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="card">
        <h2>Приёмы пищи</h2>
        <div className="list">
          {nutrition.meals.map((m) => (
            <div className="row" key={m.name}>
              <div className="row-main"><div className="row-title">{m.name} <span className="sub">· {m.time}</span></div><div className="row-sub">{m.items}</div></div>
              <div className="row-end">{m.kcal} ккал</div>
            </div>
          ))}
        </div>
      </section>
      <button className="btn" onClick={() => alert('Добавление приёма пищи появится на следующем этапе')}>+ Добавить приём пищи</button>
    </>
  )
}

function Workouts() {
  return (
    <>
      <h1>Тренировки</h1>
      <section className="card">
        <span className="chip">Неделя {workout.week}</span>
        <div><div className="row-title">{workout.program}</div><div className="sub">Сегодня: {workout.today}</div></div>
      </section>
      <section className="card">
        <h2>Упражнения</h2>
        <div className="list">
          {workout.exercises.map((e, i) => (
            <div className="row" key={e.name}>
              <div className="dot">{i + 1}</div>
              <div className="row-main"><div className="row-title">{e.name}</div><div className="row-sub">{e.sets}</div></div>
              <div className="row-end">{e.weight}</div>
            </div>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>История</h2>
        <div className="list">
          {workout.history.map((h) => (
            <div className="row" key={h.date}>
              <div className="row-main"><div className="row-title">{h.name}</div><div className="row-sub">{h.date}</div></div>
              <div className="row-end">{h.duration}</div>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

function Profile({ synced }: { synced: string }) {
  return (
    <>
      <section className="card" style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        <div className="avatar">{tgUser?.photo_url ? <img src={tgUser.photo_url} alt="" /> : name[0]}</div>
        <div>
          <h1 style={{ fontSize: 22 }}>{name}</h1>
          <div className="sub">{tgUser?.username ? `@${tgUser.username}` : 'Открыто вне Telegram'}</div>
          <div className="sub">{synced}</div>
        </div>
      </section>
      <div className="grid2">
        <section className="card"><span className="sub">Возраст</span><div className="stat">{profile.age}<small>лет</small></div></section>
        <section className="card"><span className="sub">Рост</span><div className="stat">{profile.height}<small>см</small></div></section>
        <section className="card"><span className="sub">Вес</span><div className="stat">{profile.weight}<small>кг</small></div></section>
        <section className="card"><span className="sub">Цель</span><div className="row-title" style={{ marginTop: 6 }}>{profile.goal}</div></section>
      </div>
      <section className="card">
        <h2>Параметры тела</h2>
        <div className="list">
          {profile.body.map((b) => (
            <div className="row" key={b.label}><div className="row-main row-title">{b.label}</div><div className="row-end">{b.value}</div></div>
          ))}
        </div>
      </section>
    </>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>('home')
  const [synced, setSynced] = useState('Демо-режим')

  useEffect(() => {
    initTelegram()
    api<{ id: number }>('/api/auth', { method: 'POST' })
      .then((u) => u && setSynced('Аккаунт подключён'))
      .catch(() => setSynced('Сервер недоступен'))
  }, [])

  const go = (t: Tab) => {
    tg?.HapticFeedback?.selectionChanged()
    setTab(t)
    window.scrollTo(0, 0)
  }

  return (
    <div className="app">
      <main className="screen" key={tab}>
        {tab === 'home' && <Home go={go} />}
        {tab === 'food' && <Food />}
        {tab === 'workouts' && <Workouts />}
        {tab === 'profile' && <Profile synced={synced} />}
      </main>
      <nav className="nav">
        <div className="nav-inner">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => go(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[t.id]} /></svg>
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}
