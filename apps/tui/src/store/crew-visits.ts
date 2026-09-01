export type CrewVisits = ReadonlyMap<string, string>

export const NO_VISITS: CrewVisits = new Map()

export const lastVisitOf = (args: { visits: CrewVisits; id: string }): string | null =>
  args.visits.get(args.id) ?? null

export function recordDeparture(args: {
  visits: CrewVisits
  leaving: string | null
  at: string
}): CrewVisits {
  const { visits, leaving, at } = args
  if (leaving === null) return visits

  const moved = new Map(visits)
  moved.set(leaving, at)
  return moved
}
