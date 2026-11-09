// Small motion helpers: counting numbers and a check for "reduce motion".
import { useEffect, useRef, useState } from 'react'

/** Animations are off when the phone asks for less motion (and where it can't be asked, e.g. tests). */
export const animate = () => typeof window !== 'undefined' && !!window.matchMedia && !window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** A number that counts up (or down) to `value` instead of jumping: 0 -> 1 209 on open, 991 -> 1 191 after a meal. */
export function useCountUp(value: number, ms = 650): number {
  const [shown, setShown] = useState(() => (animate() ? 0 : value))
  const from = useRef(shown)
  useEffect(() => {
    if (!animate()) { from.current = value; const id = requestAnimationFrame(() => setShown(value)); return () => cancelAnimationFrame(id) }
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
