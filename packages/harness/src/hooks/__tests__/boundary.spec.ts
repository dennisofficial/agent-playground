import { mkdtemp, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  EBeforeToolDecision,
  EStage,
  EToolEffect,
  toCallId,
  type BeforeTool,
  type ToolCall,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { createBashTool } from '../../tools/builtin/bash'
import { createEditTool } from '../../tools/builtin/edit'
import { createGlobTool } from '../../tools/builtin/glob'
import { createGrepTool } from '../../tools/builtin/grep'
import { createReadTool } from '../../tools/builtin/read'
import { createWriteTool } from '../../tools/builtin/write'
import { createBoundaryHook } from '../boundary'
import { createHookRegistry } from '../registry'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-boundary-'))
  await symlink('/etc', join(root, 'link-to-etc'))
})

const undeclaredTool: ToolDeclaration = {
  name: 'mcp-filesystem',
  description: 'an MCP tool that never said which of its inputs hold paths',
  effect: EToolEffect.Write,
  inputSchema: z.strictObject({ path: z.string() }),
}

const toolsRootedAt = (workspace: string): readonly ToolDeclaration[] => [
  createReadTool(),
  createWriteTool(),
  createEditTool(),
  createBashTool({ root: workspace }),
  createGrepTool({ root: workspace }),
  createGlobTool({ root: workspace }),
  undeclaredTool,
]

const callTo = ({ name, input }: { name: string; input: unknown }): ToolCall => ({
  callId: toCallId('call-1'),
  name,
  input,
  effect: EToolEffect.Read,
})

const boundary = () => createBoundaryHook({ root, tools: toolsRootedAt(root) })

const decide = async ({ name, input }: { name: string; input: unknown }) =>
  boundary().run({ call: callTo({ name, input }) })

describe('createBoundaryHook', () => {
  it('allows a read inside the workspace, passing the input through untouched', async () => {
    const input = { path: join(root, 'src', 'a.ts'), offset: 2 }

    expect(await decide({ name: 'read', input })).toEqual({
      decision: EBeforeToolDecision.Allow,
      input,
    })
  })

  it('denies a read outside the workspace, naming the offending path in the reason', async () => {
    const outcome = await decide({ name: 'read', input: { path: '/etc/passwd' } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
    expect(outcome).toMatchObject({ reason: expect.stringContaining('/etc/passwd') })
  })

  it('denies a traversal that climbs out of the workspace', async () => {
    const outcome = await decide({
      name: 'write',
      input: { path: join(root, '..', '..', 'etc', 'passwd'), content: 'x' },
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('denies a sibling directory whose name merely starts with the root', async () => {
    const outcome = await decide({ name: 'read', input: { path: `${root}-evil/secrets.txt` } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('allows the workspace root itself', async () => {
    const outcome = await decide({ name: 'glob', input: { pattern: '**/*.ts', path: root } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('denies a path that only escapes once its symlinks are resolved', async () => {
    const throughLink = join(root, 'link-to-etc', 'passwd')

    expect(throughLink.startsWith(`${root}${sep}`)).toBe(true)

    const outcome = await decide({ name: 'read', input: { path: throughLink } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('allows a write to a file that does not exist yet inside the workspace', async () => {
    const outcome = await decide({
      name: 'write',
      input: { path: join(root, 'nested', 'deeper', 'brand-new.ts'), content: 'x' },
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('allows bash, which declares no path fields and whose command this hook does not inspect', async () => {
    const outcome = await decide({ name: 'bash', input: { command: 'cat /etc/passwd' } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('denies a tool it has no declaration for at all', async () => {
    const outcome = await decide({ name: 'some-mcp-tool', input: { path: join(root, 'a.ts') } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('denies a tool that has not declared its path fields, even for a path inside the workspace', async () => {
    const outcome = await decide({ name: 'mcp-filesystem', input: { path: join(root, 'a.ts') } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
    expect(outcome).toMatchObject({ reason: expect.stringContaining('declare') })
  })

  it('allows grep and glob to omit their optional path, which means the root', async () => {
    expect((await decide({ name: 'grep', input: { pattern: 'todo' } })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
    expect((await decide({ name: 'glob', input: { pattern: '**/*.ts' } })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
  })

  it('still denies a required path it cannot check, defending in depth behind the schema parse', async () => {
    expect((await decide({ name: 'read', input: {} })).decision).toBe(EBeforeToolDecision.Deny)
    expect((await decide({ name: 'edit', input: { path: 42 } })).decision).toBe(
      EBeforeToolDecision.Deny,
    )
    expect((await decide({ name: 'write', input: 'not an object' })).decision).toBe(
      EBeforeToolDecision.Deny,
    )
  })

  it('still denies an optional path that is not a string, which the schema parse now catches first', async () => {
    const outcome = await decide({ name: 'grep', input: { pattern: 'todo', path: ['/etc'] } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('sorts ahead of every other before-tool hook once registered', async () => {
    const permissive: BeforeTool = async ({ call }) => ({
      decision: EBeforeToolDecision.Allow,
      input: call.input,
    })

    const registry = createHookRegistry({
      beforeTool: [
        { name: 'approvalPolicy', order: { stage: EStage.Policy, nudge: 0 }, run: permissive },
        { name: 'anotherGuard', order: { stage: EStage.Guard, nudge: 10 }, run: permissive },
        boundary(),
      ],
    })

    expect(registry.beforeTool.map((hook) => hook.name)).toEqual([
      'workspaceBoundary',
      'anotherGuard',
      'approvalPolicy',
    ])
  })

  it('treats an explicit undefined path as absent, which is what an optional field means', async () => {
    expect((await decide({ name: 'glob', input: { pattern: '*', path: undefined } })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
    expect((await decide({ name: 'read', input: { path: undefined } })).decision).toBe(
      EBeforeToolDecision.Deny,
    )
  })

  it('denies a path carrying a NUL byte, rather than trusting the runtime to reject it', async () => {
    const inside = `${join(root, 'a')}\0b`

    expect(resolve(inside).startsWith(`${root}${sep}`)).toBe(true)

    const outcome = await decide({ name: 'read', input: { path: inside } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('denies a relative path by saying so, not by where the process happens to be', async () => {
    const outcome = await decide({ name: 'read', input: { path: 'a.ts' } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
    expect(outcome).toMatchObject({ reason: expect.stringContaining('absolute') })
  })

  it('allows a path written through the real path of a root that is itself a symlink', async () => {
    const realRoot = await realpath(root)
    const throughRealRoot = join(realRoot, 'src', 'a.ts')

    expect(realRoot).not.toBe(root)
    expect(throughRealRoot.startsWith(`${root}${sep}`)).toBe(false)

    const outcome = await decide({ name: 'read', input: { path: throughRealRoot } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('denies a glob pattern that climbs out of the workspace with ..', async () => {
    const outcome = await decide({ name: 'glob', input: { pattern: '../*.txt' } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('denies an absolute glob pattern, which ignores the scan root entirely', async () => {
    const outcome = await decide({ name: 'glob', input: { pattern: '/etc/hos*' } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('denies a glob pattern that escapes from the path it was given', async () => {
    const outcome = await decide({
      name: 'glob',
      input: { path: join(root, 'src'), pattern: '../../../etc/*' },
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('allows a glob pattern whose .. cancels back inside the workspace', async () => {
    expect((await decide({ name: 'glob', input: { pattern: 'sub/../*.ts' } })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
    expect((await decide({ name: 'glob', input: { pattern: '**/*.ts' } })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
  })
})
