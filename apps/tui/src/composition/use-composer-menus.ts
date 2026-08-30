import type { KeyEvent } from '@opentui/core'
import { useCallback, useMemo } from 'react'

import type { CommandSpec } from '@dltech/atlas-core'
import type { FileBrowser } from '@dltech/atlas-harness'

import type { CommandMenuState } from '../ui/command-menu-model'
import type { FileMenuState } from '../ui/file-menu-model'
import { useCommandMenu } from './use-command-menu'
import { useFileMenu } from './use-file-menu'

export type ComposerMenus = {
  command: CommandMenuState | null
  file: FileMenuState | null
  handleTextChanged: (text: string) => void
  handleKey: (key: KeyEvent) => boolean
  handleDismiss: () => void
}

export function useComposerMenus(args: {
  specs: readonly CommandSpec[]
  files?: FileBrowser | undefined
  onComplete: (text: string) => void
}): ComposerMenus {
  const { files, onComplete } = args

  const commands = useCommandMenu({ specs: args.specs, onComplete })
  const mentions = useFileMenu({ files, onComplete })

  const handleTextChanged = useCallback(
    (text: string) => {
      commands.handleTextChanged(text)
      mentions.handleTextChanged(text)
    },
    [commands, mentions],
  )

  const handleDismiss = useCallback(() => {
    commands.handleDismiss()
    mentions.handleDismiss()
  }, [commands, mentions])

  const handleKey = useCallback(
    (key: KeyEvent): boolean => commands.handleKey(key) || mentions.handleKey(key),
    [commands, mentions],
  )

  return useMemo(
    () => ({
      command: commands.state,
      file: mentions.state,
      handleTextChanged,
      handleKey,
      handleDismiss,
    }),
    [commands.state, handleDismiss, handleKey, handleTextChanged, mentions.state],
  )
}
