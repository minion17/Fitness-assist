import { useEffect, useRef } from 'react'
const tg = () => window.Telegram?.WebApp // read late: tests mock ./telegram

/** Open layers (sheets, full-screen views), newest last: Telegram's "Назад" and Esc close the top one. */
const layers: { close: () => void }[] = []
const closeTop = () => layers.at(-1)?.close()
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeTop() }

export function useBack(onBack: () => void) {
  const latest = useRef(onBack)
  useEffect(() => { latest.current = onBack })
  useEffect(() => {
    const layer = { close: () => latest.current() }
    if (!layers.length) { tg()?.BackButton?.onClick(closeTop); window.addEventListener('keydown', onKey) }
    layers.push(layer)
    tg()?.BackButton?.show()
    return () => {
      layers.splice(layers.indexOf(layer), 1)
      if (!layers.length) { tg()?.BackButton?.hide(); tg()?.BackButton?.offClick(closeTop); window.removeEventListener('keydown', onKey) }
    }
  }, [])
}
