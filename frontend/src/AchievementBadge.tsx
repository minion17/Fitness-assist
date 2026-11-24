const frames: Record<string, [number, number]> = {
  workouts_10: [0, 0], level_5: [1, 0], first_workout: [2, 0], future_run: [3, 0],
  first_meal: [0, 1], streak_7: [1, 1], future_sleep: [2, 1], first_water: [3, 1],
  measure_4: [0, 2], streak_30: [1, 2], streak_3: [2, 2], streak_100: [3, 2],
  water_7: [0, 3], glasses_100: [1, 3], norm_7: [2, 3], workouts_50: [3, 3],
}

export default function AchievementBadge({ code, fallback, large = false }: { code: string; fallback: string; large?: boolean }) {
  const name = code === 'iron_will' ? 'workouts_50' : code === 'like_water' ? 'water_7' : code
  const className = `achievement-art${large ? ' achievement-art-large' : ''}`
  return frames[name]
    ? <img className={className} src={`/images/achievements/glass/${name}.png`} alt="" aria-hidden="true" />
    : <span className={`${className} achievement-art-fallback`} aria-hidden="true">{fallback}</span>
}
