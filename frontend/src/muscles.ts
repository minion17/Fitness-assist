// Muscle groups of the exercise library (free-exercise-db keys) with Russian names, and their zones on our body map.
import { both, smooth } from './bodyShape'

export type Muscle = 'neck' | 'traps' | 'shoulders' | 'chest' | 'biceps' | 'triceps' | 'forearms' | 'lats' | 'middle back'
  | 'lower back' | 'abdominals' | 'glutes' | 'abductors' | 'adductors' | 'quadriceps' | 'hamstrings' | 'calves'

export const MUSCLES: Record<Muscle, string> = {
  chest: 'Грудь', shoulders: 'Плечи', biceps: 'Бицепс', triceps: 'Трицепс', forearms: 'Предплечья',
  abdominals: 'Пресс', lats: 'Широчайшие', 'middle back': 'Середина спины', 'lower back': 'Поясница', traps: 'Трапеции',
  neck: 'Шея', glutes: 'Ягодицы', quadriceps: 'Квадрицепс', hamstrings: 'Бицепс бедра', adductors: 'Приводящие бедра',
  abductors: 'Отводящие бедра', calves: 'Икры',
}

/** Groups for the filter chips, top to bottom. */
export const MUSCLE_GROUPS: { title: string; muscles: Muscle[] }[] = [
  { title: 'Верх', muscles: ['chest', 'shoulders', 'traps', 'neck'] },
  { title: 'Руки', muscles: ['biceps', 'triceps', 'forearms'] },
  { title: 'Спина', muscles: ['lats', 'middle back', 'lower back'] },
  { title: 'Корпус', muscles: ['abdominals'] },
  { title: 'Ноги', muscles: ['glutes', 'quadriceps', 'hamstrings', 'adductors', 'abductors', 'calves'] },
]

type Pt = [number, number]
const mirror = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [200 - x, y])
/** A zone drawn on both sides of the body (right-side points given). */
const pair = (pts: Pt[]) => [smooth(pts, true), smooth(mirror(pts), true)]
/** A zone across the middle (right half given, from the centre line down). */
const mid = (half: Pt[]) => [smooth(both(half).slice(0, -1), true)]

/** Zones in the 200 x 400 box of bodyShape's figure (a fit male: fat .15, muscle .55). */
export const ZONES: Record<'front' | 'back', Partial<Record<Muscle, string[]>>> = {
  front: {
    neck: mid([[100, 66], [107, 66], [109, 80], [100, 82]]),
    traps: pair([[109, 74], [128, 86], [112, 86]]),
    shoulders: pair([[128, 88], [143, 92], [151, 104], [149, 122], [140, 116], [132, 100]]),
    chest: pair([[102, 92], [128, 92], [138, 104], [134, 126], [116, 134], [102, 128]]),
    biceps: pair([[142, 120], [151, 126], [155, 146], [151, 160], [144, 154], [141, 136]]),
    forearms: pair([[147, 164], [157, 166], [162, 192], [160, 214], [153, 212], [148, 188]]),
    abdominals: mid([[100, 134], [114, 134], [120, 160], [118, 196], [108, 210], [100, 212]]),
    abductors: pair([[124, 200], [133, 206], [134, 228], [128, 238], [124, 220]]),
    adductors: pair([[102, 240], [110, 240], [112, 268], [106, 296], [102, 276]]),
    quadriceps: pair([[112, 238], [128, 240], [134, 262], [130, 300], [120, 314], [112, 300], [111, 268]]),
    calves: pair([[110, 326], [124, 326], [126, 350], [120, 372], [114, 370], [111, 348]]),
  },
  back: {
    neck: mid([[100, 64], [106, 64], [108, 76], [100, 78]]),
    traps: mid([[100, 66], [110, 70], [134, 86], [114, 96], [106, 124], [100, 130]]),
    shoulders: pair([[132, 88], [145, 94], [151, 106], [148, 120], [140, 114], [134, 100]]),
    triceps: pair([[140, 114], [151, 120], [155, 142], [150, 160], [143, 154], [140, 134]]),
    forearms: pair([[147, 164], [157, 166], [162, 192], [160, 214], [153, 212], [148, 188]]),
    'middle back': pair([[104, 100], [113, 98], [116, 116], [108, 132], [103, 124]]),
    lats: pair([[116, 100], [133, 106], [136, 124], [128, 156], [114, 170], [108, 148], [116, 126]]),
    'lower back': mid([[100, 152], [108, 152], [116, 176], [114, 196], [100, 198]]),
    abductors: pair([[118, 190], [132, 196], [134, 210], [124, 206]]),
    glutes: pair([[101, 200], [122, 200], [134, 214], [132, 236], [116, 242], [102, 234]]),
    hamstrings: pair([[104, 248], [130, 246], [134, 270], [128, 302], [116, 310], [106, 286]]),
    calves: pair([[108, 318], [128, 318], [132, 340], [126, 366], [116, 370], [109, 344]]),
  },
}
