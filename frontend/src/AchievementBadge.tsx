const frames: Record<string, [number, number]> = {
  workouts_10: [53, 78], level_5: [393, 78], first_workout: [733, 78],
  future_run: [1073, 78], first_meal: [1410, 78], streak_7: [53, 459],
  future_sleep: [393, 459], first_water: [733, 459], measure_4: [1073, 459], streak_30: [1410, 459],
}

export default function AchievementBadge({ code, fallback, large = false }: { code: string; fallback: string; large?: boolean }) {
  const frame = frames[code]
  const className = `achievement-art${large ? ' achievement-art-large' : ''}`
  return frame
    ? <span className={className} style={{ backgroundPosition: `${frame[0] / (1774 - 320) * 100}% ${frame[1] / (887 - 356) * 100}%` }} aria-hidden="true" />
    : <span className={`${className} achievement-art-fallback`} aria-hidden="true">{fallback}</span>
}
