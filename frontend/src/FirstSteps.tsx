// Home, for newcomers: four first actions, each one tap away. Hides itself when all are done (or on "Скрыть").
import { useState } from 'react'

export type Step = { key: string; title: string; hint: string; done: boolean; action: () => void }
const HIDDEN = 'fa.firstStepsHidden'

export default function FirstSteps({ steps }: { steps: Step[] }) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HIDDEN) === '1' } catch { return false } })
  const done = steps.filter((s) => s.done).length
  if (hidden || done === steps.length) return null
  const next = steps.find((s) => !s.done)

  function hide() {
    setHidden(true)
    try { localStorage.setItem(HIDDEN, '1') } catch { /* private mode: hidden for this session only */ }
  }

  return (
    <section className="card first-steps" aria-label="Первые шаги">
      <div className="card-head">
        <h2>Первые шаги</h2>
        <span className="sub">{done} из {steps.length}</span>
      </div>
      <div className="bar"><i style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol className="first-steps-list">
        {steps.map((s) => (
          <li key={s.key} className={s.done ? 'done' : s === next ? 'next' : ''}>
            <button disabled={s.done} onClick={s.action} aria-label={s.done ? `${s.title} — сделано` : s.title}>
              <span className="step-mark" aria-hidden="true">{s.done ? '✓' : ''}</span>
              <span className="step-text"><b>{s.title}</b>{!s.done && <span className="sub">{s.hint}</span>}</span>
              {!s.done && <span className="step-go" aria-hidden="true">›</span>}
            </button>
          </li>
        ))}
      </ol>
      <button className="link first-steps-hide" onClick={hide}>Скрыть</button>
    </section>
  )
}
