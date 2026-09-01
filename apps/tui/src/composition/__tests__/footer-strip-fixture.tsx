import { KeyEvent } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import React, { useState } from 'react'

import { settle, teardown } from '../../ui/markdown/__tests__/harness'
import { EFooterItemReach, type FooterItem } from '../../ui/footer-item'
import { useDraft, type DraftControls } from '../../ui/hooks/use-draft'
import { useFooterStrip, type FooterStripControl } from '../use-footer-strip'

const RENDER_MS = 60

export const fired: string[] = []

export const item = (over: Partial<FooterItem> & { id: string }): FooterItem => ({
  spans: [{ text: over.id }],
  reach: EFooterItemReach.Keyboard,
  onActivate: () => fired.push(over.id),
  ...over,
})

export const BOTH = [item({ id: 'pr' }), item({ id: 'shells' })]

export const key = (over: { name?: string; sequence?: string; ctrl?: boolean }): KeyEvent =>
  new KeyEvent({
    name: over.name ?? '',
    ctrl: over.ctrl ?? false,
    meta: false,
    shift: false,
    option: false,
    sequence: over.sequence ?? '',
    number: false,
    raw: '',
    eventType: 'press',
    source: 'raw',
  })

export type Probe = {
  control: FooterStripControl | null
  draft: DraftControls | null
  setItems: ((items: readonly FooterItem[]) => void) | null
}

/**
 * `focused` mirrors `app.tsx`'s `focused={!overlaid}`, so the composer really does blur while the
 * row is entered and `handleEnter`'s own `editor.focused` guard is under test rather than assumed.
 */
function Strip(props: { initial: readonly FooterItem[]; probe: Probe }): React.ReactNode {
  const [items, setItems] = useState(props.initial)
  const draft = useDraft()
  const control = useFooterStrip({ items, draft })

  props.probe.control = control
  props.probe.draft = draft
  props.probe.setItems = setItems

  return <textarea ref={draft.editor} focused={control.state === null} height={3} />
}

export const controlOf = (probe: Probe): FooterStripControl => {
  if (probe.control === null) throw new Error('the probe never mounted')
  return probe.control
}

export const editorOf = (probe: Probe): { plainText: string; focused: boolean } => {
  const editor = probe.draft?.editor.current
  if (editor === undefined || editor === null) throw new Error('the composer never mounted')
  return editor
}

export async function mounted(initial: readonly FooterItem[]): Promise<{
  probe: Probe
  flush: () => Promise<void>
  done: () => Promise<void>
}> {
  fired.length = 0
  const probe: Probe = { control: null, draft: null, setItems: null }
  const setup = await testRender(<Strip initial={initial} probe={probe} />, {
    width: 60,
    height: 8,
  })
  await setup.flush()

  return {
    probe,
    flush: async () => {
      await settle(RENDER_MS)
      await setup.flush()
    },
    done: () => teardown(setup),
  }
}

export const typeInto = (probe: Probe, text: string): void => {
  const editor = probe.draft?.editor.current
  if (editor === undefined || editor === null) throw new Error('the composer never mounted')
  editor.replaceText(text)
  editor.cursorOffset = text.length
}
