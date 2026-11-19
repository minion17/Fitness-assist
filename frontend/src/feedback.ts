// Touch feedback in one place: a few kinds of vibration (Telegram's haptics), and optional sounds.
// Restraint is the point: taps on ordinary buttons stay silent; saves, records and the end of a rest are felt.
import { tg } from './telegram'

type Haptic = 'select' | 'light' | 'save' | 'success' | 'warning'
const VIBRATION = 'setly-haptics' // on unless switched off
const SOUND = 'setly-sounds' // off unless switched on

const read = (k: string, def: boolean) => { try { const v = localStorage.getItem(k); return v === null ? def : v === '1' } catch { return def } }
export const hapticsOn = () => read(VIBRATION, true)
export const soundsOn = () => read(SOUND, false)
export const setHaptics = (on: boolean) => { try { localStorage.setItem(VIBRATION, on ? '1' : '0') } catch { /* private mode */ } }
export const setSounds = (on: boolean) => { try { localStorage.setItem(SOUND, on ? '1' : '0') } catch { /* private mode */ } }

let lastAt = 0
/** One vibration at most every 120 ms: a burst of updates never turns into a buzz. */
export function haptic(kind: Haptic) {
  const h = tg?.HapticFeedback
  const now = Date.now()
  if (!hapticsOn() || now - lastAt < 120) return
  lastAt = now
  if (!h) { if (kind === 'success') try { navigator.vibrate?.(30) } catch { /* not supported */ } return }
  if (kind === 'select') h.selectionChanged?.()
  else if (kind === 'light') h.impactOccurred?.('light')
  else if (kind === 'save') h.impactOccurred?.('medium')
  else h.notificationOccurred?.(kind)
}

let ctx: AudioContext | null = null
/** Short synthesized tones (no files): a soft click for a saved set, a two-note chime when a rest is over. */
export function sound(kind: 'click' | 'chime') {
  if (!soundsOn()) return
  try {
    ctx ??= new AudioContext()
    const notes = kind === 'click' ? [[880, 0, 0.06]] : [[660, 0, 0.18], [990, 0.16, 0.28]]
    for (const [f, at, len] of notes) {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + at
      o.type = 'sine'; o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + len)
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + len + 0.02)
    }
  } catch { /* no audio here */ }
}
