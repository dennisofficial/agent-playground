import type { KeyEvent } from '@opentui/core'
import { useCallback, useMemo, useRef, useState } from 'react'

import { refKey, toggleFavourite, type EEffort, type ModelRef } from '@dltech/atlas-core'

import {
  adjustEffort,
  anchorOn,
  modelCount,
  moveSelection,
  openSwitcher,
  resolve,
  selectAt,
  selectedCard,
  switcherRows,
  type SwitcherChoice,
  type SwitcherRow,
  type SwitcherState,
} from '../ui/switcher-model'
import type { ModelCatalogue } from './providers'

export type SwitcherControl = {
  state: SwitcherState | null
  rows: readonly SwitcherRow[]
  query: string
  total: number
  favourites: readonly string[]
  handleOpen: () => void
  handleDismiss: () => void
  handlePick: (choice: SwitcherChoice) => void
  handleSelect: (index: number) => void
  handleKey: (key: KeyEvent) => void
}

type Browsing = { state: SwitcherState; query: string }

const FILTERABLE = /[\w.:/-]/

const PIN_KEY = '*'

const isFilterKey = (key: KeyEvent): boolean => {
  const sequence = key.sequence ?? ''
  return sequence.length === 1 && !key.ctrl && !key.meta && FILTERABLE.test(sequence)
}

/**
 * OpenTUI parses a whole input burst before React re-renders, so the run of key events a typed word
 * arrives as would all read the same rendered query. The ref is what the handlers read and write;
 * React state exists to draw it.
 */
export function useSwitcher(args: {
  catalogue: ModelCatalogue
  active: ModelRef
  effort: EEffort
  favourites: readonly string[]
  onPick: (choice: SwitcherChoice) => void
  onPin: (favourites: readonly string[]) => void
}): SwitcherControl {
  const held = useRef<Browsing | null>(null)
  const [browsing, setBrowsing] = useState<Browsing | null>(null)
  const { catalogue, active, effort, favourites, onPick, onPin } = args

  const put = useCallback((next: Browsing | null) => {
    held.current = next
    setBrowsing(next)
  }, [])

  const rowsWith = useCallback(
    (args: { query: string; favourites: readonly string[] }) =>
      switcherRows({
        providers: catalogue.providers,
        availability: catalogue.reachable,
        favourites: args.favourites,
        query: args.query,
      }),
    [catalogue],
  )

  const rowsFor = useCallback(
    (query: string) => rowsWith({ query, favourites }),
    [favourites, rowsWith],
  )

  const query = browsing?.query ?? ''
  const rows = useMemo(() => rowsFor(query), [query, rowsFor])
  const total = useMemo(() => modelCount(catalogue.providers), [catalogue])

  const handleOpen = useCallback(
    () =>
      put({
        query: '',
        state: openSwitcher({
          providers: catalogue.providers,
          active,
          effort,
          availability: catalogue.reachable,
          favourites,
        }),
      }),
    [active, catalogue, effort, favourites, put],
  )

  const handleDismiss = useCallback(() => put(null), [put])

  const handlePick = useCallback(
    (choice: SwitcherChoice) => {
      put(null)
      onPick(choice)
    },
    [onPick, put],
  )

  const handleFilter = useCallback(
    (args: { current: Browsing; typed: string }) => {
      const following = selectedCard({
        state: args.current.state,
        rows: rowsFor(args.current.query),
      })?.ref

      put({
        query: args.typed,
        state: anchorOn({
          rows: rowsFor(args.typed),
          active: following,
          effort: args.current.state.effort,
        }),
      })
    },
    [put, rowsFor],
  )

  const handleSelect = useCallback(
    (index: number) => {
      const current = held.current
      if (current === null) return

      put({
        ...current,
        state: selectAt({ state: current.state, index, rows: rowsFor(current.query) }),
      })
    },
    [put, rowsFor],
  )

  /**
   * Pinning moves the row it names into the group at the top, so the highlight is re-anchored on the
   * model it was already following rather than left on the index that model used to sit at.
   */
  const handlePin = useCallback(
    (current: Browsing) => {
      const wanted = selectedCard({ state: current.state, rows: rowsFor(current.query) })?.ref
      if (wanted === undefined) return

      const pinned = toggleFavourite({ favourites, key: refKey(wanted) })
      onPin(pinned)

      put({
        ...current,
        state: anchorOn({
          rows: rowsWith({ query: current.query, favourites: pinned }),
          active: wanted,
          effort: current.state.effort,
        }),
      })
    },
    [favourites, onPin, put, rowsFor, rowsWith],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      const current = held.current
      if (current === null) return

      const laid = rowsFor(current.query)

      if (key.name === 'escape') {
        handleDismiss()
        return
      }

      if (key.name === 'return') {
        handlePick(resolve({ state: current.state, rows: laid }))
        return
      }

      if (key.name === 'up' || key.name === 'down') {
        const delta = key.name === 'up' ? -1 : 1
        put({ ...current, state: moveSelection({ state: current.state, delta, rows: laid }) })
        return
      }

      if (key.name === 'left' || key.name === 'right') {
        const delta = key.name === 'left' ? -1 : 1
        put({ ...current, state: adjustEffort({ state: current.state, delta, rows: laid }) })
        return
      }

      if (key.name === 'backspace') {
        handleFilter({ current, typed: current.query.slice(0, -1) })
        return
      }

      if (key.sequence === PIN_KEY) {
        handlePin(current)
        return
      }

      if (isFilterKey(key))
        handleFilter({ current, typed: `${current.query}${key.sequence ?? ''}` })
    },
    [handleDismiss, handleFilter, handlePick, handlePin, put, rowsFor],
  )

  return useMemo(
    () => ({
      state: browsing?.state ?? null,
      rows,
      query,
      total,
      favourites,
      handleOpen,
      handleDismiss,
      handlePick,
      handleSelect,
      handleKey,
    }),
    [
      browsing,
      favourites,
      handleDismiss,
      handleKey,
      handleOpen,
      handlePick,
      handleSelect,
      query,
      rows,
      total,
    ],
  )
}
