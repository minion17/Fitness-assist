// Theme choice: 'auto' follows Telegram (light -> light, otherwise dark), or a fixed theme.
// shortcut: stored per device in localStorage; move to the profile if it should sync across devices.
import { useEffect, useState } from 'react'
import { tg } from './telegram'

export type ThemePref = 'auto' | 'dark' | 'light' | 'green'
export type Theme = Exclude<ThemePref, 'auto'>

export const THEMES: Record<ThemePref, string> = { auto: 'Как в Telegram', dark: 'Тёмная', light: 'Светлая', green: 'Салатовая' }
// Accent options for the dark theme (light keeps the same fill but darker text; green has its own)
export const ACCENTS = ['#c8f169', '#5ef2b0', '#a98bff', '#ff8a5b']

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

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => read('fa.theme', 'auto') as ThemePref)
  const [accent, setAccent] = useState(() => read('fa.accent', ACCENTS[0]))
  const [scheme, setScheme] = useState(tg?.colorScheme)
  const theme = resolveTheme(pref, scheme)

  useEffect(() => {
    const onChange = () => setScheme(tg?.colorScheme)
    tg?.onEvent?.('themeChanged', onChange)
    return () => tg?.offEvent?.('themeChanged', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    if (theme === 'green') root.style.removeProperty('--accent')
    else root.style.setProperty('--accent', accent)
    tg?.setHeaderColor?.(BG[theme])
    tg?.setBackgroundColor?.(BG[theme])
    tg?.setBottomBarColor?.(BG[theme])
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BG[theme])
  }, [theme, accent])

  return {
    pref, theme, accent,
    setPref: (p: ThemePref) => { setPref(p); write('fa.theme', p) },
    setAccent: (a: string) => { setAccent(a); write('fa.accent', a) },
  }
}
