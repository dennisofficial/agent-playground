import { toThreadId, type ToolOutcome } from '@dltech/atlas-core'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'bun:test'

import { MultiEditTool } from '../multi-edit'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-multi-edit-'))
})

const invoke = (tool: MultiEditTool, input: unknown): Promise<ToolOutcome> =>
  tool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'multi-edit',
    projectDirectory: root,
    threadId: toThreadId('thread-1'),
  })

const fileHolding = async (args: { name: string; text: string }): Promise<string> => {
  const path = join(root, args.name)
  await writeFile(path, args.text)
  return path
}

const SOURCE = [
  'export function settingModelRef(args: {',
  '  id: ESettingId',
  '  settled: SettingsResolution',
  '}): ModelRef | undefined {',
  '  return args.settled.ref',
  '}',
  '',
  'export function rememberSettingModel(args: {',
  '  target: { id: ESettingId; withEffort: boolean }',
  '  selection: ModelSelection',
  '}): void {',
  '  args.settings.set({ id: args.target.id })',
  '}',
  '',
].join('\n')

describe('multi_edit', () => {
  it('applies every replacement in one call', async () => {
    const path = await fileHolding({ name: 'model-preference.ts', text: SOURCE })

    const outcome = await invoke(new MultiEditTool(), {
      path,
      edits: [
        { oldString: '  id: ESettingId\n  settled:', newString: '  id: string\n  settled:' },
        {
          oldString: '  target: { id: ESettingId; withEffort: boolean }',
          newString: '  target: { id: string; withEffort: boolean }',
        },
      ],
    })

    expect(outcome.ok).toBe(true)
    const content = await readFile(path, 'utf8')
    expect(content).toContain('  id: string\n  settled:')
    expect(content).toContain('  target: { id: string; withEffort: boolean }')
    expect(content).not.toContain('ESettingId')
  })

  it('reports one patch for the whole pass, before to after', async () => {
    const path = await fileHolding({ name: 'model-preference.ts', text: SOURCE })

    const outcome = await invoke(new MultiEditTool(), {
      path,
      edits: [
        { oldString: '  id: ESettingId\n  settled:', newString: '  id: string\n  settled:' },
        {
          oldString: '  target: { id: ESettingId; withEffort: boolean }',
          newString: '  target: { id: string; withEffort: boolean }',
        },
      ],
    })

    if (!outcome.ok) throw new Error(outcome.reason)
    const diff = (outcome.output as { diff: string }).diff
    expect(diff.match(/^--- /gm)).toHaveLength(1)
    expect(diff.match(/^-  id: ESettingId$/m)).not.toBeNull()
    expect(diff.match(/^\+  id: string$/m)).not.toBeNull()
    expect(diff.match(/^-  target: \{ id: ESettingId; withEffort: boolean \}$/m)).not.toBeNull()
    expect(diff.match(/^\+  target: \{ id: string; withEffort: boolean \}$/m)).not.toBeNull()
  })

  it('lets a later edit match what an earlier one wrote', async () => {
    const path = await fileHolding({ name: 'chain.ts', text: 'const a = 1\n' })

    const outcome = await invoke(new MultiEditTool(), {
      path,
      edits: [
        { oldString: 'const a = 1', newString: 'const b = 2' },
        { oldString: 'const b = 2', newString: 'const c = 3' },
      ],
    })

    expect(outcome.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('const c = 3\n')
  })

  it('writes nothing when one edit matches nothing, and says which one', async () => {
    const path = await fileHolding({ name: 'model-preference.ts', text: SOURCE })

    const outcome = await invoke(new MultiEditTool(), {
      path,
      edits: [
        { oldString: '  id: ESettingId\n  settled:', newString: '  id: string\n  settled:' },
        { oldString: 'not in the file', newString: 'anything' },
      ],
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.reason).toContain('Edit 2 of 2')
    expect(outcome.reason).toContain('not in the file')
    expect(await readFile(path, 'utf8')).toBe(SOURCE)
  })

  it('writes nothing when an edit is ambiguous without replaceAll', async () => {
    const path = await fileHolding({ name: 'dup.ts', text: 'foo\nbar\nfoo\n' })

    const outcome = await invoke(new MultiEditTool(), {
      path,
      edits: [{ oldString: 'foo', newString: 'baz' }],
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.reason).toContain('replaceAll')
    expect(await readFile(path, 'utf8')).toBe('foo\nbar\nfoo\n')
  })

  it('honors replaceAll on one edit without asking it of the others', async () => {
    const path = await fileHolding({ name: 'dup.ts', text: 'foo\nbar\nfoo\n' })

    const outcome = await invoke(new MultiEditTool(), {
      path,
      edits: [
        { oldString: 'foo', newString: 'baz', replaceAll: true },
        { oldString: 'bar', newString: 'qux' },
      ],
    })

    expect(outcome.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('baz\nqux\nbaz\n')
  })

  it('refuses an edit that would change nothing', async () => {
    const path = await fileHolding({ name: 'same.ts', text: 'const a = 1\n' })

    const outcome = await invoke(new MultiEditTool(), {
      path,
      edits: [{ oldString: 'const a = 1', newString: 'const a = 1' }],
    })

    expect(outcome.ok).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('const a = 1\n')
  })

  it('refuses to create a file, pointing at the tools that do', async () => {
    const outcome = await invoke(new MultiEditTool(), {
      path: join(root, 'fresh.ts'),
      edits: [{ oldString: '', newString: 'const a = 1\n' }],
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.reason).toContain('write')
  })

  it('keeps CRLF endings across the whole pass', async () => {
    const path = await fileHolding({ name: 'dos.ts', text: 'const a = 1\r\nconst b = 2\r\n' })

    const outcome = await invoke(new MultiEditTool(), {
      path,
      edits: [
        { oldString: 'const a = 1', newString: 'const a = 10' },
        { oldString: 'const b = 2', newString: 'const b = 20' },
      ],
    })

    expect(outcome.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('const a = 10\r\nconst b = 20\r\n')
  })

  it('resolves a relative path against the project directory', async () => {
    await fileHolding({ name: 'rel.ts', text: 'const a = 1\n' })

    const outcome = await invoke(new MultiEditTool(), {
      path: 'rel.ts',
      edits: [{ oldString: '1', newString: '2' }],
    })

    expect(outcome.ok).toBe(true)
    expect(await readFile(join(root, 'rel.ts'), 'utf8')).toBe('const a = 2\n')
  })
})
