import { useCallback, useEffect, useRef, useState } from 'react'
import { demoFoodDay, demoMeasurements, demoPrograms, profile } from './demo'
import AiSummary from './AiSummary'
import Body, { type MeasurementInput } from './Body'
import Food from './Food'
import Home, { type FoodIntent, type Water, type WeekDay } from './Home'
import Reminders from './Reminders'
import Progress, { type Achievement } from './Progress'
import Reward, { AchievementUnlocked } from './Reward'
import { ACCENTS, LIGHT, THEMES, useTheme, type ThemePref, type ThemeSettings } from './theme'
import Questionnaire from './Questionnaire'
import { GOALS, YEAR, type ProfileData, type Recommendation } from './profile'
import { api, initTelegram, postJson, publicGet, putJson, tg, tgUser } from './telegram'
import type { FoodDay, MealType, Measurement, Program, WorkoutLog } from './types'
import { Bar } from './ui'
import Workouts from './Workouts'

type Tab = 'home' | 'food' | 'workouts' | 'progress' | 'profile'

const ICONS: Record<Tab, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  food: 'M7 3v8a2 2 0 0 0 2 2v8M5 3v5M9 3v5M17 3c-2 0-3 2-3 5s1 4 3 4v9',
  workouts: 'M6 8v8M3 10v4M18 8v8M21 10v4M6 12h12',
  progress: 'M4 20V11M10 20V5M16 20v-6M3 20h18',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6',
}
const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: 'Главная' },
  { id: 'food', label: 'Питание' },
  { id: 'workouts', label: 'Тренировки' },
  { id: 'progress', label: 'Прогресс' },
  { id: 'profile', label: 'Профиль' },
]

const name = tgUser?.first_name ?? 'Гость'
const PROGRAM_KEY = 'fa.programId'

type Progress = { xp: number; level: number; level_xp: number; level_xp_needed: number }
const NEW_USER: Progress = { xp: 0, level: 1, level_xp: 0, level_xp_needed: 100 }

function LevelCard({ p }: { p: Progress }) {
  return (
    <section className="card profile-level">
      <div className="card-head">
        <h2>Уровень {p.level}</h2>
        <span className="sub">{p.xp} XP всего</span>
      </div>
      <Bar value={p.level_xp} goal={p.level_xp_needed} />
      <span className="sub">{p.level_xp} / {p.level_xp_needed} XP до уровня {p.level + 1}</span>
    </section>
  )
}

function ThemeCard({ t }: { t: ReturnType<typeof useTheme> }) {
  return (
    <section className="card theme-card">
      <h2>Оформление</h2>
      <div className="seg">
        {(Object.keys(THEMES) as ThemePref[]).map((p) => (
          <button key={p} aria-pressed={t.pref === p} onClick={() => t.setPref(p)}>{THEMES[p]}</button>
        ))}
      </div>
      {t.theme !== 'green' && (
        <div className="swatches" role="group" aria-label="Акцентный цвет">
          {ACCENTS.map((a) => (
            <button key={a} aria-label={`Акцент ${a}`} aria-pressed={t.accent === a} style={{ background: t.theme === 'light' ? LIGHT[a].fill : a }} onClick={() => t.setAccent(a)} />
          ))}
        </div>
      )}
    </section>
  )
}

