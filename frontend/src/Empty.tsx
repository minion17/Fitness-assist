// Empty states: what will appear here and, optionally, the one action that fills it. No stock line drawings.
export default function Empty({ title, text, action }: {
  title?: string; text?: string; action?: { label: string; run: () => void }
}) {
  return (
    <div className="empty">
      {title && <b>{title}</b>}
      {text && <span className="sub">{text}</span>}
      {action && <button className="btn empty-action" onClick={action.run}>{action.label}</button>}
    </div>
  )
}
