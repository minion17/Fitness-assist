import { useEffect, useState } from 'react'
import { nutrition, profile, progress, workout } from './demo'
import Questionnaire from './Questionnaire'
import { GOALS, YEAR, type ProfileData, type Targets } from './profile'
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

// Demo intake stays until the diary exists; goals come from the questionnaire when filled.
const calGoal = (t?: Targets) => t?.calories ?? nutrition.calories.goal

function Home({ go, targets }: { go: (t: Tab) => void; targets?: Targets }) {
  const c = { eaten: nutrition.calories.eaten, goal: calGoal(targets) }
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

const MACRO_KEY = { 'Белки': 'protein', 'Жиры': 'fat', 'Углеводы': 'carbs' } as const

function Food({ targets }: { targets?: Targets }) {
  const c = { eaten: nutrition.calories.eaten, goal: calGoal(targets) }
  return (
    <>
      <h1>Питание</h1>
      <section className="card">
        <div className="card-head"><h2>КБЖУ за сегодня</h2><span className="sub">{c.eaten} / {c.goal}</span></div>
        <div className="ring-wrap">
          <Ring value={c.eaten} goal={c.goal} />
          <div className="macros">
            {nutrition.macros.map((m) => ({ ...m, goal: targets?.[MACRO_KEY[m.key as keyof typeof MACRO_KEY]] ?? m.goal })).map((m) => (
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

type Progress = { xp: number; level: number; level_xp: number; level_xp_needed: number }
const NEW_USER: Progress = { xp: 0, level: 1, level_xp: 0, level_xp_needed: 100 }

function LevelCard({ p }: { p: Progress }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Уровень {p.level}</h2>
        <span className="sub">{p.xp} XP всего</span>
      </div>
      <Bar value={p.level_xp} goal={p.level_xp_needed} />
      <span className="sub">{p.level_xp} / {p.level_xp_needed} XP до уровня {p.level + 1}</span>
    </section>
  )
}

function Profile({ synced, progress, data, onEdit }: { synced: string; progress: Progress; data: ProfileData | null; onEdit: () => void }) {
  const shown = data
    ? { age: YEAR - data.birth_year, height: data.height_cm, weight: data.weight_kg, goal: GOALS[data.goal] }
    : profile
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
      <LevelCard p={progress} />
      <div className="grid2">
        <section className="card"><span className="sub">Возраст</span><div className="stat">{shown.age}<small>лет</small></div></section>
        <section className="card"><span className="sub">Рост</span><div className="stat">{shown.height}<small>см</small></div></section>
        <section className="card"><span className="sub">Вес</span><div className="stat">{shown.weight}<small>кг</small></div></section>
        <section className="card"><span className="sub">Цель</span><div className="row-title" style={{ marginTop: 6 }}>{shown.goal}</div></section>
      </div>
      {data?.targets && (
        <section className="card">
          <h2>Дневная норма</h2>
          <div className="list">
            <div className="row"><div className="row-main row-title">Калории</div><div className="row-end">{data.targets.calories} ккал</div></div>
            <div className="row"><div className="row-main row-title">Белки</div><div className="row-end">{data.targets.protein} г</div></div>
            <div className="row"><div className="row-main row-title">Жиры</div><div className="row-end">{data.targets.fat} г</div></div>
            <div className="row"><div className="row-main row-title">Углеводы</div><div className="row-end">{data.targets.carbs} г</div></div>
          </div>
        </section>
      )}
      <button className="btn btn-ghost" onClick={onEdit}>{data ? 'Изменить анкету' : 'Заполнить анкету'}</button>
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
  const [xp, setXp] = useState<Progress>(NEW_USER)
  const [me, setMe] = useState<ProfileData | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    initTelegram()
    api<{ id: number; progress: Progress; profile: ProfileData | null }>('/api/auth', { method: 'POST' })
      .then((u) => {
        if (!u) return
        setSynced('Аккаунт подключён')
        setXp(u.progress)
        setMe(u.profile)
        setEditing(!u.profile) // first visit: questionnaire before anything else
      })
      .catch(() => setSynced('Сервер недоступен'))
  }, [])

  const go = (t: Tab) => {
    tg?.HapticFeedback?.selectionChanged()
    setTab(t)
    window.scrollTo(0, 0)
  }

  async function saveProfile(p: ProfileData) {
    // Outside Telegram (demo) there is no account: keep answers in memory only.
    const saved = await api<ProfileData>('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    })
    setMe(saved ?? p)
    setEditing(false)
    window.scrollTo(0, 0)
  }

  if (editing) {
    return (
      <div className="app">
        <Questionnaire initial={me} onSave={saveProfile} onCancel={me ? () => setEditing(false) : undefined} />
      </div>
    )
  }

  return (
    <div className="app">
      <main className="screen" key={tab}>
        {tab === 'home' && <Home go={go} targets={me?.targets} />}
        {tab === 'food' && <Food targets={me?.targets} />}
        {tab === 'workouts' && <Workouts />}
        {tab === 'profile' && <Profile synced={synced} progress={xp} data={me} onEdit={() => setEditing(true)} />}
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
