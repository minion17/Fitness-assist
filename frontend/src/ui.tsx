const pct = (a: number, b: number) => `${b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0}%`

export function Bar({ value, goal, color = 'var(--accent)' }: { value: number; goal: number; color?: string }) {
  return (
    <div className="bar">
      <i style={{ width: pct(value, goal), background: color }} />
    </div>
  )
}

export function Ring({ value, goal }: { value: number; goal: number }) {
  const r = 42
  const c = 2 * Math.PI * r
  const frac = goal > 0 ? Math.min(1, value / goal) : 0
  const left = Math.round(goal - value)
  return (
    <svg width="104" height="104" viewBox="0 0 104 104" role="img" aria-label={`${Math.round(value)} из ${goal} ккал`}>
      <circle cx="52" cy="52" r={r} fill="none" stroke="var(--card-2)" strokeWidth="9" />
      <circle cx="52" cy="52" r={r} fill="none" stroke={left < 0 ? 'var(--fat)' : 'var(--accent)'} strokeWidth="9"
        strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 52 52)" />
      <text x="52" y="50" textAnchor="middle" fill="var(--text)" fontSize="20" fontWeight="650">{Math.abs(left)}</text>
      <text x="52" y="67" textAnchor="middle" fill="var(--muted)" fontSize="11">{left < 0 ? 'ккал сверх нормы' : 'ккал осталось'}</text>
    </svg>
  )
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="link" onClick={onClose}>Закрыть</button>
        </div>
        {children}
      </div>
    </div>
  )
}
