import { useCallback, useEffect, useState } from 'react'
import { demoFoodDay, demoMeasurements, demoPrograms, profile } from './demo'
import Body, { type MeasurementInput } from './Body'
import Food from './Food'
import Questionnaire from './Questionnaire'
import { GOALS, YEAR, type ProfileData, type Targets } from './profile'
import { api, initTelegram, postJson, publicGet, tg, tgUser } from './telegram'
import { completedThisWeek, nextDay, weightTrend, type FoodDay, type MealType, type Measurement, type Program, type WorkoutLog } from './types'
import { Bar } from './ui'
import Workouts from './Workouts'

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
const PROGRAM_KEY = 'fa.programId'

function Home({ go, targets, day, program, logs, measurements, weight }: {
  go: (t: Tab) => void; targets?: Targets; day: FoodDay; program?: Program; logs: WorkoutLog[]
  measurements: Measurement[]; weight?: number
}) {
  const trend = weightTrend(measurements)
  const goal = targets?.calories ?? 2000
  const next = program && nextDay(program, logs)
  return (
    <>
      <div>
        <p className="hello">Сегодня</p>
        <h1>Привет, {name}</h1>
      </div>
      <section className="card">
        <div className="card-head"><h2>Питание</h2><button className="link" onClick={() => go('food')}>Открыть</button></div>
        <div className="stat">{Math.round(day.totals.kcal)}<small>/ {goal} ккал</small></div>
        <Bar value={day.totals.kcal} goal={goal} />
      </section>
      <section className="card">
        <div className="card-head"><h2>Тренировка дня</h2><button className="link" onClick={() => go('workouts')}>Открыть</button></div>
        {next ? (
          <>
            <div className="row-title">{next.day_name}</div>
            <div className="sub">{next.exercises.length} упражнения · {program.name}</div>
          </>
        ) : <div className="sub">Выберите программу тренировок</div>}
      </section>
      <div className="grid2">
        <section className="card">
          <span className="sub">Вес</span>
          <div className="stat">{trend?.latest ?? weight ?? profile.weight}<small>кг</small></div>
          {trend?.delta != null
            ? <span className={trend.delta <= 0 ? 'sub pos' : 'sub'}>{trend.delta > 0 ? '+' : ''}{trend.delta} кг за месяц</span>
            : <button className="link" style={{ textAlign: 'left' }} onClick={() => go('profile')}>Записать вес</button>}
        </section>
        <section className="card">
          <span className="sub">Тренировки</span>
          <div className="stat">{completedThisWeek(logs)}<small>/ {program?.days_per_week ?? 3}</small></div>
          <Bar value={completedThisWeek(logs)} goal={program?.days_per_week ?? 3} />
        </section>
      </div>
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

function Profile({ synced, progress, data, onEdit, body }: {
  synced: string; progress: Progress; data: ProfileData | null; onEdit: () => void; body: React.ReactNode
}) {
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
      {body}
    </>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>('home')
  const [synced, setSynced] = useState('Демо-режим')
  const [xp, setXp] = useState<Progress>(NEW_USER)
  const [me, setMe] = useState<ProfileData | null>(null)
  const [editing, setEditing] = useState(false)
  const [canEdit, setCanEdit] = useState(false)
  const [foodDay, setFoodDay] = useState<FoodDay>(demoFoodDay)
  const [programs, setPrograms] = useState<Program[] | null>(null)
  const [logs, setLogs] = useState<WorkoutLog[]>([])
  // shortcut: chosen program is remembered per device; move to the user's profile when it must sync across devices
  const [programId, setProgramId] = useState<number | null>(() => {
    try { return Number(localStorage.getItem(PROGRAM_KEY)) || null } catch { return null }
  })
  const [toast, setToast] = useState('')
  const [measurements, setMeasurements] = useState<Measurement[]>([])

  const refreshJournal = useCallback(async () => {
    const [day, ws, ms, u] = await Promise.all([
      api<FoodDay>('/api/food-logs'),
      api<WorkoutLog[]>('/api/workout-logs'),
      api<Measurement[]>('/api/measurements'),
      api<{ progress: Progress; profile: ProfileData | null }>('/api/auth', { method: 'POST' }),
    ])
    if (day) setFoodDay(day)
    if (ws) setLogs(ws)
    if (ms) setMeasurements(ms)
    if (u) { setXp(u.progress); setMe(u.profile) } // weight changes the daily targets
  }, [])

  useEffect(() => {
    initTelegram()
    api<{ id: number; progress: Progress; profile: ProfileData | null }>('/api/auth', { method: 'POST' })
      .then((u) => {
        if (!u) return
        setSynced('Аккаунт подключён')
        setCanEdit(true)
        setXp(u.progress)
        setMe(u.profile)
        setEditing(!u.profile) // first visit: questionnaire before anything else
        setFoodDay({ date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } })
        return refreshJournal()
      })
      .catch(() => setSynced('Сервер недоступен'))
    publicGet<Program[]>('/api/programs')
      .then(setPrograms)
      .catch(() => setPrograms(demoPrograms))
  }, [refreshJournal])

  function flash(text: string) {
    setToast(text)
    setTimeout(() => setToast(''), 2500)
  }

  async function addFood(productId: number, grams: number, meal: MealType) {
    const r = await api<{ xp_awarded: number }>('/api/food-logs', postJson({ product_id: productId, amount_g: grams, meal_type: meal }))
    await refreshJournal()
    flash(r?.xp_awarded ? `Добавлено · +${r.xp_awarded} XP` : 'Добавлено')
  }

  async function deleteFood(id: number) {
    await api(`/api/food-logs/${id}`, { method: 'DELETE' })
    await refreshJournal()
  }

  async function saveMeasurement(m: MeasurementInput) {
    const r = await api<{ xp_awarded: number }>('/api/measurements', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m),
    })
    await refreshJournal()
    flash(r?.xp_awarded ? `Замер сохранён · +${r.xp_awarded} XP` : 'Замер сохранён')
  }

  async function deleteMeasurement(id: number) {
    await api(`/api/measurements/${id}`, { method: 'DELETE' })
    await refreshJournal()
  }

  async function workoutChanged(xpAwarded: number) {
    await refreshJournal()
    if (xpAwarded) flash(`Тренировка завершена · +${xpAwarded} XP`)
  }

  function selectProgram(id: number | null) {
    setProgramId(id)
    try { if (id) localStorage.setItem(PROGRAM_KEY, String(id)); else localStorage.removeItem(PROGRAM_KEY) } catch { /* private mode */ }
  }

  const program = programs?.find((p) => p.id === programId)

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
        {tab === 'home' && <Home go={go} targets={me?.targets} day={foodDay} program={program} logs={logs} measurements={measurements} weight={me?.weight_kg} />}
        {tab === 'food' && <Food day={foodDay} targets={me?.targets} canEdit={canEdit} onAdd={addFood} onDelete={deleteFood} />}
        {tab === 'workouts' && (
          <Workouts programs={programs} logs={logs} programId={programId} onSelectProgram={selectProgram}
            canEdit={canEdit} onChanged={workoutChanged} />
        )}
        {tab === 'profile' && (
          <Profile synced={synced} progress={xp} data={me} onEdit={() => setEditing(true)}
            body={<Body measurements={canEdit ? measurements : demoMeasurements} canEdit={canEdit} onSave={saveMeasurement} onDelete={deleteMeasurement} />} />
        )}
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
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
