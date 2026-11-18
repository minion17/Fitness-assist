/// <reference types="node" />
import { existsSync } from 'node:fs'
import { expect, test } from 'vitest'
import exerciseCatalog from '../../content/exercises/exercises.json'
import translatedCatalog from '../../content/exercises/translated_exercises.json'
import { getExerciseGuideImage, hasExerciseGuide } from './KettlebellExercise'

// shortcut: Sasha's kettlebell photos are still only on his computer; drop this list once they are pushed
const PENDING = new Set(['Махи гирей двумя руками', 'Швунг гири одной рукой', 'Толчок гири одной рукой', 'Махи гирей со сменой рук',
  'Передача гири вокруг корпуса', 'Жим гири лёжа на полу одной рукой', 'Жим гири стоя одной рукой', 'Приседание с гирей у плеча',
  'Становая тяга с гирей сумо', 'Румынская тяга с гирей двумя руками', 'Фермерская прогулка с одной гирей', 'Прогулка с гирей у плеча',
  'Удержание гири одной рукой у бедра', 'Марш с гирей у груди', 'Тяга гири к поясу двумя руками в наклоне', 'Тяга гири в стойке чемодан',
  'Выпад назад с гирей у груди'])

test('каждое упражнение из обоих каталогов имеет локальную иллюстрацию и карточку техники', () => {
  const missing = [...exerciseCatalog, ...translatedCatalog].filter(({ name }) => {
    const src = getExerciseGuideImage(name)
    return !PENDING.has(name) && (!hasExerciseGuide(name) || !src || (!src.startsWith('/api/') && !existsSync(`public${src}`)))
  }).map(({ name }) => name)
  expect(missing).toEqual([])
  expect(getExerciseGuideImage('Своё упражнение без иллюстрации')).toBeNull()
})

test('thumbnail paths preserve explicit image formats', () => {
  expect(getExerciseGuideImage('Румынская тяга')).toBe('/images/workout-guide/barbell_rdl.jpg')
  expect(getExerciseGuideImage('Жим штанги лежа')).toBe('/images/workout-guide/barbell_bench.webp')
  expect(getExerciseGuideImage('Махи гирей двумя руками')).toBe('/images/workout-guide/kb_twohand_swing.png')
})
