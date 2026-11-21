const frames: Record<string, [number, number]> = {
  workouts_10: [53, 78], level_5: [393, 78], first_workout: [733, 78],
  future_run: [1073, 78], first_meal: [1410, 78], streak_7: [53, 459],
  future_sleep: [393, 459], first_water: [733, 459], measure_4: [1073, 459], streak_30: [1410, 459],
}

const additionalFrames: Record<string, [number, number]> = {
  streak_3: [65, 32], streak_100: [552, 32], water_7: [1039, 32],
  glasses_100: [65, 516], norm_7: [552, 516], workouts_50: [1039, 516],
}

export default function AchievementBadge({ code, fallback, large = false }: { code: string; fallback: string; large?: boolean }) {
  const additional = additionalFrames[code === 'iron_will' ? 'workouts_50' : code === 'like_water' ? 'water_7' : code]
  const frame = frames[code]
  const className = `achievement-art${large ? ' achievement-art-large' : ''}`
  if (additional) {
    return <span className={`${className} achievement-art-additional`}
      style={{ backgroundPosition: `${additional[0] / (1536 - 432) * 100}% ${additional[1] / (1024 - 480) * 100}%` }}
      aria-hidden="true" />
  }
  return frame
    ? <span className={className} style={{ backgroundPosition: `${frame[0] / (1774 - 320) * 100}% ${frame[1] / (887 - 356) * 100}%` }} aria-hidden="true" />
    : <span className={`${className} achievement-art-fallback`} aria-hidden="true">{fallback}</span>
}
