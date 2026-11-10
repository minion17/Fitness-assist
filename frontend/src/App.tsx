import { useCallback, useEffect, useRef, useState } from 'react'
import { demoFoodDay, demoMeasurements, demoPrograms, profile } from './demo'
import AiSummary from './AiSummary'
import Body, { type MeasurementInput } from './Body'
import Food from './Food'
import Home, { type FoodIntent, type Water, type WeekDay } from './Home'
import Reminders from './Reminders'
import Confetti from './Confetti'
import FirstSteps from './FirstSteps'
import Quests, { type QuestWeek } from './Quests'
import Habits, { type Habit } from './Habits'
import WeekCard from './Week'
import { loadSnapshot, saveSnapshot } from './snapshot'
import { prefetchStats } from './stats'
import Progress, { type Achievement } from './Progress'
import Reward, { AchievementUnlocked } from './Reward'
import { ACCENTS, LIGHT, THEMES, useTheme, type ThemePref, type ThemeSettings } from './theme'
import Questionnaire from './Questionnaire'
import { GOALS, YEAR, type ProfileData, type Recommendation } from './profile'
import { api, initTelegram, postJson, publicGet, putJson, tg, tgUser } from './telegram'
import { MEALS, mealNow, type FoodDay, type MealType, type Measurement, type Program, type WorkoutLog } from './types'
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
type Bootstrap = {
  auth: { id: number; progress: Progress; profile: ProfileData | null; recommended_program: Recommendation | null
    settings: ThemeSettings & { program_id: number | null; boost_until?: string | null } }
  food_day: FoodDay; water: Water; week: { streak: number; days: WeekDay[] }; workout_logs: WorkoutLog[]; measurements: Measurement[]
  achievements: { items: Achievement[]; new: Achievement[]; freezes: number }; ai: { enabled: boolean } | null
  programs: Program[] | null; quests: QuestWeek | null; habits?: Habit[]
  yesterday?: { date: string; meals: Partial<Record<MealType, { kcal: number; items: number }>> }
}
/** Today in the phone's timezone as YYYY-MM-DD (same as the server's day for this user). */
const localDay = () => new Date().toLocaleDateString('sv-SE')
/** A kept answer from an earlier day still has the right profile, programs and history, but not today's food and water. */
const fresh = (b: Bootstrap): Bootstrap => b.food_day.date === localDay() ? { ...b, quests: b.quests && { ...b.quests, xp_awarded: 0 } } : {
  ...b, food_day: { date: '', items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }, water: { ml: 0, goal_ml: b.water.goal_ml }, yesterday: undefined,
  habits: b.habits?.map((h) => ({ ...h, done: false })),
  quests: b.quests && { ...b.quests, xp_awarded: 0 },
}
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
      <p className="sub credits">Данные о продуктах: <a href="https://world.openfoodfacts.org" target="_blank" rel="noreferrer">Open Food Facts</a> (лицензия ODbL), USDA FoodData и пользователи Setly.</p>
      {body}
    </>
  )
}

