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

/** Which of the two model preferences a pick lands on. */
export enum EModelScope {
  Thread = 'thread',
  Default = 'default',
}

export type SwitcherControl = {
  state: SwitcherState | null
  scope: EModelScope
  rows: readonly SwitcherRow[]
  query: string
  total: number
  favourites: readonly string[]
  handleOpen: (scope?: EModelScope) => void
  handleDismiss: () => void
  handlePick: (choice: SwitcherChoice) => void
  handleSelect: (index: number) => void
  handleQuery: (typed: string) => void
  handleKey: (key: KeyEvent) => void
}

type Browsing = { state: SwitcherState; query: string; scope: EModelScope }

const PIN_KEY = '*'

/**
 * OpenTUI parses a whole input burst before React re-renders, so the run of key events a typed word
 * arrives as would all read the same rendered query. The ref is what the handlers read and write;
 * React state exists to draw it.
 */
export function useSwitcher(args: {
  catalogue: ModelCatalogue
  active: ModelRef
  effort: EEffort
  /** Where the highlight starts when the picker is set on the default rather than the thread. */
  fallback: { ref: ModelRef; effort: EEffort }
  favourites: readonly string[]
  onPick: (args: { choice: SwitcherChoice; scope: EModelScope }) => void
  onPin: (favourites: readonly string[]) => void
}): SwitcherControl {
  const held = useRef<Browsing | null>(null)
  const [browsing, setBrowsing] = useState<Browsing | null>(null)
  const { catalogue, active, effort, fallback, favourites, onPick, onPin } = args

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
    (scope: EModelScope = EModelScope.Thread) => {
      const anchor = scope === EModelScope.Default ? fallback : { ref: active, effort }

      put({
        query: '',
        scope,
        state: openSwitcher({
          providers: catalogue.providers,
          active: anchor.ref,
          effort: anchor.effort,
          availability: catalogue.reachable,
          favourites,
        }),
      })
    },
    [active, catalogue, effort, fallback, favourites, put],
  )

  const handleDismiss = useCallback(() => put(null), [put])

  const handlePick = useCallback(
    (choice: SwitcherChoice) => {
      const scope = held.current?.scope ?? EModelScope.Thread
      put(null)
      onPick({ choice, scope })
    },
    [onPick, put],
  )

  const handleQuery = useCallback(
    (typed: string) => {
      const current = held.current
      if (current === null) return

      const following = selectedCard({
        state: current.state,
        rows: rowsFor(current.query),
      })?.ref

      put({
        ...current,
        query: typed,
        state: anchorOn({
          rows: rowsFor(typed),
          active: following,
          effort: current.state.effort,
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
        key.preventDefault()
        handleDismiss()
        return
      }

      if (key.name === 'return') {
        key.preventDefault()
        handlePick(resolve({ state: current.state, rows: laid }))
        return
      }

      if (key.name === 'up' || key.name === 'down') {
        key.preventDefault()
        const delta = key.name === 'up' ? -1 : 1
        put({ ...current, state: moveSelection({ state: current.state, delta, rows: laid }) })
        return
      }

      if (key.name === 'left' || key.name === 'right') {
        key.preventDefault()
        const delta = key.name === 'left' ? -1 : 1
        put({ ...current, state: adjustEffort({ state: current.state, delta, rows: laid }) })
        return
      }

      if (key.sequence === PIN_KEY && !key.ctrl && !key.meta) {
        key.preventDefault()
        handlePin(current)
      }
    },
    [handleDismiss, handlePick, handlePin, put, rowsFor],
  )

  return useMemo(
    () => ({
      state: browsing?.state ?? null,
      scope: browsing?.scope ?? EModelScope.Thread,
      rows,
      query,
      total,
      favourites,
      handleOpen,
      handleDismiss,
      handlePick,
      handleSelect,
      handleQuery,
      handleKey,
    }),
    [
      browsing,
      favourites,
      handleDismiss,
      handleKey,
      handleOpen,
      handlePick,
      handleQuery,
      handleSelect,
      query,
      rows,
      total,
    ],
  )
}