function Profile({ synced, progress, data, onEdit, body, theme, canEdit }: {
  synced: string; progress: Progress; data: ProfileData | null; onEdit: () => void; body: React.ReactNode
  theme: ReturnType<typeof useTheme>
  canEdit: boolean
}) {
  const shown = data
    ? { age: YEAR - data.birth_year, height: data.height_cm, weight: data.weight_kg, goal: GOALS[data.goal] }
    : profile
  return (
    <>
      <section className="card profile-identity">
        <div className="profile-person">
        <div className="avatar">{tgUser?.photo_url ? <img src={tgUser.photo_url} alt="" /> : name[0]}</div>
        <div>
          <h1 style={{ fontSize: 22 }}>{name}</h1>
          <div className="sub">{tgUser?.username ? `@${tgUser.username}` : 'Открыто вне Telegram'}</div>
          <div className="sub">{synced}</div>
        </div>
        </div>
        <LevelCard p={progress} />
      </section>
      <section className="card profile-overview">
        <div className="card-head"><h2>Мои данные</h2><button className="link" aria-label={data ? 'Изменить анкету' : 'Заполнить анкету'} onClick={onEdit}>{data ? 'Изменить' : 'Заполнить'}</button></div>
      <div className="grid2 profile-metrics">
        <section className="card"><span className="sub">Возраст</span><div className="stat">{shown.age}<small>лет</small></div></section>
        <section className="card"><span className="sub">Рост</span><div className="stat">{shown.height}<small>см</small></div></section>
        <section className="card"><span className="sub">Вес</span><div className="stat">{shown.weight}<small>кг</small></div></section>
        <section className="card"><span className="sub">Цель</span><div className="row-title" style={{ marginTop: 6 }}>{shown.goal}</div></section>
      </div>
      </section>
      {data?.targets && (
        <section className="card profile-targets">
          <h2>Дневная норма</h2>
          <div className="list">
            <div className="row"><div className="row-main row-title">Калории</div><div className="row-end">{data.targets.calories} ккал</div></div>
            <div className="row"><div className="row-main row-title">Белки</div><div className="row-end">{data.targets.protein} г</div></div>
            <div className="row"><div className="row-main row-title">Жиры</div><div className="row-end">{data.targets.fat} г</div></div>
            <div className="row"><div className="row-main row-title">Углеводы</div><div className="row-end">{data.targets.carbs} г</div></div>
          </div>
        </section>
      )}
      {canEdit && <Reminders />}
      <ThemeCard t={theme} />
      {body}
    </>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>('home')
  const [synced, setSynced] = useState('Демо-режим')
  const [xp, setXp] = useState<Progress>(NEW_USER)
  const [boostUntil, setBoostUntil] = useState<string | null>(null) // x2 XP after a duel win
  const [me, setMe] = useState<ProfileData | null>(null)
  const [editing, setEditing] = useState(false)
  const [canEdit, setCanEdit] = useState(false)
  const [foodDay, setFoodDay] = useState<FoodDay>(demoFoodDay)
  const [programs, setPrograms] = useState<Program[] | null>(null)
  const [logs, setLogs] = useState<WorkoutLog[]>([])
  // kept on the account (see /api/settings); localStorage only until the account loads
  const [programId, setProgramId] = useState<number | null>(() => {
    try { return Number(localStorage.getItem(PROGRAM_KEY)) || null } catch { return null }
  })
  const [toast, setToast] = useState('')
  const [measurements, setMeasurements] = useState<Measurement[]>([])
  const [aiEnabled, setAiEnabled] = useState(false)
  const [recommended, setRecommended] = useState<Recommendation | null>(null)
  const [water, setWater] = useState<Water>({ ml: 0, goal_ml: 2000 })
  const [week, setWeek] = useState<{ streak: number; days: WeekDay[] }>({ streak: 0, days: [] })
  const [ach, setAch] = useState<{ items: Achievement[]; new: Achievement[]; freezes: number }>({ items: [], new: [], freezes: 0 })
  const [foodIntent, setFoodIntent] = useState<FoodIntent | null>(null)
  const [reward, setReward] = useState(false)
  const theme = useTheme((patch) => { api('/api/settings', putJson(patch)).catch(() => {}) })
  // latest values for the one-time startup effect (it must not re-run when they change)
  const startup = useRef({ theme, programId, selectProgram: (_id: number | null, _sync?: boolean) => {} })
  useEffect(() => { startup.current = { theme, programId, selectProgram } })
  // Level known before the latest refresh; null until the account is loaded, so the first load never celebrates.
  const knownLevel = useRef<number | null>(null)
  useEffect(() => {
    if (knownLevel.current !== null && xp.level > knownLevel.current) setReward(true)
    if (knownLevel.current !== null) knownLevel.current = xp.level
  }, [xp.level])

  const refreshJournal = useCallback(async () => {
    const [day, ws, ms, u, wt, wk, ac] = await Promise.all([
      api<FoodDay>('/api/food-logs'),
      api<WorkoutLog[]>('/api/workout-logs'),
      api<Measurement[]>('/api/measurements'),
      api<{ progress: Progress; profile: ProfileData | null; recommended_program: Recommendation | null }>('/api/auth', { method: 'POST' }),
      api<Water>('/api/water'),
      api<{ streak: number; days: WeekDay[] }>('/api/week'),
      api<{ items: Achievement[]; new: Achievement[]; freezes: number }>('/api/achievements').catch(() => null),
    ])
    if (ac) setAch(ac)
    if (wt) setWater(wt)
    if (wk) setWeek(wk)
    if (day) setFoodDay(day)
    if (ws) setLogs(ws)
    if (ms) setMeasurements(ms)
    if (u) { setXp(u.progress); setMe(u.profile); setRecommended(u.recommended_program) } // weight changes the daily targets
  }, [])

  useEffect(() => {
    initTelegram()
    api<{ id: number; progress: Progress; profile: ProfileData | null; recommended_program: Recommendation | null; settings: ThemeSettings & { program_id: number | null; boost_until?: string | null } }>('/api/auth', { method: 'POST' })
      .then((u) => {
        if (!u) return
        setSynced('Аккаунт подключён')
        setCanEdit(true)
        knownLevel.current = u.progress.level
        startup.current.theme.load(u.settings)
        setBoostUntil(u.settings.boost_until ?? null)
        const local = startup.current.programId
        if (u.settings.program_id) startup.current.selectProgram(u.settings.program_id, false)
        else if (local) api('/api/settings', putJson({ program_id: local })).catch(() => {}) // upload this device's choice once
        setXp(u.progress)
        setMe(u.profile)
        setRecommended(u.recommended_program)
        setEditing(!u.profile) // first visit: questionnaire before anything else
        setFoodDay({ date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } })
        api<{ enabled: boolean }>('/api/ai/status').then((s) => setAiEnabled(Boolean(s?.enabled))).catch(() => {})
        return refreshJournal()
      })
      .catch(() => setSynced('Сервер недоступен'))
    const programsRequest = tg?.initData ? api<Program[]>('/api/programs').then(p => p ?? []) : publicGet<Program[]>('/api/programs')
    programsRequest.then(setPrograms)
      .catch(() => setPrograms(demoPrograms))
  }, [refreshJournal])

  function flash(text: string) {
    setToast(text)
    setTimeout(() => setToast(''), 2500)
  }

  async function addFood(productId: number, grams: number, meal: MealType, slot?: string | null) {
    const r = await api<{ xp_awarded: number }>('/api/food-logs', postJson({ product_id: productId, amount_g: grams, meal_type: meal, ...(slot ? { snack_slot: slot } : {}) }))
    await refreshJournal()
    flash(r?.xp_awarded ? `Добавлено · +${r.xp_awarded} XP` : 'Добавлено')
  }

  async function copyMeal(fromDay: string, meal: MealType) {
    const r = await api<{ copied: number; xp_awarded: number }>('/api/food-logs/copy', postJson({ from_day: fromDay, meal_type: meal }))
    await refreshJournal()
    flash(r?.xp_awarded ? `Повторено · +${r.xp_awarded} XP` : 'Повторено')
  }

  async function aiMealDone(xpAwarded: number) {
    await refreshJournal()
    flash(xpAwarded ? `Добавлено · +${xpAwarded} XP` : 'Добавлено')
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

  async function changeWater(delta: number) {
    tg?.HapticFeedback?.impactOccurred?.('light')
    const r = await api<Water & { xp_awarded: number }>('/api/water', postJson({ delta_ml: delta }))
    if (!r) { // demo mode: local only
      setWater((w) => ({ ...w, ml: Math.max(0, w.ml + delta) }))
      return
    }
    setWater(r)
    if (r.xp_awarded) {
      flash(`Норма воды · +${r.xp_awarded} XP`)
      await refreshJournal()
    } else {
      api<{ streak: number; days: WeekDay[] }>('/api/week').then((wk) => wk && setWeek(wk)).catch(() => {})
    }
  }

  function selectProgram(id: number | null, sync = true) {
    setProgramId(id)
    if (sync) api('/api/settings', putJson({ program_id: id })).catch(() => {})
    try { if (id) localStorage.setItem(PROGRAM_KEY, String(id)); else localStorage.removeItem(PROGRAM_KEY) } catch { /* private mode */ }
  }

  const program = programs?.find((p) => p.id === programId)

  const go = (t: Tab) => {
    tg?.HapticFeedback?.selectionChanged()
    setFoodIntent(null)
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
    if (saved) refreshJournal().catch(() => {}) // new answers -> new program recommendation
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
        {tab === 'home' && (
          <Home name={name} level={xp.level} boostUntil={boostUntil} streak={week.streak} targets={me?.targets} day={foodDay} program={program} logs={logs}
            water={water} week={week.days} aiEnabled={aiEnabled} canEdit={canEdit}
            onFood={(i) => { go('food'); setFoodIntent(i) }} onNutrition={() => go('food')} onWorkouts={() => go('workouts')} onWater={changeWater}
            summary={aiEnabled && <AiSummary />} />
        )}
        {tab === 'food' && <Food day={foodDay} targets={me?.targets} canEdit={canEdit} onAdd={addFood} onDelete={deleteFood} aiEnabled={aiEnabled} onAiDone={aiMealDone} intent={foodIntent} onCopy={copyMeal} />}
        {tab === 'workouts' && (
          <Workouts programs={programs} logs={logs} programId={programId} onSelectProgram={selectProgram} recommended={recommended}
            canEdit={canEdit} onChanged={workoutChanged} onProgramsChange={setPrograms} />
        )}
        {tab === 'progress' && (
          <Progress canEdit={canEdit} achievements={ach.items} freezes={ach.freezes}
            body={<Body measurements={canEdit ? measurements : demoMeasurements} canEdit={canEdit} hideWeight={canEdit} onSave={saveMeasurement} onDelete={deleteMeasurement} />} />
        )}
        {tab === 'profile' && (
          <Profile synced={synced} progress={xp} data={me} onEdit={() => setEditing(true)} theme={theme} canEdit={canEdit} body={null} />
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
      {!reward && ach.new.length > 0 && (
        <AchievementUnlocked {...ach.new[0]} more={ach.new.length - 1} onClose={() => {
          setAch((a) => ({ ...a, new: [] }))
          api('/api/achievements/seen', { method: 'POST' }).catch(() => {})
          refreshJournal().catch(() => {}) // +25 XP may have raised the level
        }} />
      )}
      {reward && <Reward level={xp.level} levelXp={xp.level_xp} needed={xp.level_xp_needed} streak={week.streak} onClose={() => setReward(false)} />}
    </div>
  )
}
