import { bodyAvatarSource, type Sex } from './bodyShape'

export default function BodyFigure({ sex, level, label }: { sex: Sex; level: number; label: string }) {
  return <img className="body-figure" src={bodyAvatarSource(sex, level)}
    width={224} height={500} alt={label} />
}
