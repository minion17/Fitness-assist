import { useEffect, useRef, useState } from 'react'
import './MealDay.css'
import type { PlannedExercise } from './types'
import translatedCatalog from '../../content/exercises/translated_exercises.json'
import exerciseCatalog from '../../content/exercises/exercises.json'
import { useBack } from './back'

type Guide = { image?: string; startImage?: string; endImage?: string; endLabel?: string; muscles: string; steps: string }
const GUIDE: Record<string, Guide> = {
  'Жим штанги лежа': { image: 'barbell_bench', endImage: 'barbell_bench_position2.webp', endLabel: 'Нижнее положение', muscles: 'Грудь, трицепсы, плечи', steps: 'Лягте на устойчивую скамью, уприте стопы в пол. Контролируемо опустите штангу к груди и выжмите вверх.' },
  'Приседания со штангой': { image: 'barbell_squat', startImage: 'barbell_squat_position2.webp', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Расположите гриф на верхней части спины. Присядьте в комфортную глубину и выпрямитесь, сохраняя устойчивость.' },
  'Становая тяга': { image: 'barbell_deadlift', endImage: 'barbell_deadlift_position2.webp', muscles: 'Ягодицы, задняя поверхность бедра, спина', steps: 'Подойдите к грифу, отведите таз назад, возьмитесь за штангу и поднимитесь, сохраняя её близко к ногам.' },
  'Становая тяга сумо': { image: 'sumo_deadlift', endImage: 'sumo_deadlift_position2.png', muscles: 'Ягодицы, бёдра, мышцы спины', steps: 'Поставьте ноги широко, разверните носки и возьмитесь за гриф между ног. Поднимитесь, удерживая спину нейтральной.' },
  'Становая тяга с трэп-грифом': { image: 'trapbar_deadlift', endImage: 'trapbar_deadlift_position2.png', muscles: 'Квадрицепсы, ягодицы, задняя поверхность бедра', steps: 'Встаньте внутрь трэп-грифа, возьмитесь за рукояти и встаньте, удерживая корпус собранным.' },
  'Жим штанги на наклонной скамье': { image: 'incline_barbell_press', startImage: 'incline_barbell_press_position2.png', endLabel: 'Нижнее положение', muscles: 'Верх груди, плечи, трицепсы', steps: 'Лягте на наклонную скамью, опустите штангу к верхней части груди и выжмите вверх.' },
  'Жим штанги узким хватом': { image: 'closegrip_bench', endImage: 'closegrip_bench_position2.png', endLabel: 'Нижнее положение', muscles: 'Трицепсы, грудь, плечи', steps: 'Лёжа на скамье возьмитесь за гриф примерно на ширине плеч. Опустите к груди и выжмите вверх.' },
  'Фронтальные приседания со штангой': { image: 'front_squat', startImage: 'front_squat_position2.png', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Удерживая гриф перед плечами, присядьте с ровным корпусом и поднимитесь, толкаясь стопами.' },
  'Выпады со штангой': { image: 'barbell_lunge', startImage: 'barbell_lunge_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'Стабильно установите гриф на верхней части спины. Сделайте шаг, опуститесь в выпад и вернитесь.' },
  'Шраги со штангой': { image: 'barbell_shrug', startImage: 'barbell_shrug_position2.webp', muscles: 'Трапециевидные мышцы', steps: 'Держа штангу перед собой, поднимите плечи вверх без кругового движения. Плавно опустите.' },
  'Наклоны в сторону со штангой': { image: 'barbell_side_bend', startImage: 'barbell_side_bend_position2.webp', muscles: 'Боковые мышцы корпуса, разгибатели спины', steps: 'Удерживая гриф устойчиво, наклонитесь в сторону в комфортной амплитуде и вернитесь в центр.' },
  'Зашагивания на платформу со штангой': { image: 'barbell_stepup', startImage: 'barbell_stepup_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'Поставьте всю стопу на платформу и поднимитесь, опираясь на переднюю ногу. Спуститесь подконтрольно.' },
  'Подтягивания широким хватом': { image: 'pullup_wide', startImage: 'pullup_wide_position2.png', muscles: 'Широчайшие мышцы спины, бицепсы', steps: 'Возьмитесь за перекладину шире плеч. Подтянитесь без рывка и плавно опуститесь.' },
  'Подтягивания прямым хватом': { image: 'pullup', startImage: 'pullup_position2.png', muscles: 'Широчайшие мышцы спины, бицепсы', steps: 'Возьмитесь за перекладину, подтянитесь без рывков и подконтрольно опуститесь.' },
  'Тяга штанги в наклоне': { image: 'barbell_row', startImage: 'barbell_row_position2.webp', muscles: 'Мышцы спины, бицепсы', steps: 'Наклонитесь с нейтральной спиной, подтяните штангу к корпусу и плавно опустите.' },
  'Армейский жим': { image: 'military_press', startImage: 'military_press_start.png', muscles: 'Дельты, трицепсы', steps: 'Установите штангу у верхней части груди. Выжмите её вверх над головой и опустите подконтрольно.' },
  'Выпады с гантелями': { image: 'dumbbell_lunge', startImage: 'dumbbell_lunge_position2.png', muscles: 'Квадрицепсы, ягодицы', steps: 'С гантелями по бокам сделайте шаг вперёд и опуститесь до комфортной глубины. Оттолкнитесь передней ногой и вернитесь.' },
  'Румынская тяга': { image: 'barbell_rdl.jpg', muscles: 'Задняя поверхность бедра, ягодицы, спина', steps: 'Слегка согните колени и отведите таз назад, ведя штангу вдоль ног. Выпрямитесь за счёт движения таза.' },
  'Отжимания от пола': { image: 'pushup_floor', startImage: 'pushup_floor_position2.png', muscles: 'Грудь, трицепсы, плечи', steps: 'Упритесь ладонями в пол, удерживайте корпус ровным. Согните руки и вернитесь в исходное положение.' },
  'Жим ногами в тренажёре': { image: 'legpress', startImage: 'legpress_position2.png', muscles: 'Квадрицепсы, ягодицы', steps: 'Устройтесь на тренажёре, поставьте стопы на платформу. Контролируемо согните и выпрямите ноги.' },
  'Разгибание ног в тренажёре': { image: 'leg_extension', startImage: 'leg_extension_position2.png', muscles: 'Квадрицепсы', steps: 'Сядьте так, чтобы ось тренажёра совпадала с коленями. Разогните ноги без рывка и плавно вернитесь.' },
  'Сгибание ног в тренажёре': { image: 'leg_curl', startImage: 'leg_curl_position2.png', muscles: 'Задняя поверхность бедра', steps: 'Зафиксируйте корпус на тренажёре. Согните ноги, подтягивая валик к бёдрам, затем медленно разогните.' },
  'Махи гантелями в стороны': { image: 'lateral_raise', startImage: 'lateral_raise_position2.png', muscles: 'Средняя часть дельтовидных мышц', steps: 'Поднимите гантели в стороны до уровня плеч, сохраняя мягкий сгиб локтей. Опустите плавно.' },
  'Подъём штанги на бицепс': { image: 'barbell_curl', startImage: 'barbell_curl_position2.webp', muscles: 'Бицепсы', steps: 'Держа локти у корпуса, согните руки и поднимите штангу. Опустите её контролируемо.' },
  'Французский жим': { image: 'french_press', startImage: 'french_press_position2.png', muscles: 'Трицепсы', steps: 'Лёжа на скамье, согните руки и опустите гриф за линию лба. Разогните локти, удерживая плечи стабильными.' },
  'Разгибание рук на блоке': { image: 'cable_pushdown', startImage: 'cable_pushdown_position2.webp', muscles: 'Трицепсы', steps: 'Прижмите локти к корпусу. Разогните руки вниз и вернитесь в исходное положение без раскачивания.' },
  'Отжимания на брусьях': { image: 'parallel_dip', startImage: 'parallel_dip_position2.png', muscles: 'Трицепсы, грудь, передняя часть плеч', steps: 'На брусьях согните руки и опуститесь в комфортную глубину. Выжмите себя вверх без раскачивания.' },
  'Тяга гантели в наклоне': { image: 'dumbbell_row', startImage: 'dumbbell_row_position2.png', muscles: 'Широчайшие и ромбовидные мышцы спины', steps: 'С опорой рукой на скамью подтяните гантель к тазу, не разворачивая корпус. Плавно опустите.' },
  'Тяга верхнего блока к груди': { image: 'lat_pulldown', startImage: 'lat_pulldown_position2.png', muscles: 'Широчайшие мышцы спины, бицепсы', steps: 'Сядьте под упоры и потяните перекладину к верхней части груди. Контролируемо верните её вверх.' },
  'Молотки с гантелями': { image: 'hammer_curl', muscles: 'Бицепсы, плечевая мышца', steps: 'Держите гантели нейтральным хватом. Согните руки, не уводя локти вперёд, и плавно опустите.' },
  'Жим гантелей сидя': { image: 'seated_db_press', startImage: 'seated_db_press_position2.png', muscles: 'Дельтовидные мышцы, трицепсы', steps: 'Сидя с опорой спины, выжмите гантели вверх. Опустите до комфортного уровня плеч.' },
  'Гиперэкстензия': { image: 'back_extension', startImage: 'back_extension_position2.webp', muscles: 'Разгибатели спины, ягодицы', steps: 'На римском стуле опустите корпус и поднимитесь до прямой линии тела, не переразгибая поясницу.' },
  'Ягодичный мост со штангой': { image: 'glute_bridge_barbell', startImage: 'glute_bridge_barbell_position2.png', muscles: 'Ягодицы, задняя поверхность бедра', steps: 'Верх спины опирается на скамью, штанга лежит на тазе. Поднимите таз до прямой линии корпуса и опустите.' },
  'Скручивания на полу': { image: 'crunch.jpg', muscles: 'Прямая мышца живота', steps: 'Лёжа на спине с согнутыми коленями, слегка приподнимите плечи за счёт мышц живота и плавно опуститесь.' },
  'Подъём ног в висе': { image: 'hanging_leg_raise.jpg', muscles: 'Мышцы живота и сгибатели бедра', steps: 'Повисните на перекладине без раскачивания. Поднимите согнутые или прямые ноги перед собой и опустите подконтрольно.' },
  'Болгарские сплит-приседания': { image: 'bulgarian_split_squat.jpg', startImage: 'bulgarian_split_squat_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'Поставьте заднюю стопу на невысокую опору. Опуститесь на передней ноге и вернитесь, удерживая корпус устойчиво.' },
  'Берпи': { image: 'burpee.jpg', muscles: 'Всё тело, мышцы корпуса', steps: 'Присядьте и поставьте ладони на пол, перейдите в упор лёжа, верните ноги к рукам и встаньте.' },
  'Скакалка': { image: 'jump_rope.jpg', muscles: 'Икроножные мышцы, плечи, мышцы корпуса', steps: 'Прыгайте невысоко, вращая скакалку кистями. Приземляйтесь мягко на переднюю часть стоп.' },
  'Жим штанги на скамье с обратным наклоном': { image: 'decline_bench.jpg', muscles: 'Нижняя часть груди, трицепсы, плечи', steps: 'Лягте на скамью с наклоном вниз и зафиксируйте ноги. Опустите гриф к нижней части груди и выжмите вверх.' },
  'Приседания с собственным весом': { image: 'bodyweight_squat.jpg', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Поставьте стопы примерно на ширине плеч. Отведите таз назад, присядьте в комфортную глубину и встаньте.' },
  'Выпады шагом с собственным весом': { image: 'bodyweight_lunge.jpg', startImage: 'bodyweight_lunge_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'Сделайте шаг вперёд, опуститесь до комфортной глубины и оттолкнитесь передней ногой. Чередуйте стороны.' },
  'Обратные отжимания от скамьи': { image: 'bench_dip.jpg', muscles: 'Трицепсы, грудь, передняя часть плеч', steps: 'Упритесь ладонями в край устойчивой скамьи и согните руки, опуская корпус. Выпрямите руки и вернитесь вверх.' },
  'Отжимания от пола широким хватом': { image: 'wide_pushup.jpg', muscles: 'Грудь, трицепсы, плечи', steps: 'Поставьте ладони шире плеч и удерживайте корпус ровным. Опуститесь к полу и оттолкнитесь ладонями.' },
  'Отжимания от пола узким хватом': { image: 'close_pushup.jpg', muscles: 'Трицепсы, грудь, мышцы корпуса', steps: 'Поставьте ладони близко друг к другу под грудью. Согните руки, удерживая локти ближе к корпусу, и выпрямите их.' },
  'Отжимания с ногами на возвышении': { image: 'feet_elevated_pushup.jpg', muscles: 'Грудь, трицепсы, плечи, мышцы корпуса', steps: 'Поставьте стопы на устойчивую невысокую опору. Удерживая корпус ровным, опуститесь к полу и оттолкнитесь.' },
  'Подтягивания лопатками': { image: 'scapular_pullup.jpg', muscles: 'Широчайшие мышцы спины, мышцы плечевого пояса', steps: 'Повисните на прямых руках. Не сгибая локти, опустите лопатки и слегка поднимите корпус, затем расслабьтесь.' },
  'Подтягивания с резиновой петлёй': { image: 'band_pullup.jpg', muscles: 'Широчайшие мышцы спины, бицепсы', steps: 'Надёжно закрепите резиновую петлю на перекладине и поставьте в неё колено или стопу. Подтянитесь без рывка и опуститесь.' },
  'Жим гантелей лёжа': { image: 'db_bench.jpg', endImage: 'db_bench_position2.png', endLabel: 'Нижнее положение', muscles: 'Грудь, трицепсы, плечи', steps: 'Лягте на скамью, удерживайте гантели над грудью. Опустите их по сторонам от корпуса и выжмите вверх.' },
  'Жим гантелей лёжа нейтральным хватом': { image: 'db_bench_neutral.jpg', endImage: 'db_bench_neutral_position2.png', endLabel: 'Нижнее положение', muscles: 'Грудь, трицепсы, плечи', steps: 'Лягте на скамью, поверните ладони друг к другу. Опустите гантели к груди и выжмите вверх, сохраняя нейтральный хват.' },
  'Приседания с гантелями': { image: 'db_squat.jpg', startImage: 'db_squat_position2.png', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Держите гантели по бокам. Присядьте, сохраняя устойчивость стоп и нейтральное положение спины, затем встаньте.' },
  'Сплит-приседания с гантелями': { image: 'db_split_squat.jpg', startImage: 'db_split_squat_position2.png', muscles: 'Квадрицепсы, ягодицы', steps: 'Поставьте одну ногу впереди другой и держите гантели по бокам. Опуститесь вниз и вернитесь, затем смените сторону.' },
  'Тяга штанги на прямых ногах': { image: 'barbell_rdl.jpg', muscles: 'Задняя поверхность бедра, ягодицы, спина', steps: 'Слегка согните колени, отведите таз назад и ведите штангу вдоль ног. Вернитесь за счёт разгибания таза.' },
  'Отжимание с переходом в боковую планку': { image: 'pushup_side_plank.jpg', muscles: 'Грудь, плечи, трицепсы, мышцы корпуса', steps: 'Выполните отжимание, затем поверните корпус в боковую планку, подняв верхнюю руку. Вернитесь и чередуйте стороны.' },
  'Тяга гантелей на прямых ногах': { image: 'db_rdl.jpg', muscles: 'Задняя поверхность бедра, ягодицы, спина', steps: 'Держите гантели близко к ногам, слегка согните колени и отведите таз назад. Выпрямитесь, возвращая таз вперёд.' },
  'Сгибание рук с гантелями на наклонной скамье': { image: 'incline_db_curl.jpg', muscles: 'Бицепсы', steps: 'Сядьте на наклонную скамью, опустив руки с гантелями. Согните локти, затем медленно выпрямите руки.' },
  'Сгибание рук с гантелями сидя': { image: 'seated_db_curl.jpg', muscles: 'Бицепсы', steps: 'Сядьте устойчиво, держите локти у корпуса. Согните руки с гантелями и плавно опустите их.' },
  'Махи гирей двумя руками': { image: 'kb_twohand_swing.png', muscles: 'Ягодицы, задняя поверхность бедра, мышцы корпуса', steps: 'Отведите таз назад и ведите гирю между бёдрами. Разогните таз и поднимите гирю движением бёдер; руки только направляют снаряд. Плавно вернитесь в наклон.' },
  'Попеременный жим гирь': { image: 'kb_alternating_press.jpg', muscles: 'Дельтовидные мышцы, трицепсы, мышцы корпуса', steps: 'Удерживайте гири у плеч. Поочерёдно выжимайте одну гирю вверх, оставляя вторую у плеча; контролируйте корпус.' },
  'Попеременная тяга гирь в наклоне': { image: 'kb_alternating_row.jpg', muscles: 'Мышцы спины, бицепсы', steps: 'Наклонитесь с ровной спиной и держите гири под плечами. Поочерёдно подтягивайте их к корпусу.' },
  'Махи гирей одной рукой': { image: 'kb_onearm_swing.jpg', muscles: 'Ягодицы, задняя поверхность бедра, мышцы корпуса', steps: 'Раскачайте гирю движением таза, а не подъёмом рукой. Держите спину нейтральной и чередуйте руки после подхода.' },
  'Вращение гири вокруг головы': { image: 'kb_halo.jpg', muscles: 'Плечевой пояс, мышцы корпуса', steps: 'Удерживая гирю двумя руками, плавно проведите её вокруг головы. Держите корпус неподвижно и меняйте направление.' },
  'Тяга гири на одной ноге': { image: 'kb_singleleg_deadlift.jpg', muscles: 'Ягодицы, задняя поверхность бедра, мышцы корпуса', steps: 'Перенесите вес на одну ногу, слегка согните колено и отведите свободную ногу назад. Наклонитесь с гирей и вернитесь.' },
  'Разгибание рук с гирей из-за головы': { image: 'kb_overhead_triceps.jpg', muscles: 'Трицепсы', steps: 'Удерживайте гирю двумя руками над головой. Согните локти, опустив её за голову, затем выпрямите руки.' },
  'Трастер с гирей': { image: 'kb_thruster.jpg', muscles: 'Ноги, ягодицы, плечи, трицепсы', steps: 'Удерживайте гирю у груди, выполните присед и при подъёме выжмите её вверх. Опустите к груди и повторите.' },
  'Тяга двух гирь в наклоне': { image: 'kb_double_row.jpg', muscles: 'Широчайшие мышцы спины, ромбовидные мышцы, бицепсы', steps: 'Наклонитесь с ровной спиной, удерживая гири под плечами. Подтяните обе гири к корпусу и медленно опустите.' },
  'Турецкий подъём с гирей через выпад': { image: 'turkish_getup.jpg', muscles: 'Плечо, мышцы корпуса, ягодицы и ноги', steps: 'Удерживайте гирю над плечом и поднимайтесь поэтапно через опору на локоть и ладонь к положению выпада. Затем вернитесь тем же путём.' },
  'Фронтальные приседания с двумя гирями': { image: 'kb_double_front_squat.jpg', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Удерживайте две гири у плеч. Присядьте, сохраняя корпус устойчивым, и вернитесь в исходное положение.' },
  'Австралийские подтягивания': { image: 'australian_pullup.jpg', muscles: 'Мышцы спины, бицепсы, задняя часть плеч', steps: 'Возьмитесь за низкую перекладину, вытяните тело в прямую линию и подтяните грудь к перекладине. Плавно опуститесь.' },
  'Супермен': { image: 'superman.jpg', muscles: 'Разгибатели спины, ягодицы, задняя часть плеч', steps: 'Лёжа на животе, слегка приподнимите руки, грудь и ноги. Задержитесь на короткое время и мягко опуститесь.' },

  'Гоблет-приседания': { image: 'squat', startImage: 'squat_position2.png', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Держите гирю у груди. Присядьте в комфортную глубину и поднимитесь, сохраняя устойчивое положение стоп.' },
  'Тяга гири с пола': { image: 'deadlift-male', endImage: 'deadlift-male_position2.png', muscles: 'Ягодицы, задняя поверхность бедра, мышцы спины', steps: 'Отведите таз назад, возьмите гирю с пола двумя руками и выпрямитесь. Опустите гирю, контролируя положение спины.' },
  'Тяга гири одной рукой в наклоне': { image: 'row-male', startImage: 'row-male_position2.png', muscles: 'Мышцы спины, бицепс', steps: 'Наклонитесь с опорой свободной рукой. Подтяните гирю к корпусу и плавно опустите. Выполните на обе стороны.' },
  'Отжимания руками от опоры': { image: 'pushup', startImage: 'pushup_position2.png', muscles: 'Грудь, трицепсы, передняя поверхность плеч', steps: 'Поставьте руки на устойчивую опору. Согните руки, удерживая корпус ровным, затем выпрямите.' },
  'Мёртвый жук': { image: 'deadbug', startImage: 'deadbug_position2.png', muscles: 'Мышцы живота и корпуса', steps: 'Лёжа на спине, медленно выпрямляйте противоположные руку и ногу. Вернитесь и смените сторону.' },
  'Выпады с гирей': { image: 'lunge', startImage: 'lunge_position2.png', muscles: 'Квадрицепсы, ягодицы', steps: 'Держите гирю у груди. Шагните и опуститесь в выпад, затем вернитесь. Выполните на обе ноги.' },
  'Ягодичный мост': { image: 'glute-male', startImage: 'glute-male_position2.png', muscles: 'Ягодицы, задняя поверхность бедра', steps: 'Лёжа на спине с согнутыми коленями, поднимите таз и плавно опустите.' },
  'Жим гири сидя': { image: 'kb_seated_press.jpg', muscles: 'Плечи, трицепсы', steps: 'Сядьте устойчиво, удерживая гирю у плеча. Выжмите её над головой и подконтрольно опустите. Выполните на обе стороны.' },
  'Планка': { image: 'plank', muscles: 'Мышцы живота и корпуса', steps: 'Опираясь на предплечья и носки, удерживайте тело ровно и дышите спокойно.' },
}

const KETTLEBELL_IMAGES: Record<string, string> = {
  "Передача гири вокруг корпуса": "kb_passaround.png",
  "Махи гирей со сменой рук": "kb_handoff.jpg",
  "Толчок гири одной рукой": "kb_jerk_v2.png",
  "Швунг гири одной рукой": "kb_pushpress.png",
  "Фермерская прогулка с одной гирей": "kb_suitcase_carry.png",
  "Жим гири лёжа на полу одной рукой": "kb_floor_press.png",
  "Жим гири стоя одной рукой": "kb_standing_press.png",
  "Приседание с гирей у плеча": "kb_rack_squat.png",
  "Становая тяга с гирей сумо": "kb_sumo_deadlift.png",
  "Румынская тяга с гирей двумя руками": "kb_romanian_deadlift.png",
  "Прогулка с гирей у плеча": "kb_rack_carry.png",
  "Удержание гири одной рукой у бедра": "kb_suitcase_hold.png",
  "Марш с гирей у груди": "kb_goblet_march.png",
  "Тяга гири к поясу двумя руками в наклоне": "kb_twohand_row.png",
  "Тяга гири в стойке чемодан": "kb_suitcase_deadlift.png",
  "Выпад назад с гирей у груди": "kb_reverse_lunge.png",
}

const catalogGuides = new Map<string, Guide>()
// library photos come through the server's cached proxy instead of 183 MB of files in the repo
const catalogFrames = (id: string) => ({ image: `/api/exercise-image/${id}/0.webp`, endImage: `/api/exercise-image/${id}/1.webp` })
const guideSrc = (file: string) => file.startsWith('/') ? file : `/images/workout-guide/${file}`
for (const exercise of translatedCatalog) {
  const frames = exercise.source_id === 'Kettlebell_Halo_With_Overhead_Extension'
    ? { image: 'kb_halo.jpg', endImage: 'kb_overhead_triceps.jpg', endLabel: 'Разгибание рук' }
    : catalogFrames(exercise.source_id)
  catalogGuides.set(exercise.name, { ...frames, muscles: exercise.muscle_groups.join(', '), steps: exercise.description ?? '' })
}

const kettlebellFrames: Record<string, string> = {
  'Взятие гири на грудь одной рукой': 'Kettlebell_Hang_Clean',
  'Рывок гири одной рукой': 'One-Arm_Kettlebell_Snatch',
  'Передача гири восьмёркой между ног': 'Kettlebell_Figure_8',
}
for (const exercise of exerciseCatalog) {
  const id = kettlebellFrames[exercise.name]
  const image = KETTLEBELL_IMAGES[exercise.name]
  if (id || image) catalogGuides.set(exercise.name, {
    ...(id ? catalogFrames(id) : { image }), muscles: exercise.muscle_groups.join(', '), steps: exercise.description ?? '',
  })
}

function findGuide(name: string): Guide | undefined {
  return Object.hasOwn(GUIDE, name) ? GUIDE[name] : catalogGuides.get(name)
}

export function hasExerciseGuide(name: string) { return !!findGuide(name) }
export function getExerciseGuideImage(name: string): string | null {
  const guide = findGuide(name)
  if (!guide?.image) return null
  return guideSrc(/\.(?:png|jpe?g|webp)$/i.test(guide.image) ? guide.image : `${guide.image}.webp`)
}

export default function KettlebellExercise({ exercise, onClose }: { exercise: PlannedExercise; onClose: () => void }) {
  useBack(onClose)
  const name = exercise.name
  const dialog = useRef<HTMLDialogElement>(null)
  const guide = findGuide(name)!
  const [zoomed, setZoomed] = useState(false)
  const [position, setPosition] = useState<'start' | 'finish'>('start')
  useEffect(() => {
    const element = dialog.current
    const trigger = document.activeElement
    if (element && typeof element.showModal === 'function') element.showModal()
    else element?.setAttribute('open', '')
    return () => {
      if (element?.open) element.close()
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [])
  return <dialog className="plan-recipe" ref={dialog} aria-labelledby="exercise-guide-title" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === dialog.current) onClose() }}>
    <div className="plan-recipe-scroll">
      <button autoFocus className="plan-recipe-close" aria-label="Закрыть упражнение" onClick={onClose}>×</button>
      {guide.image && <button className={zoomed ? 'exercise-image-button is-zoomed' : 'exercise-image-button'} onClick={() => setZoomed(value => !value)} aria-label={zoomed ? 'Уменьшить изображение' : 'Увеличить изображение'} aria-pressed={zoomed}>
        <img className="plan-recipe-cover exercise-guide-image" src={(position === 'start' && guide.startImage ? guideSrc(guide.startImage) : position === 'finish' && guide.endImage ? guideSrc(guide.endImage) : getExerciseGuideImage(name)) ?? undefined} alt={`Пример выполнения: ${name}`}
          onError={(e) => { const img = e.currentTarget, main = getExerciseGuideImage(name); if (main && !img.src.endsWith(main)) img.src = main; else img.hidden = true }} />
        <span>{zoomed ? 'Уменьшить' : 'Увеличить'}</span>
      </button>}
      {(guide.startImage || guide.endImage) && <div className="exercise-positions" role="group" aria-label="Положение упражнения">
        <button aria-pressed={position === 'start'} onClick={() => { setPosition('start'); setZoomed(false) }}>1 · Исходное положение</button>
        <button aria-pressed={position === 'finish'} onClick={() => { setPosition('finish'); setZoomed(false) }}>2 · {guide.endLabel ?? 'Конечное положение'}</button>
      </div>}
      <div className="plan-recipe-body exercise-guide-body"><h2 id="exercise-guide-title">{name}</h2>
        <dl className="exercise-plan-stats">
          <div><dt>Подходы</dt><dd>{exercise.sets}</dd></div>
          <div><dt>{exercise.unit === 'seconds' ? 'Секунды' : 'Повторы'}</dt><dd>{exercise.reps}</dd></div>
          <div><dt>Отдых</dt><dd>{exercise.rest_seconds} с</dd></div>
        </dl>
        <h3>Работают мышцы</h3><p>{guide.muscles}</p>{guide.steps && <><h3>Как выполнять</h3><p>{guide.steps}</p></>}{exercise.notes && <><h3>Рекомендации</h3><p>{exercise.notes}</p></>}</div>
    </div>
  </dialog>
}
