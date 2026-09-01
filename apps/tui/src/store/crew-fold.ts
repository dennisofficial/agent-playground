import { ECrewStanding } from './crew-retirement'

export type CrewFold<TRow> = {
  shown: readonly TRow[]
  hidden: number
  hiddenFailed: boolean
}

export const DEFAULT_CREW_CAP = 3

/**
 * Only a row already released by the retirement policy may be capped. A live row, and a settled one
 * the policy is still holding — an unread result, an unacknowledged failure, a job something else
 * still depends on — outranks the cap, so narrowing the panel can never be what loses the reading
 * that mattered.
 */
export function foldCrew<TRow>(args: {
  rows: readonly TRow[]
  standings: ReadonlyMap<string, ECrewStanding>
  cap: number
  keyOf: (row: TRow) => string
  wentWrong: (row: TRow) => boolean
}): CrewFold<TRow> {
  const { rows, standings, cap, keyOf, wentWrong } = args

  const standingOf = (row: TRow): ECrewStanding => standings.get(keyOf(row)) ?? ECrewStanding.Live

  const retiring = rows.filter((row) => standingOf(row) === ECrewStanding.Retiring)
  const spared = new Set(retiring.slice(Math.max(0, retiring.length - cap)).map(keyOf))

  const shown: TRow[] = []
  const hiddenRows: TRow[] = []

  for (const row of rows) {
    const standing = standingOf(row)
    if (standing === ECrewStanding.Retired) {
      hiddenRows.push(row)
      continue
    }

    if (standing === ECrewStanding.Retiring && !spared.has(keyOf(row))) {
      hiddenRows.push(row)
      continue
    }

    shown.push(row)
  }

  return {
    shown,
    hidden: hiddenRows.length,
    hiddenFailed: hiddenRows.some(wentWrong),
  }
}
