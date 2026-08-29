import { EKeyGroup, EKeyLayer, type KeyBinding } from '../ui/keys'

export type GlobalHandlers = {
  draftIsEmpty: () => boolean
  onSubmit: () => void
  onShortcuts: () => void
  onTakeBackPending: () => boolean
  onInterrupt: () => void
  onNewConversation: () => void
  onOpenSwitcher: () => void
  onToggleSidebar: () => void
  onOpenShells: () => void
  onOpenSettings: () => void
  onOpenAccounts: () => void
  onQuit: () => void
}

const global = (binding: Omit<KeyBinding, 'layer'>): KeyBinding => ({
  ...binding,
  layer: EKeyLayer.Global,
})

export function globalBindings(handlers: GlobalHandlers): readonly KeyBinding[] {
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
      chord: 'ctrl+n',
      hint: 'new conversation',
      group: EKeyGroup.Session,
      run: handlers.onNewConversation,
    }),
    global({
      chord: 'ctrl+p',
      hint: 'model and effort',
      group: EKeyGroup.Session,
      run: handlers.onOpenSwitcher,
    }),
    global({
      chord: 'ctrl+b',
      hint: 'sidebar',
      group: EKeyGroup.Session,
      run: handlers.onToggleSidebar,
    }),
    global({
      chord: 'ctrl+t',
      hint: 'background shells',
      describe: 'list what is running in the background, read it, and stop it',
      group: EKeyGroup.Session,
      run: handlers.onOpenShells,
    }),
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
