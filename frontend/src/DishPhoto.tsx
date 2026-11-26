import { emojiSrc, foodIcon } from './foodIcon'
import { RECIPE_PHOTOS } from './mealCatalog'

export const dishPhoto = (id: string) => (RECIPE_PHOTOS.has(id) ? `/images/recipes/${id}.jpg` : null)

/** The dish's photo, or its food icon on a tinted tile while it has none. `alt` empty: decorative. */
export default function DishPhoto({ id, name, alt = '', className }: { id: string; name: string; alt?: string; className?: string }) {
  const src = dishPhoto(id)
  if (src) return <img className={className} src={src} alt={alt} loading="lazy" />
  return (
    <span className={`dish-ph ${className ?? ''}`} role={alt ? 'img' : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true}>
      <img src={emojiSrc(foodIcon(name))} alt="" draggable={false} />
    </span>
  )
}
