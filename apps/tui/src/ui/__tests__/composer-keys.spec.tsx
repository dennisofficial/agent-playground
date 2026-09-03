import type { TextareaRenderable } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { Composer } from '../components/composer'
import { useDraft, type DraftControls } from '../hooks/use-draft'
import { grammarsReady, teardown } from '../markdown/__tests__/harness'
import { drawn, HEIGHT } from './transcript-fixture'

await grammarsReady()

const WIDTH = 45

const PROSE = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'

function Probe(props: {
  text: string
  capture: (draft: DraftControls) => void
}): React.ReactNode {
  const draft = useDraft(props.text)
  props.capture(draft)
  return <Composer draft={draft} width={WIDTH} />
}

async function mountDraft(text: string): Promise<{
  setup: Awaited<ReturnType<typeof testRender>>
  editor: TextareaRenderable
}> {
  let draft: DraftControls | null = null
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <Probe
        text={text}
        capture={(controls) => {
          draft = controls
        }}
      />
    </box>,
    { width: WIDTH, height: HEIGHT, kittyKeyboard: true },
  )
  await drawn(setup)
  const editor = (draft as DraftControls | null)?.editor.current
  if (!editor) throw new Error('the composer never mounted')
  return { setup, editor }
}

describe('super+backspace in the composer', () => {
  it('rubs out the wrapped row rather than the whole paragraph', async () => {
    const { setup, editor } = await mountDraft(PROSE)
    try {
      expect(editor.plainText).toBe(PROSE)

      const end = editor.cursorOffset
      editor.gotoVisualLineHome()
      const rowStart = editor.cursorOffset
      expect(rowStart).toBeGreaterThan(0)
      editor.cursorOffset = end

      setup.mockInput.pressBackspace({ super: true })

      expect(editor.plainText).toBe(PROSE.slice(0, rowStart))
    } finally {
      await teardown(setup)
    }
  })

  it('still rubs out to a real line start when the draft has newlines', async () => {
    const text = `first line\nsecond line that is long enough to wrap at this width and keep going`
    const { setup, editor } = await mountDraft(text)
    try {
      const end = editor.cursorOffset
      editor.gotoVisualLineHome()
      const rowStart = editor.cursorOffset
      expect(rowStart).toBeGreaterThan('first line\n'.length)
      editor.cursorOffset = end

      setup.mockInput.pressBackspace({ super: true })

      expect(editor.plainText).toBe(text.slice(0, rowStart))
    } finally {
      await teardown(setup)
    }
  })

  it('steps back one character at a row start instead of eating the paragraph', async () => {
    const { setup, editor } = await mountDraft(PROSE)
    try {
      editor.gotoVisualLineHome()
      const rowStart = editor.cursorOffset
      expect(rowStart).toBeGreaterThan(0)

      setup.mockInput.pressBackspace({ super: true })

      expect(editor.plainText).toBe(PROSE.slice(0, rowStart - 1) + PROSE.slice(rowStart))
    } finally {
      await teardown(setup)
    }
  })

  it('takes the selection whole rather than reaching for the row start', async () => {
    const { setup, editor } = await mountDraft(PROSE)
    try {
      const end = editor.cursorOffset
      editor.setSelection(end - 5, end)

      setup.mockInput.pressBackspace({ super: true })

      expect(editor.plainText).toBe(PROSE.slice(0, end - 5))
    } finally {
      await teardown(setup)
    }
  })

  it('leaves a bare backspace deleting one character at a time', async () => {
    const { setup, editor } = await mountDraft(PROSE)
    try {
      setup.mockInput.pressBackspace()

      expect(editor.plainText).toBe(PROSE.slice(0, -1))
    } finally {
      await teardown(setup)
    }
  })
})
