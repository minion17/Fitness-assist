// Full-screen level-up celebration (Duolingo-style), shown when the level grows during the session.
import { useEffect } from 'react'
import { tg } from './telegram'

const CONFETTI = Array.from({ length: 18 }, (_, i) => i)

export default function Reward({ level, levelXp, needed, streak, onClose }: {
  level: number; levelXp: number; needed: number; streak: number; onClose: () => void
}) {
  useEffect(() => { tg?.HapticFeedback?.notificationOccurred?.('success') }, [])
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
