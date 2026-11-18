// Front-view body geometry for the interactive muscle map.
export type Sex = 'male' | 'female'
type Pt = [number, number]

/** A smooth closed/open path through points (Catmull-Rom turned into cubic Béziers). */
export function smooth(pts: Pt[], closed = false): string {
  const p = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]]
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]]
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  return closed ? `${d} Z` : d
}

/** Mirror the right half (x > 100) into a whole outline: down the right side, back up the left. */
export const both = (right: Pt[]): Pt[] => [...right, ...right.slice().reverse().map(([x, y]): Pt => [200 - x, y])]

export type Figure = { body: string; arms: string[]; legs: string[]; shorts: string; head: { cx: number; cy: number; rx: number; ry: number }; hair: string; lines: string[]; shoes: Pt[] }

/** Geometry in a 200 x 400 box. fat: 0 lean .. 1 obese; muscle: 0 slight .. 1 bodybuilder. */
export function figure(sex: Sex, fat: number, muscle: number): Figure {
  const f = Math.max(0, Math.min(1, fat)), m = Math.max(0, Math.min(1, muscle)), w = sex === 'female'
  const sh = (w ? 31 : 37) + (w ? 5 : 13) * m + 7 * f      // shoulders
  const ch = (w ? 29 : 33) + (w ? 3 : 9) * m + 14 * f      // chest
  const wa = (w ? 21 : 26) - 2 * m + 30 * f                 // waist
  const bl = (w ? 23 : 27) + 34 * f                         // belly / lower waist
  const hp = (w ? 35 : 30) + 2 * m + 22 * f                 // hips
  const nk = (w ? 8 : 10) + 3 * m + 5 * f                   // neck
  const body = smooth(both([
    [100, 76], [100 + nk, 78], [100 + nk + 4, 86], [100 + sh, 96], [100 + sh + 2, 110], [100 + ch, 132],
    [100 + wa, 170], [100 + bl, 198], [100 + hp, 228], [100 + hp - 2, 250], [100, 252],
  ]).slice(0, -1), true)
  const arm = (side: 1 | -1) => {
    const x = (dx: number) => 100 + side * dx
    const ua = (w ? 8 : 10) + (w ? 3 : 9) * m + 7 * f, fa = (w ? 6 : 7.5) + (w ? 2 : 4) * m + 4 * f // half-widths
    const sx = sh - 2 + ua * 0.4, ex = sx + 3 + 3 * f, hx = ex + 1 + 3 * f // shoulder, elbow, wrist centre lines
    return smooth([
      [x(sh - 8), 90], [x(sx + ua), 104], [x(ex + ua * 0.75), 150], [x(ex + fa), 168], [x(hx + fa * 0.7), 208], [x(hx + 4), 232],
      [x(hx - 4), 236], [x(hx - fa * 0.8), 210], [x(ex - fa), 170], [x(ex - ua * 0.7), 150], [x(sx - ua * 0.6), 124],
    ], true)
  }
  const leg = (side: 1 | -1) => {
    const x = (dx: number) => 100 + side * dx
    const tw = (hp - 1) / 2, cx = 1 + tw // thighs fill the hips and meet in the middle
    const kw = 6 + 1.5 * m + 4 * f, cw = 7.5 + 3 * m + 4 * f, aw = 4.2
    return smooth([
      [x(1), 240], [x(cx), 236], [x(cx + tw), 242], [x(cx + tw * 0.9), 280], [x(cx + kw + 1), 318], [x(cx + cw + 1), 345], [x(cx + aw), 378],
      [x(cx), 384], [x(cx - aw), 378], [x(cx - cw * 0.8), 345], [x(cx - kw), 318], [x(cx - tw * 0.85), 284], [x(1), 262],
    ], true)
  }
  const shortsLow = w ? 262 : 270
  const shorts = smooth(both([[100, 214], [100 + bl + 1, 214], [100 + hp + 2, 236], [100 + hp + 3, shortsLow], [100 + 5 + 3 * f, shortsLow + 2], [100, 250]]).slice(0, -1), true)
  const lines: string[] = []
  const def = Math.max(0, m - f * 1.4) // visible muscles: strong and lean
  if (!w && def > 0.25) {
    lines.push(`M${100 - ch + 8},128 Q100,${140 + 4 * m} ${100 + ch - 8},128`) // pecs
    lines.push('M100,140 L100,196')
    for (const y of [158, 172, 186]) lines.push(`M${100 - 11},${y} Q100,${y + 3} ${100 + 11},${y}`) // abs
  }
  if (f > 0.45) {
    lines.push(`M${100 - wa + 6},${178 + 6 * f} Q100,${200 + 22 * f} ${100 + wa - 6},${178 + 6 * f}`) // the belly's lower curve
    lines.push(`M99,${184 + 6 * f} a1.8,1.8 0 1,0 0.1,0`) // navel
  }
  if (!w && f > 0.6) lines.push(`M${100 - ch + 10},${136 + 4 * f} Q${100 - ch / 2},${148 + 6 * f} 98,${138 + 4 * f}`, `M${100 + ch - 10},${136 + 4 * f} Q${100 + ch / 2},${148 + 6 * f} 102,${138 + 4 * f}`)
  if (w) lines.push(`M${100 - ch + 6},118 Q${100 - ch / 2},${134 + 4 * f} 100,124 Q${100 + ch / 2},${134 + 4 * f} ${100 + ch - 6},118`)
  const head = { cx: 100, cy: 48, rx: (w ? 18 : 19) + 3 * f, ry: 24 + 2 * f }
  const hair = w
    ? smooth([[78, 52], [80, 26], [100, 18], [120, 26], [123, 52], [126, 92], [116, 78], [118, 44], [100, 32], [83, 44], [84, 78], [74, 92]], true)
    : smooth([[80, 46], [82, 28], [100, 20], [119, 28], [121, 46], [116, 34], [100, 30], [85, 34]], true)
  const legOut = (side: 1 | -1) => 100 + side * (1 + (hp - 1) / 2) // the ankle's middle
  return { body, arms: [arm(-1), arm(1)], legs: [leg(-1), leg(1)], shorts, head, hair, lines, shoes: [[legOut(-1), 386], [legOut(1), 386]] }
}

export const NOW_LEVELS = 8

// The fourth reference has the strongest muscle definition in both series.
const targetAvatars = [2, 3, 5, 6, 4]
export const TARGET_LEVELS = targetAvatars.length
export const targetAvatar = (level: number) => targetAvatars[level - 1] ?? targetAvatars[1]

export const bodyAvatarSource = (sex: Sex, level: number) => `/images/body-avatars/${sex}-${level}.webp`
