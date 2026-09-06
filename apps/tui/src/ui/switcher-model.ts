import {
  clampEffort,
  ESettingId,
  isFavourite,
  nextEffort,
  refKey,
  type EEffort,
  type ModelCard,
  type ModelRef,
} from '@dltech/atlas-core'

export type SwitcherProvider = {
  id: string
  label: string
  cards: readonly ModelCard[]
}

export type SwitcherAvailability = ReadonlySet<string> | ((providerId: string) => boolean)

export enum ESwitcherRow {
  Header = 'header',
  Model = 'model',
}

export type SwitcherRow =
  | { kind: ESwitcherRow.Header; providerId: string; label: string }
  | { kind: ESwitcherRow.Model; providerId: string; card: ModelCard; available: boolean }

export type SwitcherState = {
  index: number
  effort: EEffort
}

export type SwitcherChoice = {
  ref: ModelRef | null
  effort: EEffort
}

export enum EModelScope {
  Thread = 'thread',
  Setting = 'setting',
}

/** Where a pick lands: on the conversation, or on whichever Model-kind setting row was activated. */
export type SwitcherSettingTarget = {
  scope: EModelScope.Setting
  id: string
  label: string
  withEffort: boolean
}

export type SwitcherTarget = { scope: EModelScope.Thread } | SwitcherSettingTarget

export const THREAD_TARGET: SwitcherTarget = { scope: EModelScope.Thread }

/** The Default model row is the one setting whose pick is a model + effort pair. */
export function settingTarget(args: { id: string; label: string }): SwitcherSettingTarget {
  return {
    scope: EModelScope.Setting,
    id: args.id,
    label: args.label,
    withEffort: args.id === ESettingId.ModelId,
  }
}

export function isProviderReachable(args: {
  providerId: string
  availability?: SwitcherAvailability | undefined
}): boolean {
  const { availability } = args
  if (availability === undefined) return true
  if (typeof availability === 'function') return availability(args.providerId)
  return availability.has(args.providerId)
}

const matches = (args: { card: ModelCard; needle: string }): boolean =>
  args.needle.length === 0 ||
  `${args.card.label} ${refKey(args.card.ref)}`.toLowerCase().includes(args.needle)

export const FAVOURITES_GROUP_ID = 'favourites'

export const FAVOURITES_GROUP_LABEL = 'Pinned'

type Offered = { providerId: string; card: ModelCard; available: boolean }

const groupOf = (args: {
  id: string
  label: string
  offered: readonly Offered[]
}): SwitcherRow[] =>
  args.offered.length === 0
    ? []
    : [
        { kind: ESwitcherRow.Header as const, providerId: args.id, label: args.label },
        ...args.offered.map((offer) => ({ kind: ESwitcherRow.Model as const, ...offer })),
      ]

/**
 * A pinned model is lifted out of its provider's group rather than copied into a second one, so a
 * name never answers a filter twice and the pin is visible as the move it made.
 */
const pinnedFirst = (args: {
  offered: readonly Offered[]
  favourites: readonly string[]
}): readonly string[] =>
  args.favourites.filter((key) => args.offered.some((offer) => refKey(offer.card.ref) === key))

export function switcherRows(args: {
  providers: readonly SwitcherProvider[]
  availability?: SwitcherAvailability | undefined
  query?: string | undefined
  favourites?: readonly string[] | undefined
}): readonly SwitcherRow[] {
  const needle = (args.query ?? '').trim().toLowerCase()
  const favourites = args.favourites ?? []

  const offered: readonly Offered[] = args.providers.flatMap((provider) => {
    const available = isProviderReachable({
      providerId: provider.id,
      availability: args.availability,
    })

    return provider.cards
      .filter((card) => matches({ card, needle }))
      .map((card) => ({ providerId: provider.id, card, available }))
  })

  const pinned = pinnedFirst({ offered, favourites })
  const isPinned = (offer: Offered): boolean =>
    isFavourite({ favourites: pinned, key: refKey(offer.card.ref) })

  const byKey = new Map(offered.map((offer) => [refKey(offer.card.ref), offer]))

  return [
    ...groupOf({
      id: FAVOURITES_GROUP_ID,
      label: FAVOURITES_GROUP_LABEL,
      offered: pinned.flatMap((key) => {
        const offer = byKey.get(key)
        return offer === undefined ? [] : [offer]
      }),
    }),
    ...args.providers.flatMap((provider) =>
      groupOf({
        id: provider.id,
        label: provider.label,
        offered: offered.filter((offer) => offer.providerId === provider.id && !isPinned(offer)),
      }),
    ),
  ]
}

