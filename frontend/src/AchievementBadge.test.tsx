import { render } from '@testing-library/react'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import AchievementBadge from './AchievementBadge'

const single = ['first_water', 'first_meal', 'first_workout', 'streak_3', 'streak_7', 'streak_30', 'streak_100', 'water_7', 'glasses_100', 'norm_7', 'workouts_10', 'workouts_50', 'measure_4', 'level_5']
const progressive = ['iron_will', 'personal_best', 'food_habits', 'like_water']

describe('achievement artwork', () => {
  it('uses distinct individual images for all achievements and includes each asset', () => {
    const urls = [...single, ...progressive].map(code => {
      const name = progressive.includes(code) ? `${code}_1` : code
      const { container, unmount } = render(<AchievementBadge code={code} fallback="?" />)
      const element = container.querySelector('.achievement-art-independent') as HTMLElement
      expect(element.style.backgroundImage).toContain(`/individual/${name}.png`)
      expect(existsSync(resolve('public/images/achievements/individual', `${name}.png`)), name).toBe(true)
      const url = element.style.backgroundImage
      unmount()
      return url
    })
    expect(new Set(urls).size).toBe(18)
  })
})
