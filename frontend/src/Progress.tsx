// "Прогресс": period summary, charts (calories, weight, water, macros, exercise records) and achievements.
import { useEffect, useState } from 'react'
import { BarChart, LineChart } from './charts'
import Empty from './Empty'
import Friends from './Friends'
import { cachedStats, loadStats, type Day, type Stats } from './stats'
import { Bar } from './ui'

export type Achievement = { code: string; icon: string; title: string; hint: string; progress: number; target: number; unlocked_at: string | null }

const PERIODS = [[7, 'Неделя'], [30, 'Месяц'], [90, '3 месяца']] as const
const fmt = (n: number, d = 0) => n.toLocaleString('ru-RU', { maximumFractionDigits: d })

export default function Progress({ canEdit, achievements, freezes, body }: {
  canEdit: boolean; achievements: Achievement[]; freezes: number; body: React.ReactNode
}) {
  const [days, setDays] = useState<number>(30)
  const [s, setS] = useState<Stats | null>(() => cachedStats(30))
  const [error, setError] = useState('')
  const [ex, setEx] = useState<number | null>(null)
  const [chart, setChart] = useState<'calories' | 'water' | 'weight'>('calories')
  const [view, setView] = useState<'me' | 'friends'>('me')

  useEffect(() => {
    if (!canEdit) return
    let stale = false
    loadStats(days)
      .then((r) => { if (!stale && r) { setS(r); setError('') } })
      .catch(() => !stale && setError('Не удалось загрузить статистику'))
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
          <button role="tab" aria-selected={view === 'friends'} onClick={() => setView('friends')}>Друзья</button>
        </div>
      )}
      {view === 'friends' ? <Friends /> : <>
      {!canEdit && <p className="sub">Демо-режим: графики появятся, когда откроете приложение из Telegram и начнёте вести дневник.</p>}
      {canEdit && (
        <div className="seg seg-row progress-period" role="group" aria-label="Период">
          {PERIODS.map(([n, label]) => <button key={n} aria-pressed={days === n} onClick={() => { setDays(n); const kept = cachedStats(n); if (kept) setS(kept) }}>{label}</button>)}
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {s && (
        <>
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
            <section className="card tile-stat">
              <span className="sub">Вес</span>
              <div className="stat">{w.length ? fmt(w[w.length - 1].kg, 1) : '—'}<small>кг</small></div>
              <span className={delta !== null && delta <= 0 ? 'sub pos' : 'sub'}>
                {delta === null ? 'запишите вес ниже' : `${delta > 0 ? '+' : ''}${fmt(delta, 1)} кг за период`}
              </span>
            </section>
            <section className="card tile-stat">
              <span className="sub">Тренировок</span>
              <div className="stat">{workouts}</div>
              <span className="sub">вода ≈ {fmt((waterDays.reduce((a, d) => a + d.water_ml, 0) / Math.max(1, waterDays.length)) / 1000, 1)} л/день</span>
            </section>
          </div>

          </section>
          <section className="card progress-chart">
            <h2>Динамика</h2>
            <div className="seg seg-row progress-chart-tabs" role="group" aria-label="Показатель графика">
              <button aria-pressed={chart === 'calories'} onClick={() => setChart('calories')}>Калории</button>
              <button aria-pressed={chart === 'water'} onClick={() => setChart('water')}>Вода</button>
              <button aria-pressed={chart === 'weight'} onClick={() => setChart('weight')}>Вес</button>
            </div>
            {chart === 'calories' && <BarChart data={s.days.map((d) => ({ date: d.date, value: d.kcal }))} color="var(--accent)" goal={s.goal?.calories} unit="ккал" height={76} />}
            {chart === 'water' && <BarChart data={s.days.map((d) => ({ date: d.date, value: d.water_ml }))} color="var(--water)" goal={s.goal?.water_ml} unit="мл" height={76} />}
            {chart === 'weight' && (w.length ? <LineChart points={w.map((p) => ({ date: p.date, value: p.kg }))} color="var(--accent)" unit="кг" height={76} /> : <Empty art="chart" title="Пока нет записей веса" text="Запишите вес в разделе ниже — здесь появится линия, как он меняется." />)}
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

          {exercise && (
            <section className="card">
              <h2>Рабочие веса</h2>
              <div className="chips-scroll" role="group" aria-label="Упражнение">
                {s.exercises.map((e) => (
                  <button key={e.id} className="chip" aria-pressed={e.id === exercise.id} onClick={() => setEx(e.id)}>{e.name}</button>
                ))}
              </div>
              {exercise.points.some((p) => p.kg > 0)
                ? <LineChart points={exercise.points.map((p) => ({ date: p.date, value: p.kg }))} color="var(--accent)" unit="кг" height={76} />
                : <p className="sub">Упражнение с собственным весом: лучший подход — {Math.max(...exercise.points.map((p) => p.reps))} повт.</p>}
            </section>
          )}
        </>
      )}

      {canEdit && achievements.length > 0 && (
        <details className="card achievements-disclosure">
          <summary><span>Достижения</span><span className="sub">{unlocked} из {achievements.length} <span aria-hidden="true">⌄</span></span></summary>
          <p className="sub">❄ Заморозок серии: {freezes} из 2 — даются за каждые 7 дней подряд и спасают серию, если день пропущен.</p>
          <div className="badges">
            {achievements.map((a) => (
              <div key={a.code} className={a.unlocked_at ? 'badge-item on' : 'badge-item'} title={a.hint}>
                <span className="badge-icon" aria-hidden="true">{a.icon}</span>
                <b>{a.title}</b>
                {a.unlocked_at
                  ? <span className="sub">{new Date(a.unlocked_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>
                  : <>
                    <span className="sub">{a.hint}</span>
                    {a.target > 1 && <Bar value={a.progress} goal={a.target} />}
                  </>}
              </div>
            ))}
          </div>
        </details>
      )}
      {body}
      </>}
    </>
  )
}
