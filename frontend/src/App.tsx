import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { demoFoodDay, demoMeasurements, demoPrograms, profile } from './demo'
import AiSummary from './AiSummary'
import { enqueue, flush, pending, unreachable } from './offline'
import { known, syncCatalog } from './catalog'
import Body, { QuickWeight, type MeasurementInput } from './Body'
import Food from './Food'
import Home, { type FoodIntent, type Water, type WeekDay } from './Home'
import Reminders from './Reminders'
import Confetti from './Confetti'
import FirstSteps from './FirstSteps'
import Quests, { type QuestWeek } from './Quests'
import Habits, { type Habit } from './Habits'
import { animate } from './motion'
import Consent, { PrivacyCard, type ConsentState } from './Consent'
import FeedbackCard from './Feedback'
import EnergyCard from './Energy'
import ReportCard from './Report'
import { canStory, shareStory } from './story'
import WeekCard from './Week'
import { loadSnapshot, saveSnapshot } from './snapshot'
import { prefetchStats } from './stats'
import Progress, { type Achievement } from './Progress'
import Reward, { AchievementUnlocked } from './Reward'
import { ACCENTS, LIGHT, THEMES, useTheme, type ThemePref, type ThemeSettings } from './theme'
import Questionnaire from './Questionnaire'
import { GOALS, YEAR, calculateTargets, type ProfileData, type Recommendation } from './profile'
import { api, apiBlob, initTelegram, postJson, publicGet, putJson, tg, tgUser } from './telegram'
import { MEALS, mealNow, type FoodDay, type FoodItem, type MealType, type Measurement, type Program, type WorkoutLog } from './types'
import { Bar, Chevron, Sheet } from './ui'
import { ACTIVE_EVENT, loadActive } from './activeWorkout'
import { markRecapSeen, recapDue } from './recap'
import { haptic, hapticsOn, setHaptics, setSounds, sound, soundsOn } from './feedback'
const WeekRecap = lazy(() => import('./WeekRecap'))
const Workouts = lazy(() => import('./Workouts'))

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

const TAB_ORDER = TABS.map((t) => t.id)
const consentOf = (b: Bootstrap): ConsentState | null =>
  b.auth.settings.consent === undefined ? null : { ok: b.auth.settings.consent, health: Boolean(b.auth.settings.health_consent), url: b.auth.settings.privacy_url ?? null }

const name = tgUser?.first_name ?? 'Гость'
const PROGRAM_KEY = 'fa.programId'

type Progress = { xp: number; level: number; level_xp: number; level_xp_needed: number }
type Bootstrap = {
  auth: { id: number; progress: Progress; profile: ProfileData | null; recommended_program: Recommendation | null
    settings: ThemeSettings & { program_id: number | null; boost_until?: string | null; consent?: boolean; health_consent?: boolean; privacy_url?: string | null } }
  food_day: FoodDay; water: Water; week: { streak: number; days: WeekDay[] }; workout_logs: WorkoutLog[]; measurements: Measurement[]
  achievements: { items: Achievement[]; new: Achievement[]; freezes: number }; ai: { enabled: boolean } | null
  programs: Program[] | null; quests: QuestWeek | null; habits?: Habit[]
  yesterday?: { date: string; meals: Partial<Record<MealType, { kcal: number; items: number }>> }
}
/** Today in the phone's timezone as YYYY-MM-DD (same as the server's day for this user). */
type Usual = { meal_type: MealType; title: string; kcal: number; items: { product_id: number; amount_g: number; unit: string | null; qty: number | null }[] }
/** The same day with another list of entries, totals recounted. */
function withItems(d: FoodDay, items: FoodItem[]): FoodDay {
  const sum = (k: 'kcal' | 'protein_g' | 'fat_g' | 'carbs_g') => items.reduce((n, i) => n + i[k], 0)
  return { ...d, items, totals: { kcal: sum('kcal'), protein_g: sum('protein_g'), fat_g: sum('fat_g'), carbs_g: sum('carbs_g') } }
}
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
      <FeelSwitches />
    </section>
  )
}

/** Vibration (on by default) and sounds (off): a saved set, the end of a rest, a record. */
function FeelSwitches() {
  const [vib, setVib] = useState(hapticsOn)
  const [snd, setSnd] = useState(soundsOn)
  return (
    <div className="feel">
      <div className="row"><div className="row-main"><div className="row-title">Вибрация</div><div className="row-sub">Сохранение, рекорд, конец отдыха</div></div>
        <button role="switch" className="switch" aria-checked={vib} aria-label="Вибрация" onClick={() => { setHaptics(!vib); setVib(!vib); if (!vib) haptic('save') }}><i /></button></div>
      <div className="row"><div className="row-main"><div className="row-title">Звуки</div><div className="row-sub">Щелчок подхода и сигнал отдыха</div></div>
        <button role="switch" className="switch" aria-checked={snd} aria-label="Звуки" onClick={() => { setSounds(!snd); setSnd(!snd); if (!snd) sound('chime') }}><i /></button></div>
    </div>
  )
}

