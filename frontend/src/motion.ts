// Small motion helpers: counting numbers and a check for "reduce motion".
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

/** Animations are off when the phone asks for less motion (and where it can't be asked, e.g. tests). */
export const animate = () => typeof window !== 'undefined' && !!window.matchMedia && !window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** A number that glides to `value` when it changes (991 -> 1 191 after a meal). On open, and when data first
 * arrives after loading, it just shows: counting up from zero on every visit reads as decoration. */
export function useCountUp(value: number, ms = 650): number {
  const [shown, setShown] = useState(value)
  const from = useRef(shown)
  useEffect(() => {
    if (!animate() || from.current === 0) { from.current = value; const id = requestAnimationFrame(() => setShown(value)); return () => cancelAnimationFrame(id) }
    const start = performance.now(), a = from.current
    let id = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms)
      const v = a + (value - a) * (1 - (1 - k) ** 3)  // ease-out
      from.current = v
      setShown(v)
      if (k < 1) id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [value, ms])
  return shown
}

/** A state change as a morph (View Transitions API): elements with the same view-transition-name glide between the
 * two screens, the rest cross-fades. Without the API, or with less motion asked, it just happens. */
export function morph(change: () => void) {
  const d = document as Document & { startViewTransition?: (cb: () => void) => unknown }
  if (!d.startViewTransition || !animate()) return change()
  d.startViewTransition(() => flushSync(change))
}
