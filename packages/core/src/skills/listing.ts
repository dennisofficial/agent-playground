export type SkillListingEntry = { name: string; description: string; whenToUse: string | undefined }

export const SKILL_LISTING_MAX_DESCRIPTION_CHARS = 1536

export const SKILL_LISTING_MIN_DESCRIPTION_CHARS = 96

const WHEN_TO_USE_LEAD = 'Use when:'
const ELLIPSIS = '…'

const combinedOf = (entry: SkillListingEntry): string => {
  const description = entry.description.trim()
  const whenToUse = entry.whenToUse?.trim()
  if (whenToUse === undefined || whenToUse === '') return description
  if (description === '') return `${WHEN_TO_USE_LEAD} ${whenToUse}`
  return `${description} ${WHEN_TO_USE_LEAD} ${whenToUse}`
}

const truncated = (args: { text: string; maximum: number }): string => {
  if (args.text.length <= args.maximum) return args.text
  if (args.maximum <= 1) return args.text.slice(0, Math.max(0, args.maximum))
  return `${args.text.slice(0, args.maximum - 1).trimEnd()}${ELLIPSIS}`
}

const lineOf = (args: {
  entry: SkillListingEntry
  maximum: number
  described: boolean
}): string => {
  if (!args.described) return `- ${args.entry.name}`

  const combined = truncated({ text: combinedOf(args.entry), maximum: args.maximum })
  return combined === '' ? `- ${args.entry.name}` : `- ${args.entry.name}: ${combined}`
}

const renderedAt = (args: {
  entries: readonly SkillListingEntry[]
  maximum: number
  describedCount: number
}): string =>
  args.entries
    .map((entry, at) =>
      lineOf({ entry, maximum: args.maximum, described: at < args.describedCount }),
    )
    .join('\n')

const widestFitting = (args: {
  entries: readonly SkillListingEntry[]
  budget: number
  ceiling: number
  floor: number
}): string | undefined => {
  let low = args.floor
  let high = args.ceiling
  let fitting: string | undefined

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const rendered = renderedAt({
      entries: args.entries,
      maximum: middle,
      describedCount: args.entries.length,
    })

    if (rendered.length <= args.budget) {
      fitting = rendered
      low = middle + 1
      continue
    }
    high = middle - 1
  }

  return fitting
}

export function renderSkillListing(args: {
  entries: readonly SkillListingEntry[]
  maxDescriptionChars?: number
  budgetChars?: number
}): string {
  if (args.entries.length === 0) return ''

  const maximum = args.maxDescriptionChars ?? SKILL_LISTING_MAX_DESCRIPTION_CHARS
  const budget = args.budgetChars
  const described = args.entries.length
  const full = renderedAt({ entries: args.entries, maximum, describedCount: described })
  if (budget === undefined || full.length <= budget) return full

  const floor = Math.min(maximum, SKILL_LISTING_MIN_DESCRIPTION_CHARS)
  const fitting = widestFitting({ entries: args.entries, budget, ceiling: maximum, floor })
  if (fitting !== undefined) return fitting

  for (let describedCount = described - 1; describedCount > 0; describedCount -= 1) {
    const rendered = renderedAt({ entries: args.entries, maximum: floor, describedCount })
    if (rendered.length <= budget) return rendered
  }

  return renderedAt({ entries: args.entries, maximum: floor, describedCount: 0 })
}
