const positions: Record<string, string> = {
  workouts_10: '0% 0%', level_5: '25% 0%', first_workout: '50% 0%',
  future_run: '75% 0%', first_meal: '100% 0%', streak_7: '0% 100%',
  future_sleep: '25% 100%', first_water: '50% 100%', measure_4: '75% 100%', streak_30: '100% 100%',
}
export default function AchievementBadge({ code, fallback, large = false }: { code: string; fallback: string; large?: boolean }) {
  return positions[code]
    ? <span className={`achievement-art${large ? ' achievement-art-large' : ''}`} style={{ backgroundPosition: positions[code] }} aria-hidden="true" />
    : <span aria-hidden="true">{fallback}</span>
}
