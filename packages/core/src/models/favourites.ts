const SEPARATOR = ','

export function parseFavourites(held: string | undefined): readonly string[] {
  if (held === undefined) return []

  const named = held
    .split(SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  return [...new Set(named)]
}

export const formatFavourites = (favourites: readonly string[]): string =>
  favourites.join(SEPARATOR)

export const isFavourite = (args: { favourites: readonly string[]; key: string }): boolean =>
  args.favourites.includes(args.key)

/**
 * A new pin lands at the end, so the group reads in the order it was built rather than reshuffling
 * every time something is added.
 */
export function toggleFavourite(args: {
  favourites: readonly string[]
  key: string
}): readonly string[] {
  if (isFavourite(args)) return args.favourites.filter((entry) => entry !== args.key)
  return [...args.favourites, args.key]
}
