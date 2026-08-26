import { mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EStage,
  EToolEffect,
  toCallId,
  type BeforeTool,
  type ToolCall,
} from '@dltech/atlas-core'

import { createBoundaryHook } from '../boundary'
import { createHookRegistry } from '../registry'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-boundary-'))
  await symlink('/etc', join(root, 'link-to-etc'))
})

const callTo = ({ name, input }: { name: string; input: unknown }): ToolCall => ({
  callId: toCallId('call-1'),
  name,
  input,
  effect: EToolEffect.Read,
})

const decide = async ({ name, input }: { name: string; input: unknown }) =>
  createBoundaryHook({ root }).run({ call: callTo({ name, input }) })

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

  it('allows bash, whose command this hook deliberately does not inspect', async () => {
    const outcome = await decide({ name: 'bash', input: { command: 'cat /etc/passwd' } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('allows a tool it does not recognise, paths being all it claims to police', async () => {
    const outcome = await decide({ name: 'some-mcp-tool', input: { path: '/etc/passwd' } })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
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
        createBoundaryHook({ root }),
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
})
