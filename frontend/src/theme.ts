// Theme choice: 'auto' follows Telegram (light -> light, otherwise dark), or a fixed theme.
// Saved on the account (the Mini App's address changes with the tunnel, so browser storage alone gets lost);
// localStorage is only a fast first paint before the account loads.
import { useEffect, useRef, useState } from 'react'
import { tg } from './telegram'

export type ThemePref = 'auto' | 'dark' | 'light' | 'green'
export type Theme = Exclude<ThemePref, 'auto'>

export const THEMES: Record<ThemePref, string> = { auto: 'Как в Telegram', dark: 'Тёмная', light: 'Светлая', green: 'Салатовая' }
// Accent options for the dark theme (light keeps the same fill but darker text; green has its own)
export const ACCENTS = ['#c8f169', '#5ef2b0', '#a98bff', '#ff8a5b']

// On a light background the dark theme's pastel accents wash out: each gets a deeper fill and a dark text/button shade.
export const LIGHT: Record<string, { fill: string; text: string }> = {
  '#c8f169': { fill: '#8fc31f', text: '#4a6f00' },
  '#5ef2b0': { fill: '#16b881', text: '#08704e' },
  '#a98bff': { fill: '#8462f5', text: '#5a37d6' },
  '#ff8a5b': { fill: '#f2692f', text: '#b4431a' },
}

const BG: Record<Theme, string> = { dark: '#0e0f12', light: '#f3f4f6', green: '#0e1510' }

function read(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* private mode: keep in memory only */ }
}

export function resolveTheme(pref: ThemePref, telegramScheme = tg?.colorScheme): Theme {
  if (pref !== 'auto') return pref
  return telegramScheme === 'light' ? 'light' : 'dark'
}

export type ThemeSettings = { theme: ThemePref | null; accent: string | null }

export function useTheme(save?: (patch: Partial<ThemeSettings>) => void) {
  const [pref, setPref] = useState<ThemePref>(() => read('fa.theme', 'auto') as ThemePref)
  const [accent, setAccent] = useState(() => read('fa.accent', ACCENTS[0]))
  const [scheme, setScheme] = useState(tg?.colorScheme)
  const theme = resolveTheme(pref, scheme)
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save })

  useEffect(() => {
    const onChange = () => setScheme(tg?.colorScheme)
    tg?.onEvent?.('themeChanged', onChange)
    return () => tg?.offEvent?.('themeChanged', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    const light = theme === 'light' ? LIGHT[accent] ?? LIGHT[ACCENTS[0]] : null
    for (const [k, v] of Object.entries({
      '--accent': theme === 'green' ? null : light?.fill ?? accent,
      '--accent-text': light?.text ?? null,
      '--primary-bg': light?.text ?? null,
    })) { if (v) root.style.setProperty(k, v); else root.style.removeProperty(k) }
    tg?.setHeaderColor?.(BG[theme])
    tg?.setBackgroundColor?.(BG[theme])
    tg?.setBottomBarColor?.(BG[theme])
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BG[theme])
  }, [theme, accent])

  return {
    pref, theme, accent,
    setPref: (p: ThemePref) => { setPref(p); write('fa.theme', p); saveRef.current?.({ theme: p }) },
    setAccent: (a: string) => { setAccent(a); write('fa.accent', a); saveRef.current?.({ accent: a }) },
    /** Values from the account win; a choice made on this device before accounts kept it is uploaded once. */
    load: (s: ThemeSettings) => {
      if (s.theme) { setPref(s.theme); write('fa.theme', s.theme) }
      if (s.accent) { setAccent(s.accent); write('fa.accent', s.accent) }
      const local = { theme: s.theme ? undefined : read('fa.theme', 'auto'), accent: s.accent ? undefined : read('fa.accent', ACCENTS[0]) }
      const upload = { ...(local.theme && local.theme !== 'auto' ? { theme: local.theme as ThemePref } : {}),
        ...(local.accent && local.accent !== ACCENTS[0] ? { accent: local.accent } : {}) }
      if (Object.keys(upload).length) saveRef.current?.(upload)
    },
  }
}
