/// <reference types="node" />
import { existsSync } from 'node:fs'
import { expect, test } from 'vitest'
import exerciseCatalog from '../../content/exercises/exercises.json'
import translatedCatalog from '../../content/exercises/translated_exercises.json'
import { getExerciseGuideImage, hasExerciseGuide } from './KettlebellExercise'

test('каждое упражнение из обоих каталогов имеет локальную иллюстрацию и карточку техники', () => {
  const missing = [...exerciseCatalog, ...translatedCatalog].filter(({ name }) => {
    const src = getExerciseGuideImage(name)
    return !hasExerciseGuide(name) || !src || !existsSync(`public${src}`)
  }).map(({ name }) => name)
  expect(missing).toEqual([])
  expect(getExerciseGuideImage('Своё упражнение без иллюстрации')).toBeNull()
})

test('thumbnail paths preserve explicit image formats', () => {
  expect(getExerciseGuideImage('Румынская тяга')).toBe('/images/workout-guide/barbell_rdl.jpg')
  expect(getExerciseGuideImage('Жим штанги лежа')).toBe('/images/workout-guide/barbell_bench.png')
  expect(getExerciseGuideImage('Махи гирей двумя руками')).toBe('/images/workout-guide/kb_twohand_swing.png')
})
