const singleArtwork = new Set([
  'first_water', 'first_meal', 'first_workout', 'streak_3', 'streak_7',
  'streak_30', 'streak_100', 'water_7', 'glasses_100', 'norm_7',
  'workouts_10', 'workouts_50', 'measure_4', 'level_5',
])
const progressiveArtwork = new Set(['iron_will', 'personal_best', 'food_habits', 'like_water'])
const artworkScale: Record<string, string> = {
  first_meal: '140%', first_water: '112%', first_workout: '97%',
  streak_3: '123%', streak_7: '125%', streak_30: '145%', streak_100: '119%',
  water_7: '101%', glasses_100: '128%', norm_7: '102%',
  workouts_10: '101%', workouts_50: '144%', measure_4: '128%', level_5: '127%',
  iron_will: '122%', personal_best: '133%', food_habits: '140%', like_water: '109%',
}

export default function AchievementBadge({ code, fallback, large = false }: {
  code: string; fallback: string; large?: boolean
}) {
  const className = `achievement-art${large ? ' achievement-art-large' : ''}`
  if (singleArtwork.has(code) || progressiveArtwork.has(code)) {
    const filename = progressiveArtwork.has(code) ? `${code}_1` : code
    return <span className={`${className} achievement-art-independent`} style={{ backgroundImage: `url(/images/achievements/individual/${filename}.png?v=3)`, backgroundSize: artworkScale[code] ?? 'contain' }} aria-hidden="true" />
  }
  if (code === 'future_run' || code === 'future_sleep') {
    return <img className={className} src={`/images/achievements/glass/${code}.png`} alt="" aria-hidden="true" />
  }
  return <span className={`${className} achievement-art-fallback`} aria-hidden="true">{fallback}</span>
}
