import AchievementBadge from './AchievementBadge'
import { AchievementUnlocked } from './Reward'
// "Прогресс": period summary, charts (calories, weight, water, macros, exercise records) and achievements.
import { useEffect, useState } from 'react'
import { BarChart, LineChart } from './charts'
import Empty from './Empty'
import Friends from './Friends'
import League from './League'
import MuscleWeek from './MuscleWeek'
import { cachedStats, loadStats, type Day, type Stats } from './stats'
import { Bar, Chevron } from './ui'

export type Achievement = { title_selected?: boolean; holder_percent?: number | null; quote?: string; featured?: boolean; pinned?: boolean; stage?: number; stage_xp?: number; code: string; icon: string; title: string; hint: string; progress: number; target: number; unlocked_at: string | null }

const PERIODS = [[7, 'Неделя'], [30, 'Месяц'], [90, '3 месяца']] as const
const fmt = (n: number, d = 0) => n.toLocaleString('ru-RU', { maximumFractionDigits: d })

type Part = 'food' | 'body' | 'training' | 'awards'
const PARTS: [Part, string][] = [['food', 'Питание'], ['body', 'Тело'], ['training', 'Тренировки'], ['awards', 'Награды']]

export default function Progress({ canEdit, achievements, freezes, body, top, bodyTop, weightGoal, onShowcase, onTitle }: {
  canEdit: boolean; achievements: Achievement[]; freezes: number; body: React.ReactNode
  top?: React.ReactNode // this week + the AI summary: the «Питание» part
  bodyTop?: React.ReactNode // real expenditure: the «Тело» part
  onTitle?: (code: string | null) => Promise<void>
  onShowcase?: (codes: string[], pinned: string | null) => Promise<void>
  weightGoal?: number | null
}) {
  // one part at a time: the screen had grown to ten blocks in a row
  const [part, setPart] = useState<Part>(() => { try { return (sessionStorage.getItem('setly-progress-part') as Part) || 'food' } catch { return 'food' } })
  const choosePart = (p: Part) => { setPart(p); try { sessionStorage.setItem('setly-progress-part', p) } catch { /* private mode */ } }
  const [selectedAward, setSelectedAward] = useState<Achievement | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const featured = achievements.filter(a => a.featured).map(a => a.code)
  const pinned = achievements.find(a => a.pinned)?.code ?? null
  async function saveDisplay(codes: string[], pin: string | null) {
    setSaving(true); setSaveError('')
    try { await onShowcase?.(codes, pin) }
    catch { setSaveError('Не удалось сохранить. Попробуй ещё раз.') }
    finally { setSaving(false) }
  }
  const [partsOpen, setPartsOpen] = useState(false)
  const [periodOpen, setPeriodOpen] = useState(false)
  const [days, setDays] = useState<number>(30)
  const [s, setS] = useState<Stats | null>(() => cachedStats(30))
  const [error, setError] = useState('')
  const [ex, setEx] = useState<number | null>(null)
  const [chart, setChart] = useState<'calories' | 'water'>('calories')
  const [view, setView] = useState<'me' | 'friends' | 'league'>('me')

  useEffect(() => {
    if (!canEdit) return
    let stale = false
    loadStats(days)
      .then((r) => { if (!stale && r) { setS(r); setError('') } })
      .catch(() => !stale && setError('Нет связи — графики появятся, как только вернётся интернет'))
    return () => { stale = true }
  }, [canEdit, days])

  const logged = s?.days.filter((d) => d.kcal > 0) ?? []
  const avg = (k: keyof Day) => (logged.length ? logged.reduce((a, d) => a + (d[k] as number), 0) / logged.length : 0)
  const inNorm = s?.goal ? logged.filter((d) => Math.abs(d.kcal - s.goal!.calories) <= 0.1 * s.goal!.calories).length : 0
  const waterDays = s?.days.filter((d) => d.water_ml > 0) ?? []
  const workouts = s?.days.reduce((a, d) => a + d.workouts, 0) ?? 0
  const w = s?.weight ?? []
  const delta = w.length > 1 ? w[w.length - 1].kg - w[0].kg : null
  const exercise = s?.exercises.find((e) => e.id === ex) ?? s?.exercises[0]
  const unlocked = achievements.filter((a) => a.unlocked_at).length

  return (
    <>
      <h1>Прогресс</h1>
      {canEdit && (
        <div className="tabs progress-view" role="tablist" aria-label="Раздел">
          <button role="tab" aria-selected={view === 'me'} onClick={() => setView('me')}>Мой прогресс</button>
          <button role="tab" aria-selected={view === 'league'} onClick={() => setView('league')}>Лига</button>
          <button role="tab" aria-selected={view === 'friends'} onClick={() => setView('friends')}>Друзья</button>
        </div>
      )}
      {view === 'friends' ? <Friends /> : view === 'league' ? <League /> : <>
      {!canEdit && <p className="sub">Демо-режим: графики появятся, когда откроешь приложение из Telegram и начнёшь вести дневник.</p>}
      <div className="progress-filters">
      <div className="progress-picker" role="group" aria-label="Что смотреть">
        <button className="progress-picker-current" aria-expanded={partsOpen} aria-controls="progress-parts-menu" onClick={() => { setPartsOpen(!partsOpen); setPeriodOpen(false) }}>
          {PARTS.find(([p]) => p === part)?.[1]} <Chevron dir="right" />
        </button>
        {partsOpen && <div className="progress-picker-options" id="progress-parts-menu">
          {PARTS.filter(([p]) => p !== part).map(([p, label]) => <button key={p} onClick={() => { choosePart(p); setPartsOpen(false) }}>{label}</button>)}
        </div>}
      </div>
      {canEdit && part !== 'awards' && (
        <div className="progress-picker" role="group" aria-label="Период">
          <button className="progress-picker-current" aria-expanded={periodOpen} aria-controls="progress-period-menu" onClick={() => { setPeriodOpen(!periodOpen); setPartsOpen(false) }}>
            {PERIODS.find(([n]) => n === days)?.[1]} <Chevron dir="right" />
          </button>
          {periodOpen && <div className="progress-picker-options" id="progress-period-menu">
            {PERIODS.filter(([n]) => n !== days).map(([n, label]) => <button key={n} onClick={() => { setDays(n); const kept = cachedStats(n); if (kept) setS(kept); setPeriodOpen(false) }}>{label}</button>)}
          </div>}
        </div>
      )}
      </div>
      {error && <p className="error">{error}</p>}

      {part === 'food' && <>
        {top}
        {s && <>
          <section className="card progress-overview">
            <div className="card-head"><h2>Итоги периода</h2><span className="sub">{PERIODS.find(([n]) => n === days)?.[1]}</span></div>
            <div className="grid2 progress-summary">
              <section className="card tile-stat">
                <span className="sub">Калории в среднем</span>
                <div className="stat">{fmt(avg('kcal'))}<small>ккал</small></div>
                {s.goal && <span className="sub">норма {fmt(s.goal.calories)}</span>}
              </section>
              <section className="card tile-stat">
                <span className="sub">Дней в норме</span>
                <div className="stat">{inNorm}<small>из {logged.length}</small></div>
                <span className="sub">±10% от нормы</span>
              </section>
            </div>
          </section>
          <section className="card progress-chart">
            <h2>Калории и вода по дням</h2>
            <div className="seg seg-row progress-chart-tabs" role="group" aria-label="Показатель графика">
              <button aria-pressed={chart === 'calories'} onClick={() => setChart('calories')}>Калории</button>
              <button aria-pressed={chart === 'water'} onClick={() => setChart('water')}>Вода</button>
            </div>
            {chart === 'calories' && <BarChart data={s.days.map((d) => ({ date: d.date, value: d.kcal }))} color="var(--accent)" goal={s.goal?.calories} unit="ккал" height={150} />}
            {chart === 'water' && <BarChart data={s.days.map((d) => ({ date: d.date, value: d.water_ml }))} color="var(--water)" goal={s.goal?.water_ml} unit="мл" height={150} />}
            {chart === 'water' && <p className="sub">В среднем ≈ {fmt((waterDays.reduce((a, d) => a + d.water_ml, 0) / Math.max(1, waterDays.length)) / 1000, 1)} л в день</p>}
          </section>
          {s.goal && logged.length > 0 && (
            <section className="card">
              <div className="card-head"><h2>БЖУ в среднем</h2><span className="sub">за дни с записями</span></div>
              {([['Белки', 'protein', 'var(--protein)'], ['Жиры', 'fat', 'var(--fat)'], ['Углеводы', 'carbs', 'var(--carbs)']] as const).map(([label, k, color]) => (
                <div key={k}>
                  <div className="macro-row"><span>{label}</span><span>{fmt(avg(k))} / {s.goal![k]} г</span></div>
                  <Bar value={avg(k)} goal={s.goal![k]} color={color} />
                </div>
              ))}
            </section>
          )}
        </>}
      </>}

      {part === 'body' && <>
        {s && (
          <section className="card progress-weight">
            <div className="card-head"><h2>Вес</h2>
              {delta !== null && <span className={delta <= 0 ? 'sub pos' : 'sub'}>{delta > 0 ? '+' : ''}{fmt(delta, 1)} кг за {PERIODS.find(([n]) => n === days)?.[1].toLowerCase()}</span>}</div>
            {w.length
              ? <LineChart points={w.map((p) => ({ date: p.date, value: p.kg }))} color="var(--accent)" unit="кг" height={170} goal={weightGoal} />
              : <Empty art="chart" title="Пока нет записей веса" text="Запиши вес на Главной — здесь появится линия, как он меняется, и твоя цель." />}
            {weightGoal && w.length > 0 && <p className="sub">До цели {fmt(Math.abs(w[w.length - 1].kg - weightGoal), 1)} кг</p>}
          </section>
        )}
        {bodyTop}
        {body}
      </>}

      {part === 'training' && s && <>
        <section className="card progress-overview">
          <div className="grid2 progress-summary">
            <section className="card tile-stat">
              <span className="sub">Тренировок</span>
              <div className="stat">{workouts}</div>
              <span className="sub">за {PERIODS.find(([n]) => n === days)?.[1].toLowerCase()}</span>
            </section>
            <section className="card tile-stat">
              <span className="sub">Упражнений с весами</span>
              <div className="stat">{s.exercises.length}</div>
              <span className="sub">прогресс ниже</span>
            </section>
          </div>
        </section>
        {canEdit && <MuscleWeek />}
        {exercise ? (
          <section className="card">
            <h2>Рабочие веса</h2>
            <div className="chips-scroll" role="group" aria-label="Упражнение">
              {s.exercises.map((e) => (
                <button key={e.id} className="chip" aria-pressed={e.id === exercise.id} onClick={() => setEx(e.id)}>{e.name}</button>
              ))}
            </div>
            {exercise.points.some((p) => p.kg > 0)
              ? <LineChart points={exercise.points.map((p) => ({ date: p.date, value: p.kg }))} color="var(--accent)" unit="кг" height={140} />
              : <p className="sub">Упражнение с собственным весом: лучший подход — {Math.max(...exercise.points.map((p) => p.reps))} повт.</p>}
          </section>
        ) : <Empty art="workouts" title="Пока нет тренировок за период" text="Проведи тренировку — здесь появятся рабочие веса и нагрузка на мышцы." />}
      </>}

      {part === 'awards' && (
        <section className="card">
          <div className="card-head"><h2>Достижения</h2><span className="sub">{unlocked} из {achievements.length}</span></div>
          <p className="sub">❄ Заморозок серии: {freezes} из 2 — даются за каждые 7 дней подряд и спасают серию, если день пропущен.</p>
          <div className="badges">
            {achievements.map((a) => (
              <button type="button" key={a.code} onClick={() => setSelectedAward(a)} aria-label={`Открыть достижение: ${a.title}`} className={a.unlocked_at ? 'badge-item on' : 'badge-item'} title={a.hint}>
                <span data-stage={a.stage} className="badge-icon" aria-hidden="true"><AchievementBadge code={a.code} fallback={a.icon} /></span>
                <b>{a.title}</b>
                {a.stage !== undefined && <span className="sub">Ступень {a.stage} / 5</span>}
                {a.unlocked_at
                  ? <span className="sub">{new Date(a.unlocked_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>
                  : <>
                    <span className="sub">{a.hint}</span>
                    {a.target > 1 && <Bar value={a.progress} goal={a.target} />}
                  </>}
              </button>
            ))}
          </div>
        </section>
      )}
      </>}
      {selectedAward && <AchievementUnlocked {...selectedAward} more={0} viewing hint={selectedAward.stage !== undefined ? `${selectedAward.hint} · ступень ${selectedAward.stage} из 5 · ${selectedAward.stage === 5 ? "Все ступени получены" : `${selectedAward.progress} / ${selectedAward.target} · +${selectedAward.stage_xp} XP за ступень`}` : selectedAward.unlocked_at ? selectedAward.hint : `Пока не получено. ${selectedAward.hint}`} extra={canEdit && onShowcase && <div className="award-actions">
        <button className="btn" disabled={!selectedAward.unlocked_at || saving || (!featured.includes(selectedAward.code) && featured.length >= 3)}
          onClick={() => saveDisplay(featured.includes(selectedAward.code) ? featured.filter(c => c !== selectedAward.code) : [...featured, selectedAward.code], pinned)}>
          {featured.includes(selectedAward.code) ? 'Убрать с профиля' : 'На профиль'}
        </button>
        <button className="btn btn-ghost" disabled={!selectedAward.unlocked_at || saving}
          onClick={() => saveDisplay(featured, pinned === selectedAward.code ? null : selectedAward.code)}>
          {pinned === selectedAward.code ? 'Убрать у имени' : 'Закрепить с именем'}
        </button>
        <span role="status">{!selectedAward.unlocked_at ? 'Получи награду, чтобы закрепить её в профиле.' : featured.length === 3 && !featured.includes(selectedAward.code) ? 'Витрина заполнена. Сними один из трёх значков.' : `На витрине: ${featured.length} из 3`}</span>
        {selectedAward.unlocked_at && onTitle && <button className="btn btn-ghost" disabled={saving} onClick={async () => {
          setSaving(true); setSaveError('')
          try { await onTitle(selectedAward.title_selected ? null : selectedAward.code); setSelectedAward({ ...selectedAward, title_selected: !selectedAward.title_selected }) }
          catch { setSaveError('Не удалось сохранить. Попробуй ещё раз.') }
          finally { setSaving(false) }
        }}>{selectedAward.title_selected ? 'Убрать титул' : 'Выбрать титул'}</button>}
        {saveError && <span role="alert">{saveError}</span>}
      </div>} actionLabel="Закрыть" onClose={() => setSelectedAward(null)} />}
    </>
  )
}
