import { useRef, useState } from 'react'
import { useCountUp } from './motion'
import { useBack } from './back'


const pct = (a: number, b: number) => `${b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0}%`

/** Progress bar. `warnOver`: past 110% of the goal it turns the warning colour and shows the excess as a hatched tail. */
export function Bar({ value, goal, color = 'var(--accent)', warnOver = false }: { value: number; goal: number; color?: string; warnOver?: boolean }) {
  const over = warnOver && goal > 0 && value > goal * 1.1
  return (
    <div className={over ? 'bar bar-over' : 'bar'}>
      <i style={{ width: pct(value, goal), background: over ? 'var(--warn)' : color }} />
    </div>
  )
}

export function Ring({ value: target, goal }: { value: number; goal: number }) {
  const value = useCountUp(target)
  const r = 42
  const c = 2 * Math.PI * r
  const frac = goal > 0 ? Math.min(1, value / goal) : 0
  const left = Math.round(goal - value)
  return (
    <svg width="104" height="104" viewBox="0 0 104 104" role="img" aria-label={`${Math.round(value)} из ${goal} ккал`}>
      <circle cx="52" cy="52" r={r} fill="none" stroke="var(--nutrition-ring-track)" strokeWidth="9" />
      {frac > 0 && <circle cx="52" cy="52" r={r} fill="none" stroke={value > goal * 1.1 ? 'var(--warn)' : 'var(--accent)'} strokeWidth="9"
        strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 52 52)" />}
      <text x="52" y="50" textAnchor="middle" fill="var(--text)" fontSize="20" fontWeight="650" textLength={Math.abs(left).toLocaleString('ru-RU').length > 6 ? 65 : undefined} lengthAdjust="spacingAndGlyphs">{Math.abs(left).toLocaleString('ru-RU')}</text>
      <text x="52" y="67" textAnchor="middle" fill="var(--muted)" fontSize="11">{left < 0 ? 'сверх нормы' : 'осталось'}</text>
    </svg>
  )
}

const CLOSE_PX = 110, CLOSE_SPEED = 0.6 // px/ms: a quick flick closes even when short

/** Bottom sheet. Pull it down by the handle or the title to close (like system sheets); also "Закрыть", the backdrop, Back, Esc. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useBack(onClose)
  const [dy, setDy] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const drag = useRef<{ y: number; t: number; moved: boolean } | null>(null)
  const close = () => { setLeaving(true); setTimeout(onClose, 180) }
  return (
    <div className={leaving ? 'sheet-backdrop leaving' : 'sheet-backdrop'} onClick={close}
      style={dy ? { background: `rgba(0, 0, 0, ${0.55 * Math.max(0, 1 - dy / 400)})` } : undefined}>
      <div className={dy ? 'sheet dragging' : 'sheet'} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}>
        <div className="sheet-grab"
          onPointerDown={(e) => { drag.current = { y: e.clientY, t: e.timeStamp, moved: false } }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            const move = e.clientY - d.y
            if (!d.moved && move > 6) { d.moved = true; e.currentTarget.setPointerCapture(e.pointerId) }
            if (d.moved) setDy(Math.max(0, move))
          }}
          onPointerUp={(e) => {
            const d = drag.current
            drag.current = null
            if (!d?.moved) return
            const move = e.clientY - d.y
            if (move > CLOSE_PX || move / Math.max(1, e.timeStamp - d.t) > CLOSE_SPEED) close()
            else setDy(0)
          }}
          onPointerCancel={() => { drag.current = null; setDy(0) }}>
          <span className="sheet-handle" aria-hidden="true" />
          <div className="card-head">
            <h2>{title}</h2>
            <button className="link" onClick={onClose}>Закрыть</button>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

/** A thin chevron (the "⌄" glyph sat low and looked heavy). Points down; parents turn it when open. */
export function Chevron({ dir = 'down' }: { dir?: 'down' | 'right' | 'left' }) {
  return (
    <svg className={dir === 'down' ? 'chev' : `chev chev-${dir}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
  )
}

const tipKey = (id: string) => `setly-tip-${id}`
const tipSeen = (id: string) => { try { return Boolean(localStorage.getItem(tipKey(id))) } catch { return true } }

/** A one-time hint about a gesture; "Понятно" hides it for good. `after`: wait until that tip is dismissed (one at a time). */
export function Tip({ id, after, children }: { id: string; after?: string; children: React.ReactNode }) {
  const [shown, setShown] = useState(() => !tipSeen(id) && (!after || tipSeen(after)))
  if (!shown) return null
  return (
    <div className="tip" role="note">
      <svg className="tip-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" /></svg>
      <span className="tip-text">{children}</span>
      <button className="tip-close" aria-label="Понятно, скрыть подсказку" onClick={() => { try { localStorage.setItem(tipKey(id), '1') } catch { /* private mode */ } setShown(false) }}>✕</button>
    </div>
  )
}