export default function App() {
  // the last server answer kept on this phone: the screen starts from it instead of zeros (see snapshot.ts)
  const [boot] = useState(() => { const b = loadSnapshot<Bootstrap>(); return b && fresh(b) })
  const kcalRef = useRef<number | null>(null) // last known kcal, to notice the moment the norm is reached
  const [tab, setTab] = useState<Tab>('home')
  const [synced, setSynced] = useState('Демо-режим')
  const [xp, setXp] = useState<Progress>(boot?.auth.progress ?? NEW_USER)
  const [boostUntil, setBoostUntil] = useState<string | null>(boot?.auth.settings.boost_until ?? null) // x2 XP after a duel win
  const [me, setMe] = useState<ProfileData | null>(boot?.auth.profile ?? null)
  const [editing, setEditing] = useState(false)
  const [canEdit, setCanEdit] = useState(Boolean(boot))
  const [foodDay, setFoodDay] = useState<FoodDay>(boot?.food_day ?? demoFoodDay)
  const [programs, setPrograms] = useState<Program[] | null>(boot?.programs ?? null)
  const [logs, setLogs] = useState<WorkoutLog[]>(boot?.workout_logs ?? [])
  // kept on the account (see /api/settings); localStorage only until the account loads
  const [programId, setProgramId] = useState<number | null>(() => {
    try { return Number(localStorage.getItem(PROGRAM_KEY)) || null } catch { return null }
  })
  const [toast, setToast] = useState('')
  const [party, setParty] = useState(0) // >0: confetti on screen (the number restarts it)
  const [measurements, setMeasurements] = useState<Measurement[]>(boot?.measurements ?? [])
  const [aiEnabled, setAiEnabled] = useState(Boolean(boot?.ai?.enabled))
  const [recommended, setRecommended] = useState<Recommendation | null>(boot?.auth.recommended_program ?? null)
  const [water, setWater] = useState<Water>(boot?.water ?? { ml: 0, goal_ml: 2000 })
  const [week, setWeek] = useState<{ streak: number; days: WeekDay[] }>(boot?.week ?? { streak: 0, days: [] })
  const [ach, setAch] = useState<{ items: Achievement[]; new: Achievement[]; freezes: number }>(boot ? { ...boot.achievements, new: [] } : { items: [], new: [], freezes: 0 })
  const [foodIntent, setFoodIntent] = useState<FoodIntent | null>(null)
  const [reward, setReward] = useState(false)
  const [loading, setLoading] = useState(!boot) // no data yet (first open, nothing kept on the phone)
  const [quests, setQuests] = useState<QuestWeek | null>(boot?.quests ?? null)
  const [yesterday, setYesterday] = useState(boot?.yesterday)
  const [habits, setHabits] = useState<Habit[]>(boot?.habits ?? [])
  const theme = useTheme((patch) => { api('/api/settings', putJson(patch)).catch(() => {}) })
  // latest values for the one-time startup effect (it must not re-run when they change)
  const startup = useRef({ theme, programId, boot, selectProgram: (_id: number | null, _sync?: boolean) => {} })
  useEffect(() => { startup.current = { theme, programId, boot, selectProgram } })
  // Level known before the latest refresh; null until the account is loaded, so the first load never celebrates.
  const knownLevel = useRef<number | null>(null)
  useEffect(() => {
    if (knownLevel.current !== null && xp.level > knownLevel.current) setReward(true)
    if (knownLevel.current !== null) knownLevel.current = xp.level
  }, [xp.level])

  // Everything for the first screen in one request (/api/bootstrap); the last answer is kept on the phone and shown
  // instantly on the next open, so numbers don't flash from 0 while the network catches up.
  const apply = useCallback((b: Bootstrap) => {
    const u = b.auth
    setXp(u.progress); setMe(u.profile); setRecommended(u.recommended_program)
    setBoostUntil(u.settings.boost_until ?? null)
    if (b.ai) setAiEnabled(Boolean(b.ai.enabled))
    setAch(b.achievements); setWeek(b.week); setLogs(b.workout_logs); setMeasurements(b.measurements)
    if (b.programs) setPrograms(b.programs)
    // calories just came into the norm (90–110%) with this refresh: worth a cheer
    const goal = u.profile?.targets?.calories, before = kcalRef.current, now = b.food_day.totals.kcal
    kcalRef.current = now
    setFoodDay(b.food_day); setWater(b.water); setQuests(b.quests); setYesterday(b.yesterday); setHabits(b.habits ?? [])
    if (b.quests?.xp_awarded) celebrate(`Задание недели выполнено 🏆 +${b.quests.xp_awarded} XP`)
    else if (goal && before !== null && before < goal * 0.9 && now >= goal * 0.9 && now <= goal * 1.1) celebrate('Калории в норме на сегодня 🎯')
  }, [])

  const refreshJournal = useCallback(async () => {
    const b = await api<Bootstrap>('/api/bootstrap', { method: 'POST' })
    if (!b) return
    apply(b)
    saveSnapshot(b)
  }, [apply])

  useEffect(() => {
    initTelegram()
    const snap = startup.current.boot
    if (snap) {
      knownLevel.current = snap.auth.progress.level
      startup.current.theme.load(snap.auth.settings)
      if (snap.auth.settings.program_id) startup.current.selectProgram(snap.auth.settings.program_id, false)
    }
    if (!tg?.initData) {
      publicGet<Program[]>('/api/programs').then(setPrograms).catch(() => setPrograms(demoPrograms)).finally(() => setLoading(false))
      return
    }
    api<Bootstrap>('/api/bootstrap', { method: 'POST' })
      .then((b) => {
        if (!b) return
        const u = b.auth
        setSynced('Аккаунт подключён')
        setCanEdit(true)
        if (knownLevel.current === null) knownLevel.current = u.progress.level
        startup.current.theme.load(u.settings)
        const local = startup.current.programId
        if (u.settings.program_id) startup.current.selectProgram(u.settings.program_id, false)
        else if (local) api('/api/settings', putJson({ program_id: local })).catch(() => {}) // upload this device's choice once
        setEditing(!u.profile) // first visit: questionnaire before anything else
        apply(b)
        saveSnapshot(b)
        prefetchStats()
      })
      .catch(() => { setSynced('Сервер недоступен'); if (!snap) setPrograms(demoPrograms) })
      .finally(() => setLoading(false))
  }, [apply])

  function flash(text: string) {
    setToast(text)
    setTimeout(() => setToast(''), 2500)
  }

  /** A small win: toast + confetti + a success buzz. */
  function celebrate(text: string) {
    flash(text)
    tg?.HapticFeedback?.notificationOccurred?.('success')
    const id = Date.now()
    setParty(id)
    setTimeout(() => setParty((p) => (p === id ? 0 : p)), 2200)
  }

  async function addFood(productId: number, grams: number, meal: MealType, slot?: string | null) {
    const r = await api<{ xp_awarded: number }>('/api/food-logs', postJson({ product_id: productId, amount_g: grams, meal_type: meal, ...(slot ? { snack_slot: slot } : {}) }))
    tg?.HapticFeedback?.notificationOccurred?.('success')
    await refreshJournal()
    flash(r?.xp_awarded ? `Добавлено · +${r.xp_awarded} XP` : 'Добавлено')
  }

  /** "Повторить вчерашний завтрак": the meal of this hour is empty today and was logged yesterday. */
  function repeatOffer() {
    const meal = mealNow()
    const y = yesterday?.meals[meal]
    if (!yesterday || !y || foodDay.items.some((i) => i.meal_type === meal)) return null
    return { title: `Повторить вчерашний ${MEALS[meal].toLowerCase()}`, kcal: y.kcal, run: () => copyMeal(yesterday.date, meal) }
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

  async function changeGrams(id: number, grams: number) {
    await api(`/api/food-logs/${id}`, { ...postJson({ amount_g: grams }), method: 'PATCH' })
    await refreshJournal()
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
    if (water.ml < r.goal_ml && r.ml >= r.goal_ml) celebrate(r.xp_awarded ? `Норма воды выполнена 💧 +${r.xp_awarded} XP` : 'Норма воды выполнена 💧')
    if (r.xp_awarded) {
      await refreshJournal()
    } else {
      api<{ streak: number; days: WeekDay[] }>('/api/week').then((wk) => wk && setWeek(wk)).catch(() => {})
    }
  }

  function habitsChanged(list: Habit[]) {
    if (list.length && list.every((h) => h.done) && !habits.every((h) => h.done)) celebrate('Все привычки на сегодня ✓')
    setHabits(list)
    api<{ streak: number; days: WeekDay[] }>('/api/week').then((wk) => wk && setWeek(wk)).catch(() => {}) // a tick can start today's streak
  }

  function selectProgram(id: number | null, sync = true) {
    setProgramId(id)
    if (sync) api('/api/settings', putJson({ program_id: id })).catch(() => {})
    try { if (id) localStorage.setItem(PROGRAM_KEY, String(id)); else localStorage.removeItem(PROGRAM_KEY) } catch { /* private mode */ }
  }

  const program = programs?.find((p) => p.id === programId)
  const unlocked = (code: string) => ach.items.some((a) => a.code === code && a.unlocked_at)

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
          <Home loading={loading} name={name} level={xp.level} boostUntil={boostUntil} streak={week.streak} targets={me?.targets} day={foodDay} program={program} logs={logs}
            water={water} aiEnabled={aiEnabled} canEdit={canEdit}
            onFood={(i) => { go('food'); setFoodIntent(i) }} onNutrition={() => go('food')} onWorkouts={() => go('workouts')} onWater={changeWater}
            quests={canEdit && quests && <Quests week={quests} />}
            habits={canEdit && <Habits habits={habits} onChange={habitsChanged} />}
            repeat={canEdit ? repeatOffer() : null}
            intro={canEdit && <FirstSteps steps={[
              { key: 'meal', title: 'Запишите, что съели', hint: aiEnabled ? 'Можно просто сфотографировать тарелку' : 'Найдите продукт или блюдо в поиске',
                done: unlocked('first_meal') || foodDay.items.length > 0, action: () => { go('food'); setFoodIntent(aiEnabled ? 'photo' : 'search') } },
              { key: 'water', title: 'Отметьте стакан воды', hint: 'Нажмите — добавим 250 мл',
                done: water.ml > 0 || week.days.some((d) => d.water_ml > 0), action: () => changeWater(250) },
              { key: 'program', title: 'Выберите программу', hint: recommended ? 'Подобрали подходящую по анкете' : 'Готовую или свою',
                done: programId !== null, action: () => go('workouts') },
              { key: 'workout', title: 'Проведите первую тренировку', hint: 'Отмечайте подходы прямо во время занятия',
                done: unlocked('first_workout') || logs.some((l) => l.completed_at), action: () => go('workouts') },
            ]} />} />
        )}
        {tab === 'food' && <Food day={foodDay} targets={me?.targets} canEdit={canEdit} onAdd={addFood} onDelete={deleteFood} onGrams={changeGrams} aiEnabled={aiEnabled} onAiDone={aiMealDone} intent={foodIntent} onCopy={copyMeal} />}
        {tab === 'workouts' && (
          <Workouts programs={programs} logs={logs} programId={programId} onSelectProgram={selectProgram} recommended={recommended}
            canEdit={canEdit} onChanged={workoutChanged} onProgramsChange={setPrograms} />
        )}
        {tab === 'progress' && (
          <Progress canEdit={canEdit} achievements={ach.items} freezes={ach.freezes}
            top={<>{week.days.length === 7 && <WeekCard week={week.days} goal={me?.targets?.calories ?? 2000}
              norm={week.days.filter((d) => me?.targets && Math.abs(d.kcal - me.targets.calories) <= 0.1 * me.targets.calories).length} />}
              {aiEnabled && <AiSummary />}</>}
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
      {party > 0 && <Confetti key={party} />}
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