export const modelCount = (providers: readonly SwitcherProvider[]): number =>
  providers.reduce((total, provider) => total + provider.cards.length, 0)

export const shownCount = (rows: readonly SwitcherRow[]): number =>
  rows.reduce((shown, row) => (row.kind === ESwitcherRow.Model ? shown + 1 : shown), 0)

const selectableIndexes = (rows: readonly SwitcherRow[]): number[] =>
  rows.flatMap((row, index) => (row.kind === ESwitcherRow.Model && row.available ? [index] : []))

export function cardAt(args: {
  rows: readonly SwitcherRow[]
  index: number
}): ModelCard | undefined {
  const row = args.rows[args.index]
  return row?.kind === ESwitcherRow.Model ? row.card : undefined
}

export const selectedCard = (args: {
  state: SwitcherState
  rows: readonly SwitcherRow[]
}): ModelCard | undefined => cardAt({ rows: args.rows, index: args.state.index })

const settled = (args: {
  rows: readonly SwitcherRow[]
  index: number
  effort: EEffort
}): SwitcherState => {
  const card = cardAt({ rows: args.rows, index: args.index })
  return {
    index: args.index,
    effort: clampEffort({ map: card?.effort, effort: args.effort }) ?? args.effort,
  }
}

/** Where the highlight belongs once the rows have changed under it. */
export function anchorOn(args: {
  rows: readonly SwitcherRow[]
  active: ModelRef | undefined
  effort: EEffort
}): SwitcherState {
  const wanted = args.active === undefined ? undefined : refKey(args.active)
  const found =
    wanted === undefined
      ? -1
      : args.rows.findIndex(
          (row) => row.kind === ESwitcherRow.Model && refKey(row.card.ref) === wanted,
        )
  if (found >= 0) return settled({ rows: args.rows, index: found, effort: args.effort })

  const [first] = selectableIndexes(args.rows)
  return settled({ rows: args.rows, index: first ?? 0, effort: args.effort })
}

export function openSwitcher(args: {
  providers: readonly SwitcherProvider[]
  active: ModelRef
  effort: EEffort
  availability?: SwitcherAvailability | undefined
  favourites?: readonly string[] | undefined
}): SwitcherState {
  const rows = switcherRows({
    providers: args.providers,
    ...(args.availability === undefined ? {} : { availability: args.availability }),
    ...(args.favourites === undefined ? {} : { favourites: args.favourites }),
  })

  return anchorOn({ rows, active: args.active, effort: args.effort })
}

/** A row named outright — by a click, not by a step — which only lands if it can be switched to. */
export function selectAt(args: {
  state: SwitcherState
  index: number
  rows: readonly SwitcherRow[]
}): SwitcherState {
  const row = args.rows[args.index]
  if (row?.kind !== ESwitcherRow.Model || !row.available) return args.state

  return settled({ rows: args.rows, index: args.index, effort: args.state.effort })
}

export function moveSelection(args: {
  state: SwitcherState
  delta: number
  rows: readonly SwitcherRow[]
}): SwitcherState {
  const steps = Math.trunc(args.delta)
  const direction = Math.sign(steps)
  if (direction === 0) return args.state

  const selectable = selectableIndexes(args.rows)
  let index = args.state.index

  for (let taken = 0; taken < Math.abs(steps); taken += 1) {
    const next =
      direction > 0
        ? selectable.find((candidate) => candidate > index)
        : selectable.findLast((candidate) => candidate < index)
    if (next === undefined) break
    index = next
  }

  return settled({ rows: args.rows, index, effort: args.state.effort })
}

export function adjustEffort(args: {
  state: SwitcherState
  delta: number
  rows: readonly SwitcherRow[]
}): SwitcherState {
  const card = selectedCard({ state: args.state, rows: args.rows })
  const stepped = nextEffort({ map: card?.effort, effort: args.state.effort, delta: args.delta })
  return { ...args.state, effort: stepped ?? args.state.effort }
}

export function resolve(args: {
  state: SwitcherState
  rows: readonly SwitcherRow[]
}): SwitcherChoice {
  const card = selectedCard({ state: args.state, rows: args.rows })
  return { ref: card?.ref ?? null, effort: args.state.effort }
}

export function priceLabel(card: ModelCard): string | null {
  const cost = card.cost
  return cost === undefined ? null : `$${cost.outputPerMillion.toFixed(2)}/M`
}
