import { EKeyGroup, EKeyLayer, type KeyBinding } from '../ui/keys'

export type GlobalHandlers = {
  draftIsEmpty: () => boolean
  onSubmit: () => void
  onShortcuts: () => void
  onTakeBackPending: () => boolean
  onEnterFooterStrip: () => boolean
  onInterrupt: () => void
  onOpenSwitcher: () => void
  onNewConversation: () => void
  onAttachImage: () => boolean
  onToggleSidebar: (() => void) | null
  onOpenShells: () => void
  onCycleAgents: (() => void) | null
  onOpenSettings: () => void
  onOpenAccounts: () => void
  onQuit: () => void
}

const global = (binding: Omit<KeyBinding, 'layer'>): KeyBinding => ({
  ...binding,
  layer: EKeyLayer.Global,
})

/**
 * The sidebar toggle is absent, not inert, while the sidebar is docked: a chord the shortcuts list
 * advertises has to do something when it is pressed. The sub-agent walk is absent on the same
 * grounds, whenever the conversation has spawned nobody to walk.
 */
export function globalBindings(handlers: GlobalHandlers): readonly KeyBinding[] {
  const { onCycleAgents, onToggleSidebar } = handlers

  return [
    global({
      chord: 'return',
      hint: 'send',
      describe: 'send — or open the newest block when the draft is empty',
      group: EKeyGroup.Composer,
      run: handlers.onSubmit,
    }),
    global({
      chord: '?',
      hint: 'shortcuts',
      describe: 'this list, on an empty draft',
      group: EKeyGroup.Composer,
      run: () => {
        if (!handlers.draftIsEmpty()) return false

        handlers.onShortcuts()
        return true
      },
    }),
    global({
      chord: 'up',
      hint: 'take back',
      describe: 'take the last queued message back into the draft',
      group: EKeyGroup.Composer,
      run: () => handlers.draftIsEmpty() && handlers.onTakeBackPending(),
    }),
    global({
      chord: 'down',
      hint: 'chrome',
      describe: 'step into the row under the composer from the last line of the draft',
      group: EKeyGroup.Composer,
      run: handlers.onEnterFooterStrip,
    }),
    global({
      chord: 'ctrl+v',
      hint: 'paste image',
      describe: 'write the picture on the clipboard into the draft — ⌘V pastes only text',
      group: EKeyGroup.Composer,
      run: handlers.onAttachImage,
    }),
    global({
      chord: 'ctrl+n',
      hint: 'new conversation',
      describe: 'start a fresh conversation — same as /new',
      group: EKeyGroup.Session,
      run: handlers.onNewConversation,
    }),
    global({
      chord: 'ctrl+p',
      hint: 'model and effort',
      group: EKeyGroup.Session,
      run: handlers.onOpenSwitcher,
    }),
    ...(onToggleSidebar === null
      ? []
      : [
          global({
            chord: 'ctrl+b',
            hint: 'sidebar',
            describe: 'open the sidebar over the transcript — escape closes it',
            group: EKeyGroup.Session,
            run: onToggleSidebar,
          }),
        ]),
    global({
      chord: 'ctrl+t',
      hint: 'background shells',
      describe: 'list what is running in the background, read it, and stop it',
      group: EKeyGroup.Session,
      run: handlers.onOpenShells,
    }),
    ...(onCycleAgents === null
      ? []
      : [
          global({
            chord: 'ctrl+g',
            hint: 'sub-agents',
            describe: 'walk to the next sub-agent and read it — again to come back to the parent',
            group: EKeyGroup.Session,
            run: onCycleAgents,
          }),
        ]),
    global({
      chord: 'ctrl+o',
      hint: 'settings',
      group: EKeyGroup.Session,
      run: handlers.onOpenSettings,
    }),
    global({
      chord: 'ctrl+a',
      hint: 'accounts',
      describe: 'sign in, switch account, or remove one',
      group: EKeyGroup.Session,
      run: handlers.onOpenAccounts,
    }),
    global({
      chord: 'escape',
      hint: 'interrupt',
      group: EKeyGroup.Turn,
      run: handlers.onInterrupt,
    }),
    global({
      chord: 'ctrl+c',
      hint: 'quit',
      group: EKeyGroup.Turn,
      run: handlers.onQuit,
    }),
  ]
}
