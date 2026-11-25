import type { CSSProperties } from 'react'

type Artwork = { sheet: 'core' | 'additional'; column: number; row?: number }

const individualArtwork: Record<string, string> = {
  first_workout: 'first-workout.png',
  workouts_10: 'ten-workouts.png',
  workouts_50: 'fifty-workouts.png',
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
  if (individualArtwork[code]) return <span className={`${className} achievement-art-individual`} style={{ backgroundImage: `url(/images/achievements/setly/${individualArtwork[code]})` }} aria-hidden="true" />
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
