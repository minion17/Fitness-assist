// Home, for newcomers: four first actions, each one tap away. Gone when all are done; "Свернуть" keeps a one-line bar to reopen it.
import { useState } from 'react'

export type Step = { key: string; title: string; hint: string; done: boolean; action: () => void }
const HIDDEN = 'fa.firstStepsHidden' // "1" = collapsed to the one-line bar

export default function FirstSteps({ steps }: { steps: Step[] }) {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(HIDDEN) === '1' } catch { return false } })
  const done = steps.filter((s) => s.done).length
  if (done === steps.length) return null
  const next = steps.find((s) => !s.done)

  function collapse(value: boolean) {
    setCollapsed(value)
    try { localStorage.setItem(HIDDEN, value ? '1' : '0') } catch { /* private mode: remembered for this session only */ }
  }

  if (collapsed) {
    return (
      <button className="card first-steps-bar" onClick={() => collapse(false)} aria-label={`Первые шаги: ${done} из ${steps.length}. Открыть`}>
        <span className="first-steps-ring" style={{ '--p': `${(done / steps.length) * 100}%` } as React.CSSProperties} aria-hidden="true" />
        <span className="step-text"><b>Первые шаги · {done} из {steps.length}</b>{next && <span className="sub">Дальше: {next.title.toLowerCase()}</span>}</span>
        <span className="step-go" aria-hidden="true">›</span>
      </button>
    )
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
      <button className="link first-steps-hide" onClick={() => collapse(true)}>Свернуть</button>
    </section>
  )
}
