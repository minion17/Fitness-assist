import { expect, test } from 'vitest'
import exerciseCatalog from '../../content/exercises/exercises.json'
import { getExerciseGuideImage } from './KettlebellExercise'

test('every catalogue exercise has a thumbnail path for its workout row', () => {
  const missing = exerciseCatalog.filter(exercise => !getExerciseGuideImage(exercise.name)).map(exercise => exercise.name)
  expect(missing).toEqual([])
})

test('thumbnail paths preserve explicit image formats', () => {
  expect(getExerciseGuideImage('Румынская тяга')).toBe('/images/workout-guide/barbell_rdl.jpg')
  expect(getExerciseGuideImage('Жим штанги лежа')).toBe('/images/workout-guide/barbell_bench.png')
})
