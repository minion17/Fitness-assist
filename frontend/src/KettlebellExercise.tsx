import { useEffect, useRef, useState } from 'react'
import { repsLabel } from './reps'
import './MealDay.css'
import type { PlannedExercise } from './types'
import translatedCatalog from '../../content/exercises/translated_exercises.json'
import exerciseCatalog from '../../content/exercises/exercises.json'
import { useBack } from './back'

type Guide = { image?: string; startImage?: string; endImage?: string; endLabel?: string; muscles: string; steps: string }
const GUIDE: Record<string, Guide> = {
  'Жим штанги лежа': { image: 'barbell_bench', endImage: 'barbell_bench_position2.webp', endLabel: 'Нижнее положение', muscles: 'Грудь, трицепсы, плечи', steps: 'Ляг на устойчивую скамью, упри стопы в пол. Контролируемо опусти штангу к груди и выжми вверх.' },
  'Приседания со штангой': { image: 'barbell_squat', startImage: 'barbell_squat_position2.webp', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Расположи гриф на верхней части спины. Присядь в комфортную глубину и выпрямись, сохраняя устойчивость.' },
  'Становая тяга': { image: 'barbell_deadlift', endImage: 'barbell_deadlift_position2.webp', muscles: 'Ягодицы, задняя поверхность бедра, спина', steps: 'Подойди к грифу, отведи таз назад, возьмись за штангу и поднимись, сохраняя её близко к ногам.' },
  'Становая тяга сумо': { image: 'sumo_deadlift', endImage: 'sumo_deadlift_position2.webp', muscles: 'Ягодицы, бёдра, мышцы спины', steps: 'Поставь ноги широко, разверни носки и возьмись за гриф между ног. Поднимись, удерживая спину нейтральной.' },
  'Становая тяга с трэп-грифом': { image: 'trapbar_deadlift', endImage: 'trapbar_deadlift_position2.webp', muscles: 'Квадрицепсы, ягодицы, задняя поверхность бедра', steps: 'Встань внутрь трэп-грифа, возьмись за рукояти и встань, удерживая корпус собранным.' },
  'Жим штанги на наклонной скамье': { image: 'incline_barbell_press', startImage: 'incline_barbell_press_position2.webp', endLabel: 'Нижнее положение', muscles: 'Верх груди, плечи, трицепсы', steps: 'Ляг на наклонную скамью, опусти штангу к верхней части груди и выжми вверх.' },
  'Жим штанги узким хватом': { image: 'closegrip_bench', endImage: 'closegrip_bench_position2.webp', endLabel: 'Нижнее положение', muscles: 'Трицепсы, грудь, плечи', steps: 'Лёжа на скамье возьмись за гриф примерно на ширине плеч. Опусти к груди и выжми вверх.' },
  'Фронтальные приседания со штангой': { image: 'front_squat', startImage: 'front_squat_position2.webp', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Удерживая гриф перед плечами, присядь с ровным корпусом и поднимись, толкаясь стопами.' },
  'Выпады со штангой': { image: 'barbell_lunge', startImage: 'barbell_lunge_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'Стабильно установи гриф на верхней части спины. Сделай шаг, опустись в выпад и вернись.' },
  'Шраги со штангой': { image: 'barbell_shrug', startImage: 'barbell_shrug_position2.webp', muscles: 'Трапециевидные мышцы', steps: 'Держа штангу перед собой, подними плечи вверх без кругового движения. Плавно опусти.' },
  'Наклоны в сторону со штангой': { image: 'barbell_side_bend', startImage: 'barbell_side_bend_position2.webp', muscles: 'Боковые мышцы корпуса, разгибатели спины', steps: 'Удерживая гриф устойчиво, наклонись в сторону в комфортной амплитуде и вернись в центр.' },
  'Зашагивания на платформу со штангой': { image: 'barbell_stepup', startImage: 'barbell_stepup_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'Поставь всю стопу на платформу и поднимись, опираясь на переднюю ногу. Спустись подконтрольно.' },
  'Подтягивания широким хватом': { image: 'pullup_wide', startImage: 'pullup_wide_position2.webp', muscles: 'Широчайшие мышцы спины, бицепсы', steps: 'Возьмись за перекладину шире плеч. Подтянись без рывка и плавно опустись.' },
  'Подтягивания прямым хватом': { image: 'pullup', startImage: 'pullup_position2.webp', muscles: 'Широчайшие мышцы спины, бицепсы', steps: 'Возьмись за перекладину, подтянись без рывков и подконтрольно опустись.' },
  'Тяга штанги в наклоне': { image: 'barbell_row', startImage: 'barbell_row_position2.webp', muscles: 'Мышцы спины, бицепсы', steps: 'Наклонись с нейтральной спиной, подтяни штангу к корпусу и плавно опусти.' },
  'Армейский жим': { image: 'military_press', startImage: 'military_press_start.webp', muscles: 'Дельты, трицепсы', steps: 'Установи штангу у верхней части груди. Выжми её вверх над головой и опусти подконтрольно.' },
  'Выпады с гантелями': { image: 'dumbbell_lunge', startImage: 'dumbbell_lunge_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'С гантелями по бокам сделай шаг вперёд и опустись до комфортной глубины. Оттолкнись передней ногой и вернись.' },
  'Румынская тяга': { image: 'barbell_rdl.jpg', muscles: 'Задняя поверхность бедра, ягодицы, спина', steps: 'Слегка согни колени и отведи таз назад, ведя штангу вдоль ног. Выпрямись за счёт движения таза.' },
  'Отжимания от пола': { image: 'pushup_floor', startImage: 'pushup_floor_position2.webp', muscles: 'Грудь, трицепсы, плечи', steps: 'Упрись ладонями в пол, удерживай корпус ровным. Согни руки и вернись в исходное положение.' },
  'Жим ногами в тренажёре': { image: 'legpress', startImage: 'legpress_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'Устройся на тренажёре, поставь стопы на платформу. Контролируемо согни и выпрями ноги.' },
  'Разгибание ног в тренажёре': { image: 'leg_extension', startImage: 'leg_extension_position2.webp', muscles: 'Квадрицепсы', steps: 'Сядь так, чтобы ось тренажёра совпадала с коленями. Разогни ноги без рывка и плавно вернись.' },
  'Сгибание ног в тренажёре': { image: 'leg_curl', startImage: 'leg_curl_position2.webp', muscles: 'Задняя поверхность бедра', steps: 'Зафиксируй корпус на тренажёре. Согни ноги, подтягивая валик к бёдрам, затем медленно разогни.' },
  'Махи гантелями в стороны': { image: 'lateral_raise', startImage: 'lateral_raise_position2.webp', muscles: 'Средняя часть дельтовидных мышц', steps: 'Подними гантели в стороны до уровня плеч, сохраняя мягкий сгиб локтей. Опусти плавно.' },
  'Подъём штанги на бицепс': { image: 'barbell_curl', startImage: 'barbell_curl_position2.webp', muscles: 'Бицепсы', steps: 'Держа локти у корпуса, согни руки и подними штангу. Опусти её контролируемо.' },
  'Французский жим': { image: 'french_press', startImage: 'french_press_position2.webp', muscles: 'Трицепсы', steps: 'Лёжа на скамье, согни руки и опусти гриф за линию лба. Разогни локти, удерживая плечи стабильными.' },
  'Разгибание рук на блоке': { image: 'cable_pushdown', startImage: 'cable_pushdown_position2.webp', muscles: 'Трицепсы', steps: 'Прижми локти к корпусу. Разогни руки вниз и вернись в исходное положение без раскачивания.' },
  'Отжимания на брусьях': { image: 'parallel_dip', startImage: 'parallel_dip_position2.webp', muscles: 'Трицепсы, грудь, передняя часть плеч', steps: 'На брусьях согни руки и опустись в комфортную глубину. Выжми себя вверх без раскачивания.' },
  'Тяга гантели в наклоне': { image: 'dumbbell_row', startImage: 'dumbbell_row_position2.webp', muscles: 'Широчайшие и ромбовидные мышцы спины', steps: 'С опорой рукой на скамью подтяни гантель к тазу, не разворачивая корпус. Плавно опусти.' },
  'Тяга верхнего блока к груди': { image: 'lat_pulldown', startImage: 'lat_pulldown_position2.webp', muscles: 'Широчайшие мышцы спины, бицепсы', steps: 'Сядь под упоры и потяни перекладину к верхней части груди. Контролируемо верни её вверх.' },
  'Молотки с гантелями': { image: 'hammer_curl', muscles: 'Бицепсы, плечевая мышца', steps: 'Держи гантели нейтральным хватом. Согни руки, не уводя локти вперёд, и плавно опусти.' },
  'Жим гантелей сидя': { image: 'seated_db_press', startImage: 'seated_db_press_position2.webp', muscles: 'Дельтовидные мышцы, трицепсы', steps: 'Сидя с опорой спины, выжми гантели вверх. Опусти до комфортного уровня плеч.' },
  'Гиперэкстензия': { image: 'back_extension', startImage: 'back_extension_position2.webp', muscles: 'Разгибатели спины, ягодицы', steps: 'На римском стуле опусти корпус и поднимись до прямой линии тела, не переразгибая поясницу.' },
  'Ягодичный мост со штангой': { image: 'glute_bridge_barbell', startImage: 'glute_bridge_barbell_position2.webp', muscles: 'Ягодицы, задняя поверхность бедра', steps: 'Верх спины опирается на скамью, штанга лежит на тазе. Подними таз до прямой линии корпуса и опусти.' },
  'Скручивания на полу': { image: 'crunch.jpg', muscles: 'Прямая мышца живота', steps: 'Лёжа на спине с согнутыми коленями, слегка приподними плечи за счёт мышц живота и плавно опустись.' },
  'Подъём ног в висе': { image: 'hanging_leg_raise.jpg', muscles: 'Мышцы живота и сгибатели бедра', steps: 'Повисни на перекладине без раскачивания. Подними согнутые или прямые ноги перед собой и опусти подконтрольно.' },
  'Болгарские сплит-приседания': { image: 'bulgarian_split_squat.jpg', startImage: 'bulgarian_split_squat_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'Поставь заднюю стопу на невысокую опору. Опустись на передней ноге и вернись, удерживая корпус устойчиво.' },
  'Берпи': { image: 'burpee.jpg', muscles: 'Всё тело, мышцы корпуса', steps: 'Присядь и поставь ладони на пол, перейди в упор лёжа, верни ноги к рукам и встань.' },
  'Скакалка': { image: 'jump_rope.jpg', muscles: 'Икроножные мышцы, плечи, мышцы корпуса', steps: 'Прыгай невысоко, вращая скакалку кистями. Приземляйся мягко на переднюю часть стоп.' },
  'Жим штанги на скамье с обратным наклоном': { image: 'decline_bench.jpg', muscles: 'Нижняя часть груди, трицепсы, плечи', steps: 'Ляг на скамью с наклоном вниз и зафиксируй ноги. Опусти гриф к нижней части груди и выжми вверх.' },
  'Приседания с собственным весом': { image: 'bodyweight_squat.jpg', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Поставь стопы примерно на ширине плеч. Отведи таз назад, присядь в комфортную глубину и встань.' },
  'Выпады шагом с собственным весом': { image: 'bodyweight_lunge.jpg', startImage: 'bodyweight_lunge_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'Сделай шаг вперёд, опустись до комфортной глубины и оттолкнись передней ногой. Чередуй стороны.' },
  'Обратные отжимания от скамьи': { image: 'bench_dip.jpg', muscles: 'Трицепсы, грудь, передняя часть плеч', steps: 'Упрись ладонями в край устойчивой скамьи и согни руки, опуская корпус. Выпрями руки и вернись вверх.' },
  'Отжимания от пола широким хватом': { image: 'wide_pushup.jpg', muscles: 'Грудь, трицепсы, плечи', steps: 'Поставь ладони шире плеч и удерживай корпус ровным. Опустись к полу и оттолкнись ладонями.' },
  'Отжимания от пола узким хватом': { image: 'close_pushup.jpg', muscles: 'Трицепсы, грудь, мышцы корпуса', steps: 'Поставь ладони близко друг к другу под грудью. Согни руки, удерживая локти ближе к корпусу, и выпрями их.' },
  'Отжимания с ногами на возвышении': { image: 'feet_elevated_pushup.jpg', muscles: 'Грудь, трицепсы, плечи, мышцы корпуса', steps: 'Поставь стопы на устойчивую невысокую опору. Удерживая корпус ровным, опустись к полу и оттолкнись.' },
  'Подтягивания лопатками': { image: 'scapular_pullup.jpg', muscles: 'Широчайшие мышцы спины, мышцы плечевого пояса', steps: 'Повисни на прямых руках. Не сгибая локти, опусти лопатки и слегка подними корпус, затем расслабься.' },
  'Подтягивания с резиновой петлёй': { image: 'band_pullup.jpg', muscles: 'Широчайшие мышцы спины, бицепсы', steps: 'Надёжно закрепи резиновую петлю на перекладине и поставь в неё колено или стопу. Подтянись без рывка и опустись.' },
  'Жим гантелей лёжа': { image: 'db_bench.jpg', endImage: 'db_bench_position2.webp', endLabel: 'Нижнее положение', muscles: 'Грудь, трицепсы, плечи', steps: 'Ляг на скамью, удерживай гантели над грудью. Опусти их по сторонам от корпуса и выжми вверх.' },
  'Жим гантелей лёжа нейтральным хватом': { image: 'db_bench_neutral.jpg', endImage: 'db_bench_neutral_position2.webp', endLabel: 'Нижнее положение', muscles: 'Грудь, трицепсы, плечи', steps: 'Ляг на скамью, поверни ладони друг к другу. Опусти гантели к груди и выжми вверх, сохраняя нейтральный хват.' },
  'Приседания с гантелями': { image: 'db_squat.jpg', startImage: 'db_squat_position2.webp', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Держи гантели по бокам. Присядь, сохраняя устойчивость стоп и нейтральное положение спины, затем встань.' },
  'Сплит-приседания с гантелями': { image: 'db_split_squat.jpg', startImage: 'db_split_squat_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'Поставь одну ногу впереди другой и держи гантели по бокам. Опустись вниз и вернись, затем смени сторону.' },
  'Тяга штанги на прямых ногах': { image: 'barbell_rdl.jpg', muscles: 'Задняя поверхность бедра, ягодицы, спина', steps: 'Слегка согни колени, отведи таз назад и веди штангу вдоль ног. Вернись за счёт разгибания таза.' },
  'Отжимание с переходом в боковую планку': { image: 'pushup_side_plank.jpg', muscles: 'Грудь, плечи, трицепсы, мышцы корпуса', steps: 'Выполни отжимание, затем поверни корпус в боковую планку, подняв верхнюю руку. Вернись и чередуй стороны.' },
  'Тяга гантелей на прямых ногах': { image: 'db_rdl.jpg', muscles: 'Задняя поверхность бедра, ягодицы, спина', steps: 'Держи гантели близко к ногам, слегка согни колени и отведи таз назад. Выпрямись, возвращая таз вперёд.' },
  'Сгибание рук с гантелями на наклонной скамье': { image: 'incline_db_curl.jpg', muscles: 'Бицепсы', steps: 'Сядь на наклонную скамью, опустив руки с гантелями. Согни локти, затем медленно выпрями руки.' },
  'Сгибание рук с гантелями сидя': { image: 'seated_db_curl.jpg', muscles: 'Бицепсы', steps: 'Сядь устойчиво, держи локти у корпуса. Согни руки с гантелями и плавно опусти их.' },
  'Махи гирей двумя руками': { image: 'kb_twohand_swing.webp', muscles: 'Ягодицы, задняя поверхность бедра, мышцы корпуса', steps: 'Отведи таз назад и веди гирю между бёдрами. Разогни таз и подними гирю движением бёдер; руки только направляют снаряд. Плавно вернись в наклон.' },
  'Попеременный жим гирь': { image: 'kb_alternating_press.jpg', muscles: 'Дельтовидные мышцы, трицепсы, мышцы корпуса', steps: 'Удерживай гири у плеч. Поочерёдно выжимай одну гирю вверх, оставляя вторую у плеча; контролируй корпус.' },
  'Попеременная тяга гирь в наклоне': { image: 'kb_alternating_row.jpg', muscles: 'Мышцы спины, бицепсы', steps: 'Наклонись с ровной спиной и держи гири под плечами. Поочерёдно подтягивай их к корпусу.' },
  'Махи гирей одной рукой': { image: 'kb_onearm_swing.jpg', muscles: 'Ягодицы, задняя поверхность бедра, мышцы корпуса', steps: 'Раскачай гирю движением таза, а не подъёмом рукой. Держи спину нейтральной и чередуй руки после подхода.' },
  'Вращение гири вокруг головы': { image: 'kb_halo.jpg', muscles: 'Плечевой пояс, мышцы корпуса', steps: 'Удерживая гирю двумя руками, плавно проведи её вокруг головы. Держи корпус неподвижно и меняй направление.' },
  'Тяга гири на одной ноге': { image: 'kb_singleleg_deadlift.jpg', muscles: 'Ягодицы, задняя поверхность бедра, мышцы корпуса', steps: 'Перенеси вес на одну ногу, слегка согни колено и отведи свободную ногу назад. Наклонись с гирей и вернись.' },
  'Разгибание рук с гирей из-за головы': { image: 'kb_overhead_triceps.jpg', muscles: 'Трицепсы', steps: 'Удерживай гирю двумя руками над головой. Согни локти, опустив её за голову, затем выпрями руки.' },
  'Трастер с гирей': { image: 'kb_thruster.jpg', muscles: 'Ноги, ягодицы, плечи, трицепсы', steps: 'Удерживай гирю у груди, выполни присед и при подъёме выжми её вверх. Опусти к груди и повтори.' },
  'Тяга двух гирь в наклоне': { image: 'kb_double_row.jpg', muscles: 'Широчайшие мышцы спины, ромбовидные мышцы, бицепсы', steps: 'Наклонись с ровной спиной, удерживая гири под плечами. Подтяни обе гири к корпусу и медленно опусти.' },
  'Турецкий подъём с гирей через выпад': { image: 'turkish_getup.jpg', muscles: 'Плечо, мышцы корпуса, ягодицы и ноги', steps: 'Удерживай гирю над плечом и поднимайся поэтапно через опору на локоть и ладонь к положению выпада. Затем вернись тем же путём.' },
  'Фронтальные приседания с двумя гирями': { image: 'kb_double_front_squat.jpg', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Удерживай две гири у плеч. Присядь, сохраняя корпус устойчивым, и вернись в исходное положение.' },
  'Австралийские подтягивания': { image: 'australian_pullup.jpg', muscles: 'Мышцы спины, бицепсы, задняя часть плеч', steps: 'Возьмись за низкую перекладину, вытяни тело в прямую линию и подтяни грудь к перекладине. Плавно опустись.' },
  'Супермен': { image: 'superman.jpg', muscles: 'Разгибатели спины, ягодицы, задняя часть плеч', steps: 'Лёжа на животе, слегка приподними руки, грудь и ноги. Задержись на короткое время и мягко опустись.' },

  'Гоблет-приседания': { image: 'squat', startImage: 'squat_position2.webp', muscles: 'Квадрицепсы, ягодицы, мышцы корпуса', steps: 'Держи гирю у груди. Присядь в комфортную глубину и поднимись, сохраняя устойчивое положение стоп.' },
  'Тяга гири с пола': { image: 'deadlift-male', endImage: 'deadlift-male_position2.webp', muscles: 'Ягодицы, задняя поверхность бедра, мышцы спины', steps: 'Отведи таз назад, возьми гирю с пола двумя руками и выпрямись. Опусти гирю, контролируя положение спины.' },
  'Тяга гири одной рукой в наклоне': { image: 'row-male', startImage: 'row-male_position2.webp', muscles: 'Мышцы спины, бицепс', steps: 'Наклонись с опорой свободной рукой. Подтяни гирю к корпусу и плавно опусти. Выполни на обе стороны.' },
  'Отжимания руками от опоры': { image: 'pushup', startImage: 'pushup_position2.webp', muscles: 'Грудь, трицепсы, передняя поверхность плеч', steps: 'Поставь руки на устойчивую опору. Согни руки, удерживая корпус ровным, затем выпрями.' },
  'Мёртвый жук': { image: 'deadbug', startImage: 'deadbug_position2.webp', muscles: 'Мышцы живота и корпуса', steps: 'Лёжа на спине, медленно выпрямляй противоположные руку и ногу. Вернись и смени сторону.' },
  'Выпады с гирей': { image: 'lunge', startImage: 'lunge_position2.webp', muscles: 'Квадрицепсы, ягодицы', steps: 'Держи гирю у груди. Шагни и опустись в выпад, затем вернись. Выполни на обе ноги.' },
  'Ягодичный мост': { image: 'glute-male', startImage: 'glute-male_position2.webp', muscles: 'Ягодицы, задняя поверхность бедра', steps: 'Лёжа на спине с согнутыми коленями, подними таз и плавно опусти.' },
  'Жим гири сидя': { image: 'kb_seated_press.jpg', muscles: 'Плечи, трицепсы', steps: 'Сядь устойчиво, удерживая гирю у плеча. Выжми её над головой и подконтрольно опусти. Выполни на обе стороны.' },
  'Планка': { image: 'plank', muscles: 'Мышцы живота и корпуса', steps: 'Опираясь на предплечья и носки, удерживай тело ровно и дыши спокойно.' },
}

const KETTLEBELL_IMAGES: Record<string, string> = {
  "Передача гири вокруг корпуса": "kb_passaround.webp",
  "Махи гирей со сменой рук": "kb_handoff.jpg",
  "Толчок гири одной рукой": "kb_jerk_v2.webp",
  "Швунг гири одной рукой": "kb_pushpress.webp",
  "Фермерская прогулка с одной гирей": "kb_suitcase_carry.webp",
  "Жим гири лёжа на полу одной рукой": "kb_floor_press.webp",
  "Жим гири стоя одной рукой": "kb_standing_press.webp",
  "Приседание с гирей у плеча": "kb_rack_squat.webp",
  "Становая тяга с гирей сумо": "kb_sumo_deadlift.webp",
  "Румынская тяга с гирей двумя руками": "kb_romanian_deadlift.webp",
  "Прогулка с гирей у плеча": "kb_rack_carry.webp",
  "Удержание гири одной рукой у бедра": "kb_suitcase_hold.webp",
  "Марш с гирей у груди": "kb_goblet_march.webp",
  "Тяга гири к поясу двумя руками в наклоне": "kb_twohand_row.webp",
  "Тяга гири в стойке чемодан": "kb_suitcase_deadlift.webp",
  "Выпад назад с гирей у груди": "kb_reverse_lunge.webp",
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
          <div><dt>{exercise.unit === 'seconds' ? 'Секунды' : 'Повторы'}</dt><dd>{repsLabel(exercise.reps)}</dd></div>
          <div><dt>Отдых</dt><dd>{exercise.rest_seconds} с</dd></div>
        </dl>
        <h3>Работают мышцы</h3><p>{guide.muscles}</p>{guide.steps && <><h3>Как выполнять</h3><p>{guide.steps}</p></>}{exercise.notes && <><h3>Рекомендации</h3><p>{exercise.notes}</p></>}</div>
    </div>
  </dialog>
}
