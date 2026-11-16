import { expect, test } from 'vitest'
import exerciseCatalog from '../../content/exercises/exercises.json'
import { getExerciseGuideImage } from './KettlebellExercise'

test('every catalogue exercise has a thumbnail path for its workout row', () => {
  const missing = exerciseCatalog.filter(exercise => !getExerciseGuideImage(exercise.name)).map(exercise => exercise.name)
  expect(missing).toEqual([])
})

test('thumbnail paths preserve explicit image formats', () => {
  expect(getExerciseGuideImage('Румынская тяга')).toBe('/images/workout-guide/barbell_rdl.jpg')
  expect(getExerciseGuideImage('Жим штанги лежа')).toBe('/images/workout-guide/barbell_bench.webp')
})

test('every guide image exists in public/', () => {
  const files = new Set(Object.keys(import.meta.glob('../public/images/workout-guide/*')).map(f => f.replace('../public', '')))
  const missing = exerciseCatalog.map(e => getExerciseGuideImage(e.name)).filter((p): p is string => !!p && !files.has(p))
  expect(files.size).toBeGreaterThan(40)
  expect([...new Set(missing)]).toEqual([])
})
