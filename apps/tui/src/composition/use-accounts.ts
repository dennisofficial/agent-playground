import { decodePasteBytes, stripAnsiSequences, type KeyEvent, type PasteEvent } from '@opentui/core'
import { usePaste } from '@opentui/react'
import { useCallback, useMemo, useRef, useState } from 'react'

import { EAuthProvider, type Account, type AccountId } from '@dltech/atlas-core'
import type { AccountsService, LoginTicket, UrlOpener } from '@dltech/atlas-harness'

import {
  accountRows,
  askForApiKey,
  askForCode,
  backspace,
  backToList,
  EAccountsView,
  failed,
  isPrompting,
  moveSelection,
  openAccounts,
  selectedRow,
  typeInto,
  withRows,
  working,
  type AccountRow,
  type AccountsState,
} from '../ui/accounts-model'

export type AccountsControl = {
  state: AccountsState | null
  handleOpen: (notice?: string) => void
  handleDismiss: () => void
  handlePick: (row: AccountRow) => void
  handleKey: (key: KeyEvent) => void
  handleOpenUrl: () => void
}

const PROVIDERS: readonly EAuthProvider[] = [
  EAuthProvider.Anthropic,
  EAuthProvider.OpenAI,
  EAuthProvider.OpenRouter,
]

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'the request failed'

const isPrintable = (key: KeyEvent): boolean => {
  const sequence = key.sequence ?? ''
  return sequence.length > 0 && !key.ctrl && !key.meta && !/[\u0000-\u001f]/.test(sequence)
}

/**
 * A terminal in bracketed-paste mode wraps the clipboard in ESC[200~ … ESC[201~, and OpenTUI's
 * stdin parser lifts that whole run out of the key stream into a paste event. A prompt that only
 * listens for keypresses therefore never sees a pasted code at all.
 */
const pastedText = (event: PasteEvent): string =>
  stripAnsiSequences(decodePasteBytes(event.bytes)).replace(/[\r\n]/g, '').trim()

const providerOf = (state: AccountsState): EAuthProvider =>
  selectedRow(state)?.account.provider ?? EAuthProvider.Anthropic

/**
 * OpenTUI parses a whole input burst before React re-renders, so a pasted code arrives as a run of
 * key events that would all read the same rendered state. The ref is what the handlers read and
 * write; React state exists to draw it.
 */
export function useAccounts(args: {
  accounts: AccountsService
  openUrl: UrlOpener
}): AccountsControl {
  const { accounts, openUrl } = args
  const held = useRef<AccountsState | null>(null)
  const [state, setState] = useState<AccountsState | null>(null)
  const ticket = useRef<LoginTicket | null>(null)

  const put = useCallback((next: AccountsState | null) => {
    held.current = next
    setState(next)
  }, [])

  const rows = useCallback(async (): Promise<readonly AccountRow[]> => {
    const stored = await accounts.list()
    const active: Partial<Record<EAuthProvider, AccountId | undefined>> = {}

    for (const provider of PROVIDERS) active[provider] = await accounts.activeFor(provider)

    return accountRows({ accounts: stored, active })
  }, [accounts])

  const handleOpen = useCallback(
    (notice?: string) => {
      void rows().then((loaded) =>
        put(openAccounts({ rows: loaded, ...(notice === undefined ? {} : { notice }) })),
      )
    },
    [put, rows],
  )

  const handleDismiss = useCallback(() => {
    ticket.current = null
    put(null)
  }, [put])

  const refresh = useCallback(
    (change: (state: AccountsState) => AccountsState = (current) => current) => {
      void rows().then((loaded) => {
        const current = held.current
        if (current === null) return

        put(change(withRows({ state: current, rows: loaded })))
      })
    },
    [put, rows],
  )

  const handlePick = useCallback(
    (row: AccountRow) => {
      void accounts
        .use({ provider: row.account.provider, accountId: row.account.id })
        .then(() => refresh())
    },
    [accounts, refresh],
  )

  const beginLogin = useCallback(
    (current: AccountsState) => {
      try {
        const begun = accounts.begin(providerOf(current))
        ticket.current = begun
        put(askForCode({ state: current, prompt: { provider: begun.provider, url: begun.url } }))
        openUrl(begun.url)
      } catch (error) {
        put(failed({ state: current, reason: reasonOf(error) }))
      }
    },
    [accounts, openUrl, put],
  )

  const handleOpenUrl = useCallback(() => {
    const url = held.current?.prompt?.url
    if (url === undefined || url.length === 0) return

    openUrl(url)
  }, [openUrl])

  const removeSelected = useCallback(
    (current: AccountsState) => {
      const row = selectedRow(current)
      if (row === undefined) return

      void accounts.remove(row.account.id).then(() => refresh())
    },
    [accounts, refresh],
  )

  const submit = useCallback(
    (current: AccountsState) => {
      const pasted = current.typed.trim()
      if (pasted.length === 0 || current.busy) return

      const open = ticket.current
      const provider = current.prompt?.provider ?? EAuthProvider.Anthropic

      const signIn: Promise<Account> =
        current.view === EAccountsView.ApiKey || open === null
          ? accounts.addApiKey({ provider, apiKey: pasted })
          : accounts.complete({ ticket: open, pasted })

      put(working(current))

      void signIn
        .then((account) => {
          ticket.current = null
          refresh((next) => ({ ...backToList(next), notice: `Signed in as ${account.label}.` }))
        })
        .catch((error: unknown) => {
          const next = held.current
          if (next !== null) put(failed({ state: next, reason: reasonOf(error) }))
        })
    },
    [accounts, put, refresh],
  )

  const handleListKey = useCallback(
    (key: KeyEvent, current: AccountsState) => {
      if (key.name === 'escape') {
        handleDismiss()
        return
      }

      if (key.name === 'up' || key.name === 'down') {
        put(moveSelection({ state: current, delta: key.name === 'up' ? -1 : 1 }))
        return
      }

      if (key.name === 'return') {
        const row = selectedRow(current)
        if (row !== undefined) handlePick(row)
        return
      }

      if (key.sequence === 'n') {
        beginLogin(current)
        return
      }

      if (key.sequence === 'k') {
        put(askForApiKey({ state: current, provider: providerOf(current) }))
        return
      }

      if (key.sequence === 'x' || key.name === 'delete') removeSelected(current)
    },
    [beginLogin, handleDismiss, handlePick, put, removeSelected],
  )

  const handlePromptKey = useCallback(
    (key: KeyEvent, current: AccountsState) => {
      if (key.name === 'escape') {
        ticket.current = null
        put(backToList(current))
        return
      }

      if (key.name === 'return') {
        submit(current)
        return
      }

      if (key.name === 'backspace') {
        put(backspace(current))
        return
      }

      if (isPrintable(key)) put(typeInto({ state: current, text: key.sequence ?? '' }))
    },
    [put, submit],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      const current = held.current
      if (current === null) return

      if (current.view === EAccountsView.List) {
        handleListKey(key, current)
        return
      }

      handlePromptKey(key, current)
    },
    [handleListKey, handlePromptKey],
  )

  usePaste(
    useCallback(
      (event: PasteEvent) => {
        const current = held.current
        if (current === null || !isPrompting(current)) return

        const pasted = pastedText(event)
        if (pasted.length === 0) return

        event.preventDefault()
        event.stopPropagation()
        put(typeInto({ state: current, text: pasted }))
      },
      [put],
    ),
  )

  return useMemo(
    () => ({ state, handleOpen, handleDismiss, handlePick, handleKey, handleOpenUrl }),
    [handleDismiss, handleKey, handleOpen, handleOpenUrl, handlePick, state],
  )
}
