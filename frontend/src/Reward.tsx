import AchievementBadge from './AchievementBadge'
// Full-screen level-up celebration (Duolingo-style), shown when the level grows during the session.
import { useEffect, useState } from 'react'
import { haptic } from './haptics'

const CONFETTI = Array.from({ length: 18 }, (_, i) => i)

export default function Reward({ level, levelXp, needed, streak, onClose }: {
  level: number; levelXp: number; needed: number; streak: number; onClose: () => void
}) {
  useEffect(() => { haptic('success') }, [])
  return (
    <div className="reward" role="dialog" aria-modal="true" aria-label={`Новый уровень ${level}`}>
      <div className="confetti" aria-hidden="true">
        {CONFETTI.map((i) => <i key={i} style={{ left: `${(i * 53) % 100}%`, animationDelay: `${(i % 6) * 0.15}s` }} />)}
      </div>
      <div className="reward-body">
        <div className="badge" aria-hidden="true"><span>{level}</span></div>
        <p className="sub">Новый уровень!</p>
        <h1 className="reward-title">Уровень {level}</h1>
        <div className="reward-progress">
          <div className="bar"><i style={{ width: `${Math.min(100, (levelXp / needed) * 100)}%`, background: 'var(--accent)' }} /></div>
          <span className="sub">{levelXp} / {needed} XP до уровня {level + 1}</span>
        </div>
        {streak > 0 && <p className="sub">Серия: {streak} дн. подряд — так держать</p>}
      </div>
      <button className="btn" onClick={onClose} autoFocus>Продолжить</button>
    </div>
  )
}

/** Same celebration for a newly unlocked achievement. */
export function AchievementUnlocked({ code, icon, title, more, onClose, actionLabel = 'Отлично', viewing = false, hint, extra }: {
  code: string; icon: string; title: string; more: number; onClose: () => void; actionLabel?: string; viewing?: boolean; hint?: string; extra?: React.ReactNode
}) {
  const [replay, setReplay] = useState(0)
  useEffect(() => { if (!viewing) haptic('success') }, [viewing])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('keydown', escape); previous?.focus() }
  }, [onClose])
  const badge = (<button className="achievement-replay" aria-label="Повторить анимацию награды" onClick={() => setReplay((n) => n + 1)}>
          <span className="achievement-reveal" key={`${code}-${replay}`}><AchievementBadge code={code} fallback={icon} large /></span>
        </button>)
  if (viewing) return (
    <div className="award-overlay" role="presentation" onClick={onClose}>
      <section className="award-modal" role="dialog" aria-modal="true" aria-label={`Достижение: ${title}`} onClick={e => e.stopPropagation()}>
        <button className="award-close" onClick={onClose} aria-label="Закрыть" autoFocus>×</button>
        <div className="award-display">{badge}</div>
        <div className="award-heading"><span>ДОСТИЖЕНИЕ</span><h2>{title}</h2></div>
        <div className="award-detail"><span>УСЛОВИЕ И ПРОГРЕСС</span><p>{hint}</p></div>
        {extra}
      </section>
    </div>
  )
  return (
    <div className="reward" role="dialog" aria-modal="true" aria-label={`Достижение: ${title}`}>
      <div className="confetti" key={replay} aria-hidden="true">
        {CONFETTI.map((i) => <i key={i} style={{ left: `${(i * 53) % 100}%`, animationDelay: `${(i % 6) * 0.15}s` }} />)}
      </div>
      <div className="reward-body">
        {badge}
        <p className="sub">{viewing ? 'Достижение' : 'Новое достижение!'}</p>
        <h1 className="reward-title">{title}</h1>
        {viewing ? <><p className="sub">{hint}</p><p className="sub">Нажми на значок, чтобы повторить анимацию</p></> : <p className="sub">+25 XP</p>}
        {more > 0 && <p className="sub">И ещё {more} — посмотрите в «Прогрессе»</p>}
      </div>
      {extra}
      <button className={extra ? "award-dismiss" : "btn"} onClick={onClose} autoFocus>{actionLabel}</button>
    </div>
  )
}

/** Isolated visual preview: never awards XP or changes achievement state. */
export function AchievementPreview() {
  const [replay, setReplay] = useState(0)
  return <>
    <AchievementUnlocked key={replay} code="norm_7" icon="🎯" title="Точно в цель" more={0}
      actionLabel="Повторить анимацию" onClose={() => setReplay((n) => n + 1)} />
    <a className="achievement-preview-exit" href="/">Закрыть просмотр ×</a>
    <span className="achievement-preview-label">Предпросмотр награды · прогресс не меняется</span>
  </>
}
