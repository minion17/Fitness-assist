import { render } from '@testing-library/react'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import AchievementBadge from './AchievementBadge'

const single = ['first_water', 'first_meal', 'first_workout', 'streak_3', 'streak_7', 'streak_30', 'streak_100', 'water_7', 'glasses_100', 'norm_7', 'workouts_10', 'workouts_50', 'measure_4', 'level_5']
const progressive = ['iron_will', 'personal_best', 'food_habits', 'like_water']

describe('achievement artwork', () => {
  it('uses a separate image for every standard achievement', () => {
    const urls = single.map(code => {
      const { container, unmount } = render(<AchievementBadge code={code} fallback="?" />)
      const element = container.querySelector('.achievement-art-independent') as HTMLElement
      expect(element.style.backgroundImage).toContain(`/individual/${code}.png`)
      const url = element.style.backgroundImage
      unmount()
      return url
    })
    expect(new Set(urls).size).toBe(single.length)
  })

  it('renders every progressive achievement at each tier', () => {
    for (const code of progressive) for (let stage = 1; stage <= 5; stage++) {
      const { container, unmount } = render(<AchievementBadge code={code} stage={stage} fallback="?" />)
      expect((container.firstChild as HTMLElement).style.backgroundImage).toContain(stage === 1 ? `/individual/${code}_1.png` : '/setly/')
      unmount()
    }
  })

  it('includes every referenced image in the public assets', () => {
    const filenames = [...single, ...progressive.map(code => `${code}_1`)]
    for (const name of filenames) expect(existsSync(resolve('public/images/achievements/individual', `${name}.png`)), name).toBe(true)
  })
})
