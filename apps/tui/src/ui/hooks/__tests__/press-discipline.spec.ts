import { Glob } from 'bun'
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', '..', '..')

const RAW_MOUSE = /on(?:MouseDown|MouseUp|MouseDrag|Mouse(?![A-Za-z]))/

/**
 * `usePress` owns the press, and the scrollbar owns the drag. Everything else that reacts to a
 * click goes through the hook, so the renderer's selection anchor is always cleared behind it.
 */
const RAW_MOUSE_BELONGS_TO = new Set([
  'ui/hooks/use-press.ts',
  'ui/markdown/pan-bar.tsx',
])

describe('press discipline', () => {
  it('leaves the raw mouse to usePress and the scrollbar, so no click strands a selection', async () => {
    const wired: string[] = []

    for await (const file of new Glob('**/*.{ts,tsx}').scan({ cwd: SRC })) {
      if (file.includes('__tests__')) continue
      if (RAW_MOUSE_BELONGS_TO.has(file)) continue
      if (RAW_MOUSE.test(await Bun.file(join(SRC, file)).text())) wired.push(file)
    }

    expect(wired.sort()).toEqual([])
  })
})
