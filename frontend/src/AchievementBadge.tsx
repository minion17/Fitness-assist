import type { CSSProperties } from 'react'

type Artwork = { sheet: 'core' | 'additional'; column: number; row?: number }

const individualArtwork = new Set([
  'first_water', 'first_meal', 'first_workout', 'streak_3', 'streak_7',
  'streak_30', 'streak_100', 'water_7', 'glasses_100', 'norm_7',
  'workouts_10', 'workouts_50', 'measure_4', 'level_5',
])
const progressiveArtwork = new Set(['iron_will', 'personal_best', 'food_habits', 'like_water'])
// Compensate for transparent margins without clipping the actual illustrations.
const artworkScale: Record<string, string> = {
  first_meal: '140%', first_water: '112%', first_workout: '97%',
  streak_3: '123%', streak_7: '125%', streak_30: '145%', streak_100: '119%',
  water_7: '101%', glasses_100: '128%', norm_7: '102%',
  workouts_10: '101%', workouts_50: '144%', measure_4: '128%', level_5: '127%',
  iron_will: '122%', personal_best: '133%', food_habits: '140%', like_water: '109%',
}

const artwork: Record<string, Artwork> = {
  first_water: { sheet: 'additional', column: 0 },
  first_meal: { sheet: 'core', column: 5 },
  streak_3: { sheet: 'additional', column: 1 },
  streak_7: { sheet: 'additional', column: 2 },
  streak_30: { sheet: 'additional', column: 3, row: 1 },
  streak_100: { sheet: 'additional', column: 4, row: 2 },
  water_7: { sheet: 'additional', column: 5, row: 1 },
  glasses_100: { sheet: 'additional', column: 6, row: 2 },
  norm_7: { sheet: 'additional', column: 7, row: 1 },
  measure_4: { sheet: 'additional', column: 8, row: 1 },
  level_5: { sheet: 'core', column: 2, row: 2 },
  iron_will: { sheet: 'core', column: 3 },
  personal_best: { sheet: 'core', column: 0 },
  food_habits: { sheet: 'core', column: 5 },
  like_water: { sheet: 'additional', column: 5 },
  future_run: { sheet: 'core', column: 4 },
  future_sleep: { sheet: 'core', column: 7 },
}

export default function AchievementBadge({ code, fallback, large = false, stage }: {
  code: string; fallback: string; large?: boolean; stage?: number
}) {
  const item = artwork[code]
  const className = `achievement-art${large ? ' achievement-art-large' : ''}`
  if (individualArtwork.has(code) || (progressiveArtwork.has(code) && (stage ?? 1) <= 1)) {
    const tier = Number.isFinite(stage) ? Math.max(1, Math.min(5, Math.floor(stage!))) : 1
    const filename = progressiveArtwork.has(code) ? `${code}_${tier}` : code
    return <span className={`${className} achievement-art-independent`} style={{ backgroundImage: `url(/images/achievements/individual/${filename}.png?v=3)`, backgroundSize: artworkScale[code] ?? 'contain' }} aria-hidden="true" />
  }
  if (!item) return <span className={`${className} achievement-art-fallback`} aria-hidden="true">{fallback}</span>

  // Three approved illustrations represent five earned levels, from simplest to most detailed.
  const row = stage === undefined ? item.row ?? 0 : stage <= 2 ? 0 : stage <= 4 ? 1 : 2
  const positions = item.sheet === 'core'
    ? [2.5, 15.8, 27.9, 40.6, 52.9, 64.6, 76.6, 87.5, 98.9]
    : [2.1, 14.1, 25.9, 38.3, 50.2, 62.6, 74.5, 86.7, 98.9]
  // Narrow each window around its centre so neighbouring illustrations never appear at its edges.
  const x = (17.24 + positions[item.column] / 100 * 1930.67) / 1965.14 * 100
  const y = [3.33, 50, 96.67][row]
  const style: CSSProperties = {
    backgroundImage: `url(/images/achievements/setly/${item.sheet}.png)`,
    backgroundPosition: `${x}% ${y}%`,
  }
  return <span className={`${className} achievement-art-sheet`} style={style} aria-hidden="true" />
}
