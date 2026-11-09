// Friendly empty states: a small line drawing in the accent colour, one sentence and (optionally) one action.
const ART: Record<string, React.ReactNode> = {
  workouts: (<>
    <rect x="14" y="34" width="10" height="28" rx="4" /><rect x="26" y="28" width="10" height="40" rx="4" />
    <rect x="84" y="28" width="10" height="40" rx="4" /><rect x="96" y="34" width="10" height="28" rx="4" />
    <path d="M36 48h48" /><path className="accent-fill" d="M60 18l3 6 6 1-4.5 4 1 6-5.5-3-5.5 3 1-6L51 25l6-1z" />
  </>),
  friends: (<>
    <circle cx="44" cy="36" r="11" /><path d="M24 74c2-13 10-20 20-20s18 7 20 20" />
    <circle cx="78" cy="40" r="9" /><path d="M62 74c2-10 8-15 16-15s14 5 16 15" />
    <path className="accent-fill" d="M61 22c0-4 6-6 8-1 2-5 8-3 8 1 0 5-8 9-8 9s-8-4-8-9z" />
  </>),
  plate: (<>
    <circle cx="60" cy="48" r="28" /><circle cx="60" cy="48" r="18" />
    <path d="M18 24v20M14 24v10a4 4 0 0 0 8 0V24M18 44v30" /><path d="M102 24c-6 4-6 16 0 20v30" />
    <circle className="accent-fill" cx="60" cy="48" r="6" />
  </>),
  chart: (<>
    <path d="M16 74h88" /><rect x="24" y="52" width="12" height="22" rx="3" /><rect x="44" y="40" width="12" height="34" rx="3" />
    <rect x="64" y="46" width="12" height="28" rx="3" /><rect className="accent-fill" x="84" y="26" width="12" height="48" rx="3" />
  </>),
}

export default function Empty({ art, title, text, action }: {
  art: keyof typeof ART; title?: string; text?: string; action?: { label: string; run: () => void }
}) {
  return (
    <div className="empty">
      <svg width="120" height="88" viewBox="0 0 120 88" aria-hidden="true" className="empty-art">{ART[art]}</svg>
      {title && <b>{title}</b>}
      {text && <span className="sub">{text}</span>}
      {action && <button className="btn empty-action" onClick={action.run}>{action.label}</button>}
    </div>
  )
}