const AVATAR_KEY = 'setly-avatar'

/** Telegram's photo, fetched by the bot through our own server (Telegram's photo_url may be missing, or blocked on the
 * phone's network like telegram.org); photo_url is only the fallback. Kept on the phone for the next open. */
function Avatar() {
  const [src, setSrc] = useState<string | null>(() => { try { return localStorage.getItem(AVATAR_KEY) } catch { return null } })
  useEffect(() => {
    let stale = false
    apiBlob('/api/me/photo').then((b) => {
      if (stale) return
      if (!b) { if (tgUser?.photo_url) setSrc((s) => s ?? tgUser!.photo_url!); return }
      const r = new FileReader()
      r.onload = () => {
        const url = String(r.result)
        if (!stale) setSrc(url)
        try { localStorage.setItem(AVATAR_KEY, url) } catch { /* too big or private mode */ }
      }
      r.readAsDataURL(b)
    }).catch(() => { if (!stale && tgUser?.photo_url) setSrc((s) => s ?? tgUser!.photo_url!) })
    return () => { stale = true }
  }, [])
  return <div className="avatar">{src ? <img src={src} alt="" onError={() => setSrc(null)} /> : name[0]}</div>
}

function Profile({ synced, progress, data, onEdit, body, theme, canEdit, awards = [], onAwards }: {
  synced: string; progress: Progress; data: ProfileData | null; onEdit: () => void; body: React.ReactNode
  awards?: Achievement[]; onAwards?: () => void // unlocked badges as medals; the full list is in Прогресс → Награды
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
        <Avatar />
        <div>
          <h1 style={{ fontSize: 22 }}>{name}</h1>
          {tgUser?.username && <div className="sub">@{tgUser.username}</div>}
          {synced && <div className="sub">{synced}</div>}
        </div>
        </div>
        <LevelCard p={progress} />
        {awards.some((a) => a.unlocked_at) && (
          <button className="medals" onClick={onAwards} aria-label="Все награды">
            {awards.filter((a) => a.unlocked_at).sort((a, b) => b.unlocked_at!.localeCompare(a.unlocked_at!)).slice(0, 6).map((a) => (
              <span key={a.code} className="medal" title={a.title}><span aria-hidden="true">{a.icon}</span></span>
            ))}
            <span className="medals-more">{awards.filter((a) => a.unlocked_at).length} из {awards.length} <Chevron dir="right" /></span>
          </button>
        )}
      </section>
      <section className="card profile-overview">
        <div className="card-head"><h2>Мои данные</h2><button className="link" aria-label={data ? 'Изменить анкету' : 'Заполнить анкету'} onClick={onEdit}>{data ? 'Моя анкета →' : 'Заполнить →'}</button></div>
      <div className="grid2 profile-metrics">
        <section className="card"><span className="sub">Возраст</span><div className="stat">{shown.age}<small>лет</small></div></section>
        <section className="card"><span className="sub">Рост</span><div className="stat">{shown.height}<small>см</small></div></section>
        <section className="card"><span className="sub">Вес</span><div className="stat">{Number(shown.weight).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}<small>кг</small></div></section>
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
      <h3 className="profile-group">Уведомления и вид</h3>
      {canEdit && <Reminders />}
      <ThemeCard t={theme} />
      {body && <h3 className="profile-group">Данные и помощь</h3>}
      {body}
      <p className="sub credits">Данные о продуктах: <a href="https://world.openfoodfacts.org" target="_blank" rel="noreferrer">Open Food Facts</a> (лицензия ODbL), USDA FoodData и пользователи Setly.</p>
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
  const [profileResult, setProfileResult] = useState<{ profile: ProfileData; recommendation: Recommendation | null } | null>(null)
  const [canEdit, setCanEdit] = useState(Boolean(boot))
  const [foodDay, setFoodDay] = useState<FoodDay>(boot?.food_day ?? demoFoodDay)
  const [programs, setPrograms] = useState<Program[] | null>(boot?.programs ?? null)
  const [logs, setLogs] = useState<WorkoutLog[]>(boot?.workout_logs ?? [])
  // kept on the account (see /api/settings); localStorage only until the account loads
  const [programId, setProgramId] = useState<number | null>(() => {
    try { return Number(localStorage.getItem(PROGRAM_KEY)) || null } catch { return null }
  })
  const [toast, setToast] = useState<{ id: number; text: string; undo?: () => Promise<void> } | null>(null)
  const [usual, setUsual] = useState<Usual | null>(null) // "Как обычно" on Home
  const [queued, setQueued] = useState(() => pending().length) // food logged offline, not sent yet
  const [dir, setDir] = useState(0) // the next screen slides in from the side of its tab
  const [xpFloat, setXpFloat] = useState<{ id: number; n: number } | null>(null)
  const knownXp = useRef<number | null>(null)
  const [party, setParty] = useState(0) // >0: confetti on screen (the number restarts it)
  const [measurements, setMeasurements] = useState<Measurement[]>(boot?.measurements ?? [])
  const [aiEnabled, setAiEnabled] = useState(Boolean(boot?.ai?.enabled))
  const [recommended, setRecommended] = useState<Recommendation | null>(boot?.auth.recommended_program ?? null)
  const [water, setWater] = useState<Water>(boot?.water ?? { ml: 0, goal_ml: 2000 })
  const [week, setWeek] = useState<{ streak: number; days: WeekDay[] }>(boot?.week ?? { streak: 0, days: [] })
  const [recapAsked, setRecapAsked] = useState(false)
  const [recapClosed, setRecapClosed] = useState(false)
  // opens by itself once a week; not in unit tests, whose clock may be any day
  const recap = recapAsked || (!recapClosed && canEdit && import.meta.env.MODE !== 'test' && recapDue(week.days))
  const [ach, setAch] = useState<{ items: Achievement[]; new: Achievement[]; freezes: number }>(boot ? { ...boot.achievements, new: [] } : { items: [], new: [], freezes: 0 })
  const [foodIntent, setFoodIntent] = useState<FoodIntent | null>(null)
  const [foodDate, setFoodDate] = useState('') // a past day open in the diary; '' = today
  const [pastDay, setPastDay] = useState<FoodDay | null>(null)
  const [reward, setReward] = useState(false)
  const [loading, setLoading] = useState(!boot) // no data yet (first open, nothing kept on the phone)
  const [quests, setQuests] = useState<QuestWeek | null>(boot?.quests ?? null)
  const [yesterday, setYesterday] = useState(boot?.yesterday)
  const [habits, setHabits] = useState<Habit[]>(boot?.habits ?? [])
  const [consent, setConsent] = useState<ConsentState | null>(boot ? consentOf(boot) : null)
  // the bot's Sunday summary opens the app with ?open=story: offer the week card for Stories (it needs a tap)
  const [storyOffer, setStoryOffer] = useState(() => new URLSearchParams(window.location.search).get('open') === 'story')
  const theme = useTheme((patch) => { api('/api/settings', putJson(patch)).catch(() => {}) })
  // latest values for the one-time startup effect (it must not re-run when they change)
  const startup = useRef({ theme, programId, boot, selectProgram: (_id: number | null, _sync?: boolean) => {} })
  useEffect(() => { startup.current = { theme, programId, boot, selectProgram } })
  // Level known before the latest refresh; null until the account is loaded, so the first load never celebrates.
  const knownLevel = useRef<number | null>(null)
  useEffect(() => {
    if (knownLevel.current !== null && xp.level > knownLevel.current) setReward(true)
    // "+N XP" floats up when XP grows after the account is loaded (the first load sets the baseline)
    if (knownLevel.current !== null && knownXp.current !== null && xp.xp > knownXp.current && animate()) setXpFloat({ id: Date.now(), n: xp.xp - knownXp.current })
    if (knownLevel.current !== null) { knownLevel.current = xp.level; knownXp.current = xp.xp }
  }, [xp.level, xp.xp])

  // Everything for the first screen in one request (/api/bootstrap); the last answer is kept on the phone and shown
  // instantly on the next open, so numbers don't flash from 0 while the network catches up.
  // entries shown before the server confirmed them (tempId -> entry and its day): a refresh mid-way must not hide them
  const optimistic = useRef(new Map<number, { item: FoodItem; date: string }>())
  const withOptimistic = useCallback((d: FoodDay, date: string): FoodDay => {
    const extra = [...optimistic.current.values()].filter((o) => o.date === date && !d.items.some((i) => i.id === o.item.id)).map((o) => o.item)
    return extra.length ? withItems(d, [...d.items, ...extra]) : d
  }, [])

  const apply = useCallback((b: Bootstrap) => {
    const u = b.auth
    setXp(u.progress); setMe(u.profile); setRecommended(u.recommended_program)
    setBoostUntil(u.settings.boost_until ?? null)
    setConsent(consentOf(b))
    if (b.ai) setAiEnabled(Boolean(b.ai.enabled))
    setAch(b.achievements); setWeek(b.week); setLogs(b.workout_logs); setMeasurements(b.measurements)
    if (b.programs) setPrograms(b.programs)
    // calories just came into the norm (90–110%) with this refresh: worth a cheer
    const goal = u.profile?.targets?.calories, before = kcalRef.current, now = b.food_day.totals.kcal
    kcalRef.current = now
    setFoodDay(withOptimistic(b.food_day, localDay())); setWater(b.water); setQuests(b.quests); setYesterday(b.yesterday); setHabits(b.habits ?? [])
    if (b.quests?.xp_awarded) celebrate(`Задание недели выполнено 🏆 +${b.quests.xp_awarded} XP`)
    else if (goal && before !== null && before < goal * 0.9 && now >= goal * 0.9 && now <= goal * 1.1) celebrate('Калории в норме на сегодня 🎯')
  }, [withOptimistic])

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
      knownXp.current = snap.auth.progress.xp
      startup.current.theme.load(snap.auth.settings)
      if (snap.auth.settings.program_id) startup.current.selectProgram(snap.auth.settings.program_id, false)
    }
    if (!tg?.initData) {
      publicGet<Program[]>('/api/programs').then(items => setPrograms([...items, ...demoPrograms.slice(1).filter(example => !items.some(item => item.name === example.name))])).catch(() => setPrograms(demoPrograms)).finally(() => setLoading(false))
      return
    }
    api<Bootstrap>('/api/bootstrap', { method: 'POST' })
      .then((b) => {
        if (!b) return
        const u = b.auth
        setSynced('')
        setCanEdit(true)
        if (knownLevel.current === null) { knownLevel.current = u.progress.level; knownXp.current = u.progress.xp }
        startup.current.theme.load(u.settings)
        const local = startup.current.programId
        if (u.settings.program_id) startup.current.selectProgram(u.settings.program_id, false)
        else if (local) api('/api/settings', putJson({ program_id: local })).catch(() => {}) // upload this device's choice once
        setEditing(!u.profile) // first visit: questionnaire before anything else
        apply(b)
        saveSnapshot(b)
        prefetchStats()
      })
      .catch(() => { setSynced('Нет связи — показываем сохранённое'); if (!snap) setPrograms(demoPrograms) })
      .finally(() => setLoading(false))
  }, [apply])

  function flash(text: string) {
    flashUndo(text)
  }

  /** A toast; with `undo` it stays 5 s and has "Отменить" (instead of asking "are you sure?" before). */
  function flashUndo(text: string, undo?: () => Promise<void>) {
    const id = Date.now() + Math.random()
    setToast({ id, text, undo })
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), undo ? 5000 : 2500)
  }

  /** A small win: toast + confetti + a success buzz. */
  function celebrate(text: string) {
    flash(text)
    haptic('success')
    const id = Date.now()
    setParty(id)
    setTimeout(() => setParty((p) => (p === id ? 0 : p)), 2200)
  }

  const at = foodDate ? { day: foodDate } : {} // diary writes go to the day on screen
  const loadPast = useCallback(async (d: string) => { const r = await api<FoodDay>(`/api/food-logs?day=${d}`); if (r) setPastDay(withOptimistic(r, d)) }, [withOptimistic])
  useEffect(() => {
    if (!foodDate) return
    let stale = false
    api<FoodDay>(`/api/food-logs?day=${foodDate}`).then((r) => { if (r && !stale) setPastDay(withOptimistic(r, foodDate)) }).catch(() => {})
    return () => { stale = true }
  }, [foodDate, withOptimistic])
  async function refreshFood() {
    await refreshJournal()
    if (foodDate) await loadPast(foodDate)
  }
  function openDay(d: string) {
    setPastDay(null)
    setFoodDate(d === localDay() ? '' : d)
  }

  /** The entry shows in the diary at once (if the product is known — it always is from search, recent, favourites);
   * the server confirms in the background. No network: it waits in the offline queue; a refusal takes it back out. */
  async function addFood(productId: number, grams: number, meal: MealType, slot?: string | null, counted?: { unit: string; qty: number }, name = '') {
    const body = { product_id: productId, amount_g: grams, meal_type: meal, ...(slot ? { snack_slot: slot } : {}), ...(counted ?? {}), ...at }
    const date = foodDate || localDay()
    const p = known.get(productId)
    const tempId = -Math.round(Date.now() * 1000 + Math.random() * 1000)
    const show = (on: boolean) => {
      const change = (d: FoodDay) => withItems(d, on ? [...d.items, optimistic.current.get(tempId)!.item] : d.items.filter((i) => i.id !== tempId))
      if (foodDate) setPastDay((d) => d && change(d)); else setFoodDay(change)
    }
    if (p) {
      const k = grams / 100
      optimistic.current.set(tempId, { date, item: {
        id: tempId, meal_type: meal, snack_slot: meal === 'snack' ? slot ?? new Date().toTimeString().slice(0, 5) : null, amount_g: grams,
        logged_at: new Date().toISOString(), product: p, unit: counted?.unit ?? null, qty: counted?.qty ?? null,
        kcal: p.kcal * k, protein_g: p.protein_g * k, fat_g: p.fat_g * k, carbs_g: p.carbs_g * k,
      } })
      show(true)
      haptic('success')
    }
    const send = async () => {
      let r: { xp_awarded: number } | null
      try {
        r = await api<{ xp_awarded: number }>('/api/food-logs', postJson(body))
      } catch (e) {
        if (!unreachable(e)) {
          if (p) { show(false); optimistic.current.delete(tempId) }
          throw e
        }
        // keep the day and the snack's time as of now: it may be sent tomorrow
        enqueue({ name, body: { day: localDay(), ...body, ...(meal === 'snack' && !slot ? { snack_slot: new Date().toTimeString().slice(0, 5) } : {}) } })
        setQueued(pending().length)
        flash('Нет связи — запишем, как только она появится')
        return
      }
      optimistic.current.delete(tempId)
      if (!p) haptic('success')
      await refreshFood()
      if (r?.xp_awarded || !p) flash(r?.xp_awarded ? `Добавлено · +${r.xp_awarded} XP` : 'Добавлено')
    }
    if (!p) return send()
    flash('Добавлено')
    send().catch((e) => flash(e instanceof Error && e.message ? e.message : 'Не добавилось — попробуйте ещё раз'))
  }

  /** "Повторить вчерашний завтрак": the meal of this hour is empty today and was logged yesterday. */
  function repeatOffer() {
    const meal = mealNow()
    const y = yesterday?.meals[meal]
    if (!yesterday || !y || foodDay.items.some((i) => i.meal_type === meal)) return null
    return { title: `Повторить вчерашний ${MEALS[meal].toLowerCase()}`, kcal: y.kcal, run: () => copyMeal(yesterday.date, meal) }
  }

  async function copyMeal(fromDay: string, meal: MealType) {
    const r = await api<{ copied: number; xp_awarded: number }>('/api/food-logs/copy', postJson({ from_day: fromDay, meal_type: meal, ...(at.day ? { to_day: at.day } : {}) }))
    await refreshFood()
    flash(r?.xp_awarded ? `Повторено · +${r.xp_awarded} XP` : 'Повторено')
  }

  async function logSet(setId: number, meal: MealType, slot: string | null) {
    const r = await api<{ logged: number; xp_awarded: number }>(`/api/meal-sets/${setId}/log`, postJson({ meal_type: meal, snack_slot: slot, ...at }))
    await refreshFood()
    flash(r?.xp_awarded ? `Набор добавлен · +${r.xp_awarded} XP` : 'Набор добавлен')
  }

  async function logBatch(meal: MealType, items: { product_id: number; amount_g: number }[]) {
    const r = await api<{ logged: number; xp_awarded: number }>('/api/food-logs/batch', postJson({ meal_type: meal, items, ...at }))
    await refreshFood()
    flash(r?.xp_awarded ? `Записано · +${r.xp_awarded} XP` : 'Записано')
  }

  async function aiMealDone(xpAwarded: number) {
    await refreshJournal()
    flash(xpAwarded ? `Добавлено · +${xpAwarded} XP` : 'Добавлено')
  }

  async function changeGrams(id: number, grams: number) {
    await api(`/api/food-logs/${id}`, { ...postJson({ amount_g: grams }), method: 'PATCH' })
    await refreshFood()
  }

  async function moveFood(id: number, meal: MealType) {
    await api(`/api/food-logs/${id}`, { ...postJson({ meal_type: meal }), method: 'PATCH' })
    await refreshFood()
    flash(`Перенесено в «${MEALS[meal]}»`)
  }

  /** "Скопировать на сегодня" from a past day of the diary. */
  async function copyToToday(item: FoodItem) {
    const r = await api<{ xp_awarded: number }>('/api/food-logs', postJson({ product_id: item.product.id, amount_g: item.amount_g, meal_type: item.meal_type,
      ...(item.unit && item.qty ? { unit: item.unit, qty: item.qty } : {}) }))
    await refreshJournal()
    flash(r?.xp_awarded ? `Скопировано на сегодня · +${r.xp_awarded} XP` : 'Скопировано на сегодня')
  }

  /** Deleted at once; "Отменить" puts the same entry back (same meal, snack, day, amount). */
  async function deleteFood(id: number) {
    const item = (foodDate ? pastDay : foodDay)?.items.find((i) => i.id === id)
    const where = at
    const drop = (d: FoodDay) => withItems(d, d.items.filter((i) => i.id !== id)) // gone at once; the server follows
    if (foodDate) setPastDay((d) => d && drop(d)); else setFoodDay(drop)
    try { await api(`/api/food-logs/${id}`, { method: 'DELETE' }) } finally { refreshFood().catch(() => {}) }
    if (item) flashUndo(`Удалено: ${item.product.name}`, async () => {
      await api('/api/food-logs', postJson({ product_id: item.product.id, amount_g: item.amount_g, meal_type: item.meal_type, ...where,
        ...(item.snack_slot ? { snack_slot: item.snack_slot } : {}), ...(item.unit && item.qty ? { unit: item.unit, qty: item.qty } : {}) }))
      await refreshFood()
    })
  }

  useEffect(() => {
    if (!canEdit) return
    const t = setTimeout(() => { syncCatalog().catch(() => {}) }, 2000) // after the first screen: not competing with it
    return () => clearTimeout(t)
  }, [canEdit])

  // offline entries go out when the connection is back (and on every start)
  useEffect(() => {
    if (!canEdit) return
    let busy = false
    const send = async () => {
      if (busy || !pending().length) return
      busy = true
      const n = await flush((body) => api('/api/food-logs', postJson(body))).finally(() => { busy = false })
      setQueued(pending().length)
      if (n) { await refreshJournal().catch(() => {}); flash(`Отправлено записей: ${n}`) }
    }
    send()
    window.addEventListener('online', send)
    const timer = setInterval(send, 30_000)
    return () => { window.removeEventListener('online', send); clearInterval(timer) }
  }, [canEdit, refreshJournal])

  useEffect(() => {
    if (!canEdit) return
    let stale = false
    api<Usual | null>(`/api/usual?meal_type=${mealNow()}`).then((r) => { if (!stale) setUsual(r ?? null) }).catch(() => {})
    return () => { stale = true }
  }, [canEdit, foodDay.items.length])

  async function logUsual(u: Usual) {
    const r = await api<{ ids: number[]; xp_awarded: number }>('/api/food-logs/batch', postJson({ meal_type: u.meal_type, items: u.items }))
    haptic('success')
    setUsual(null)
    await refreshJournal()
    flashUndo(r?.xp_awarded ? `Записано · +${r.xp_awarded} XP` : 'Записано', async () => {
      await Promise.all((r?.ids ?? []).map((id) => api(`/api/food-logs/${id}`, { method: 'DELETE' })))
      await refreshJournal()
    })
  }

  async function saveMeasurement(m: MeasurementInput) {
    const r = await api<{ xp_awarded: number }>('/api/measurements', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m),
    })
    await refreshJournal()
    flash(r?.xp_awarded ? `Замер сохранён · +${r.xp_awarded} XP` : 'Замер сохранён')
  }

  async function deleteMeasurement(id: number) {
    const m = measurements.find((x) => x.id === id)
    await api(`/api/measurements/${id}`, { method: 'DELETE' })
    await refreshJournal()
    if (m) flashUndo('Замер удалён', async () => { // the same values on the same day
      const { id: _, ...back } = m
      await api('/api/measurements', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(back) })
      await refreshJournal()
    })
  }

  async function workoutChanged(xpAwarded: number) {
    await refreshJournal()
    if (xpAwarded) flash(`Тренировка завершена · +${xpAwarded} XP`)
  }

  /** Shown at once (the glass fills on tap), the server confirms after; "Отменить" on the toast takes it back. */
  async function changeWater(delta: number, undoable = delta > 0) {
    haptic('light')
    const before = water
    setWater((w) => ({ ...w, ml: Math.max(0, Math.min(10000, w.ml + delta)) }))
    let r: (Water & { xp_awarded: number }) | null
    try {
      r = await api<Water & { xp_awarded: number }>('/api/water', postJson({ delta_ml: delta }))
    } catch {
      setWater(before)
      flash('Вода не отметилась: нет связи')
      return
    }
    if (!r) return // demo mode: local only
    setWater(r)
    if (undoable && !(water.ml < r.goal_ml && r.ml >= r.goal_ml)) flashUndo(`+${delta} мл воды`, () => changeWater(-delta, false))
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
    haptic('select')
    setDir(Math.sign(TAB_ORDER.indexOf(t) - TAB_ORDER.indexOf(tab)))
    setFoodIntent(null)
    setFoodDate('')
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
    const resultProfile = saved ?? { ...p, targets: calculateTargets(p) }
    setMe(resultProfile)
    let recommendation: Recommendation | null = null
    if (saved) {
      try {
        const result = await api<{ recommended_program: Recommendation | null }>('/api/auth', { method: 'POST' })
        recommendation = result?.recommended_program ?? null
        setRecommended(recommendation)
      } catch { setRecommended(null) }
      refreshJournal().catch(() => {})
    }
    setProfileResult({ profile: resultProfile, recommendation })
    setEditing(false)
    window.scrollTo(0, 0)
  }

  if (profileResult) {
    const targets = profileResult.profile.targets
    const suggestion = programs?.find((p) => p.id === profileResult.recommendation?.program_id)
    const finish = (destination: Tab) => { setProfileResult(null); go(destination) }
    return <div className="app"><main className="screen profile-results">
      <div><p className="hello">Анкета заполнена</p><h1>Ваши первые ориентиры</h1><p className="sub">Ответы помогут настроить питание и тренировки под вас.</p></div>
      <section className="card profile-results-card"><h2>Питание на день</h2>
        {targets ? <><div className="profile-results-calories">{targets.calories} <span>ккал</span></div><div className="sub">Белки {targets.protein} г · Жиры {targets.fat} г · Углеводы {targets.carbs} г</div><p className="sub">Это расчётные ориентиры, не готовый рацион. Их можно уточнять по мере наблюдения за результатами.</p></> : <p className="sub">Ориентиры недоступны в деморежиме. Откройте приложение с подключённым аккаунтом.</p>}
      </section>
      <section className="card"><h2>Тренировки</h2>
        {suggestion ? <><div className="profile-results-program">{suggestion.name}</div>{profileResult.recommendation?.reasons.length ? <p className="sub">{profileResult.recommendation.reasons.join(' · ')}</p> : <p className="sub">Посмотрите программу и решите, подходит ли она вам.</p>}<p className="sub">Подбор учитывает уровень, оборудование и частоту занятий; ограничения и травмы автоматически не проверяются.</p></> : <p className="sub">Рекомендация пока недоступна. Можно посмотреть готовые программы и создать свою.</p>}
      </section>
      <button className="btn" onClick={() => finish('workouts')}>Посмотреть тренировки</button>
      <button className="btn btn-ghost" onClick={() => finish('food')}>Перейти к питанию</button>
      <button className="link profile-results-close" onClick={() => finish('profile')}>Вернуться в профиль</button>
    </main></div>
  }

  if (canEdit && consent && !consent.ok) {
    return <div className="app"><Consent url={consent.url} onDone={(health) => setConsent({ ...consent, ok: true, health })} /></div>
  }

  if (editing) {
    return (
      <div className="app">
        <Questionnaire initial={me} health={consent?.health ?? !canEdit} onSave={saveProfile} onCancel={me ? () => setEditing(false) : undefined} />
      </div>
    )
  }

  return (
    <div className="app">
      <main className="screen" key={tab} style={{ '--dir': dir } as React.CSSProperties}>
        {tab === 'home' && (
          <Home loading={loading} name={name} level={xp.level} boostUntil={boostUntil} streak={week.streak} targets={me?.targets} day={foodDay} program={program} trainingDays={me?.training_days} yesterday={week.days.length > 1 ? week.days[week.days.length - 2] : null} logs={logs}
            water={water} aiEnabled={aiEnabled} canEdit={canEdit}
            onFood={(i) => { go('food'); setFoodIntent(i) }} onNutrition={() => go('food')} onWorkouts={() => go('workouts')} onWater={changeWater}
            quests={canEdit && quests && <Quests week={quests} />}
            habits={canEdit && <Habits habits={habits} onChange={habitsChanged} />} habitsDone={[habits.filter((h) => h.done).length, habits.length]}
            weight={canEdit && <QuickWeight measurements={measurements} onSave={saveMeasurement} />}
            repeat={canEdit && !usual ? repeatOffer() : null}
            usual={canEdit && usual ? { meal: MEALS[usual.meal_type], title: usual.title, kcal: usual.kcal, run: () => logUsual(usual).catch(() => flash('Не записалось — попробуйте ещё раз')) } : null}
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
        {tab === 'food' && <Food day={foodDate ? pastDay ?? { date: foodDate, items: [], totals: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } } : foodDay}
          date={foodDate || localDay()} onDate={openDay} queued={queued} onMove={moveFood} onCopyToday={copyToToday} targets={me?.targets} canEdit={canEdit} healthConsent={consent?.health} profile={me} onAdd={addFood} onDelete={deleteFood} onGrams={changeGrams} aiEnabled={aiEnabled} onAiDone={aiMealDone} intent={foodIntent} onCopy={copyMeal} onLogSet={logSet} onSaved={flash} onLogBatch={logBatch} onPlanLogged={refreshJournal} />}
        {tab === 'workouts' && (
          <Suspense fallback={<p role="status">Открываем тренировки…</p>}>
          <Workouts programs={programs} logs={logs} programId={programId} onSelectProgram={selectProgram} recommended={recommended}
            canEdit={canEdit} profile={me} onChanged={workoutChanged} onProgramsChange={setPrograms} onRecord={(t) => { celebrate(t); refreshJournal().catch(() => {}) }}
            onMinimize={() => go('home')} />
          </Suspense>
        )}
        {tab === 'progress' && (
          <Progress canEdit={canEdit} achievements={ach.items} freezes={ach.freezes}
            weightGoal={me?.target_weight_kg}
            top={<>{week.days.length === 7 && <WeekCard week={week.days} goal={me?.targets?.calories ?? 2000}
              norm={week.days.filter((d) => me?.targets && Math.abs(d.kcal - me.targets.calories) <= 0.1 * me.targets.calories).length} />}
              {canEdit && week.days.length === 7 && <button className="btn btn-ghost recap-open" onClick={() => setRecapAsked(true)}>Итоги недели — открыть карточку</button>}
              {aiEnabled && <AiSummary />}</>}
            bodyTop={canEdit && me && <EnergyCard calories={me.targets?.calories} onNormChanged={() => {
              api<ProfileData>('/api/profile').then((p) => p && setMe(p)).catch(() => {})
            }} />}
            body={<Body measurements={canEdit ? measurements : demoMeasurements} canEdit={canEdit} hideWeight={canEdit} onSave={saveMeasurement} onDelete={deleteMeasurement} />} />
        )}
        {tab === 'profile' && (
          <Profile synced={synced} progress={xp} data={me} onEdit={() => setEditing(true)} theme={theme} canEdit={canEdit}
            awards={ach.items} onAwards={() => { try { sessionStorage.setItem('setly-progress-part', 'awards') } catch { /* private mode */ } go('progress') }}
            body={canEdit && consent && <><ReportCard /><FeedbackCard /><PrivacyCard consent={consent} onHealth={(health) => {
              setConsent({ ...consent, health })
              if (!health && me) setMe({ ...me, allergies: [], injury: null })
            }} /></>} />
        )}
      </main>
      {tab !== 'workouts' && <ActiveWorkoutBar onOpen={() => go('workouts')} />}
      {recap && week.days.length > 0 && (
        <Suspense fallback={null}>
          <WeekRecap days={week.days} goal={me?.targets?.calories ?? 2000} streak={week.streak} weightDelta={weekWeightDelta(measurements)}
            onClose={() => { markRecapSeen(); setRecapClosed(true); setRecapAsked(false) }} />
        </Suspense>
      )}
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
      {toast && (
        <div className={toast.undo ? 'toast toast-undo' : 'toast'} role="status" key={toast.id}>
          <span>{toast.text}</span>
          {toast.undo && <button onClick={() => { const undo = toast.undo!; setToast(null); undo().catch(() => flash('Не получилось отменить — попробуйте ещё раз')) }}>Отменить</button>}
        </div>
      )}
      {xpFloat && <div className="xp-float" key={xpFloat.id} aria-hidden="true" onAnimationEnd={() => setXpFloat(null)}>+{xpFloat.n} XP</div>}
      {party > 0 && <Confetti key={party} />}
      {storyOffer && canEdit && canStory() && (
        <Sheet title="Неделя для истории" onClose={() => setStoryOffer(false)}>
          <p className="sub">Карточка с вашей серией, XP и тренировками за неделю — с вашей ссылкой-приглашением в подписи.</p>
          <button className="btn" onClick={() => { setStoryOffer(false); shareStory({ kind: 'week' }).catch(() => flash('Не получилось открыть истории')) }}>Опубликовать в истории</button>
        </Sheet>
      )}
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

/** Above the tab bar while a workout is left open: its name, the time since the start (or the rest left), back in one tap. */
function ActiveWorkoutBar({ onOpen }: { onOpen: () => void }) {
  const [a, setA] = useState(loadActive)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const sync = () => setA(loadActive())
    window.addEventListener(ACTIVE_EVENT, sync)
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => { window.removeEventListener(ACTIVE_EVENT, sync); clearInterval(t) }
  }, [])
  if (!a) return null
  const clock = (ms: number) => { const sec = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` }
  const restEnd = Math.max(a.rest?.until ?? 0, a.restClock?.end ?? 0)
  const resting = restEnd > now
  return (
    <button className="active-workout" onClick={onOpen} aria-label={`Вернуться к тренировке «${a.title}»`}>
      <span className="active-workout-dot" aria-hidden="true" />
      <span className="step-text"><b>{a.title}</b><span className="sub">{resting ? `Отдых ${clock(restEnd - now)}` : `Идёт ${clock(now - a.startedAt)}`}</span></span>
      <span className="active-workout-go">Вернуться</span>
    </button>
  )
}

/** Weight change over the last 7 days of measurements (null with fewer than two). */
function weekWeightDelta(ms: Measurement[]): number | null {
  const since = new Date(Date.now() - 7 * 864e5).toLocaleDateString('sv-SE')
  const w = ms.filter((m) => m.weight_kg != null && m.measured_on >= since).sort((a, b) => a.measured_on.localeCompare(b.measured_on))
  return w.length > 1 ? Math.round((w[w.length - 1].weight_kg! - w[0].weight_kg!) * 10) / 10 : null
}
