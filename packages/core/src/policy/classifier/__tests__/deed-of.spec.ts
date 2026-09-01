import { describe, expect, it } from 'bun:test'

import { toCallId, toThreadId } from '../../../events/ids'
import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  type DeclaredPathField,
  type ToolCall,
} from '../../../tools/tool'
import { readCommand } from '../command/read-command'
import { EDeed, EDeedRealm, deedFingerprint, type Deed } from '../deed'
import { deedsOf, EPathDeclaration, type PathDeclarationView } from '../deed-of'

const PROJECT = '/Users/x/Developer/atlas'

const callTo = (args: { name: string; input: unknown; effect: EToolEffect }): ToolCall => ({
  callId: toCallId('call-1'),
  name: args.name,
  input: args.input,
  effect: args.effect,
  threadId: toThreadId('thread-1'),
})

const absolute = (content: EContentAccess): DeclaredPathField => ({
  field: 'path',
  presence: EPathPresence.Required,
  form: EPathForm.Absolute,
  content,
})

const deedsFrom = (args: {
  name: string
  input: unknown
  effect: EToolEffect
  declaration: PathDeclarationView
}): readonly Deed[] =>
  deedsOf({
    call: callTo({ name: args.name, input: args.input, effect: args.effect }),
    declaration: args.declaration,
    reading: undefined,
    projectDirectory: PROJECT,
  })

const bashDeeds = (command: string): readonly Deed[] =>
  deedsOf({
    call: callTo({ name: 'bash', input: { command }, effect: EToolEffect.Destructive }),
    declaration: { kind: EPathDeclaration.Declared, fields: [] },
    reading: readCommand({ command, workdir: undefined, projectDirectory: PROJECT }),
    projectDirectory: PROJECT,
  })

describe('deeds from a tool that declares its paths', () => {
  it('reads an overwriting field as one write of that absolute path', () => {
    const deeds = deedsFrom({
      name: 'write',
      input: { path: `${PROJECT}/notes.md`, content: 'x' },
      effect: EToolEffect.Write,
      declaration: {
        kind: EPathDeclaration.Declared,
        fields: [absolute(EContentAccess.Overwrites)],
      },
    })

    expect(deeds).toHaveLength(1)
    expect(deeds[0]?.action).toBe(EDeed.WriteFile)
    expect(deeds[0]?.targets).toEqual([{ realm: EDeedRealm.Path, value: `${PROJECT}/notes.md` }])
  })

  it('reads an amending field as a write too', () => {
    const deeds = deedsFrom({
      name: 'edit',
      input: { path: `${PROJECT}/notes.md` },
      effect: EToolEffect.Write,
      declaration: { kind: EPathDeclaration.Declared, fields: [absolute(EContentAccess.Amends)] },
    })

    expect(deeds[0]?.action).toBe(EDeed.WriteFile)
  })

  it('reads a reading field as one read-only deed', () => {
    const deeds = deedsFrom({
      name: 'read',
      input: { path: `${PROJECT}/notes.md` },
      effect: EToolEffect.Read,
      declaration: { kind: EPathDeclaration.Declared, fields: [absolute(EContentAccess.Reads)] },
    })

    expect(deeds).toHaveLength(1)
    expect(deeds[0]?.action).toBe(EDeed.ReadOnly)
    expect(deeds[0]?.targets).toEqual([{ realm: EDeedRealm.Path, value: `${PROJECT}/notes.md` }])
  })

  it('resolves a relative-to-base field against the project directory', () => {
    const deeds = deedsFrom({
      name: 'glob',
      input: { pattern: 'packages/**/*.ts' },
      effect: EToolEffect.Read,
      declaration: {
        kind: EPathDeclaration.Declared,
        fields: [
          {
            field: 'pattern',
            presence: EPathPresence.Required,
            form: EPathForm.RelativeToBase,
            content: EContentAccess.None,
          },
        ],
      },
    })

    expect(deeds[0]?.targets).toEqual([
      { realm: EDeedRealm.Path, value: `${PROJECT}/packages/**/*.ts` },
    ])
  })

  it('will not read a write field whose value never arrived', () => {
    const deeds = deedsFrom({
      name: 'write',
      input: { content: 'x' },
      effect: EToolEffect.Write,
      declaration: {
        kind: EPathDeclaration.Declared,
        fields: [absolute(EContentAccess.Overwrites)],
      },
    })

    expect(deeds[0]?.action).toBe(EDeed.Unreadable)
  })
})

describe('deeds from a tool that declares nothing useful', () => {
  it('refuses to classify a tool it does not know', () => {
    const deeds = deedsFrom({
      name: 'mcp__unknown__do',
      input: {},
      effect: EToolEffect.Write,
      declaration: { kind: EPathDeclaration.Unregistered },
    })

    expect(deeds).toHaveLength(1)
    expect(deeds[0]?.action).toBe(EDeed.Unreadable)
  })

  it('refuses to classify a registered tool that declares no path fields at all', () => {
    const deeds = deedsFrom({
      name: 'mystery',
      input: {},
      effect: EToolEffect.Write,
      declaration: { kind: EPathDeclaration.Undeclared },
    })

    expect(deeds[0]?.action).toBe(EDeed.Unreadable)
  })

  it('does not let an empty declaration make a destructive tool vacuously read-only', () => {
    const deeds = deedsOf({
      call: callTo({ name: 'bash', input: { command: 'x' }, effect: EToolEffect.Destructive }),
      declaration: { kind: EPathDeclaration.Declared, fields: [] },
      reading: undefined,
      projectDirectory: PROJECT,
    })

    expect(deeds[0]?.action).toBe(EDeed.Unreadable)
  })

  it('does not let a workdir field at no-content stand in for the paths bash touches', () => {
    const deeds = deedsOf({
      call: callTo({ name: 'bash', input: { workdir: PROJECT }, effect: EToolEffect.Destructive }),
      declaration: {
        kind: EPathDeclaration.Declared,
        fields: [
          {
            field: 'workdir',
            presence: EPathPresence.Optional,
            form: EPathForm.Absolute,
            content: EContentAccess.None,
          },
        ],
      },
      reading: undefined,
      projectDirectory: PROJECT,
    })

    expect(deeds[0]?.action).toBe(EDeed.Unreadable)
  })

  it('keeps a read-effect tool with no content fields read-only', () => {
    const deeds = deedsFrom({
      name: 'grep',
      input: { pattern: 'x' },
      effect: EToolEffect.Read,
      declaration: { kind: EPathDeclaration.Declared, fields: [] },
    })

    expect(deeds[0]?.action).toBe(EDeed.ReadOnly)
  })
})

describe('deeds from a bash call', () => {
  it('gives one deed per segment and never collapses them', () => {
    const deeds = bashDeeds(
      'git fetch origin && git worktree add .atlas/worktrees/x -b b origin/main',
    )

    expect(deeds.map((deed) => deed.action)).toEqual([EDeed.ReadOnly, EDeed.AddWorktree])
    expect(deeds.every((deed) => deed.toolName === 'bash')).toBe(true)
  })

  it('carries the cwd each segment would run in', () => {
    const deeds = bashDeeds('cd apps/tui && bun test x')

    expect(deeds.map((deed) => deed.action)).toEqual([EDeed.Routine, EDeed.Routine])
    expect(deeds.map((deed) => deed.cwd)).toEqual([PROJECT, `${PROJECT}/apps/tui`])
  })

  it('separates a dry run from the real thing inside one program', () => {
    expect(bashDeeds('git clean -ndx')[0]?.action).toBe(EDeed.ReadOnly)
    expect(bashDeeds('git clean -fdx')[0]?.action).toBe(EDeed.CleanUntracked)
    expect(bashDeeds('git stash list')[0]?.action).toBe(EDeed.ReadOnly)
    expect(bashDeeds('git stash drop')[0]?.action).toBe(EDeed.MutateStash)
  })

  it('collapses an unreadable command into one unreadable deed naming what it did read', () => {
    const deeds = bashDeeds('eval "$CMD" && rm -rf build')

    expect(deeds).toHaveLength(1)
    expect(deeds[0]?.action).toBe(EDeed.Unreadable)
    expect(deeds[0]?.summary).toContain('rm')
    expect(deeds[0]?.targets).toEqual([{ realm: EDeedRealm.Path, value: PROJECT }])
  })

  it('has nothing to say about an empty command', () => {
    expect(bashDeeds('')).toEqual([])
  })
})

describe('the deed fingerprint', () => {
  const base: Deed = {
    action: EDeed.RemovePath,
    toolName: 'bash',
    targets: [
      { realm: EDeedRealm.Path, value: '/a' },
      { realm: EDeedRealm.Path, value: '/b' },
    ],
    cwd: PROJECT,
    summary: 'removes files',
  }

  it('is stable across the order the targets arrived in', () => {
    const reversed: Deed = { ...base, targets: [...base.targets].reverse() }

    expect(deedFingerprint({ deed: reversed })).toBe(deedFingerprint({ deed: base }))
  })

  it('ignores the summary, which is prose over the same facts', () => {
    const reworded: Deed = { ...base, summary: 'deletes files' }

    expect(deedFingerprint({ deed: reworded })).toBe(deedFingerprint({ deed: base }))
  })

  it('separates two deeds that differ in realm, action, cwd or target', () => {
    const others: readonly Deed[] = [
      { ...base, action: EDeed.WriteFile },
      { ...base, cwd: '/elsewhere' },
      { ...base, targets: [{ realm: EDeedRealm.GitRef, value: '/a' }] },
      { ...base, toolName: 'write' },
    ]

    for (const other of others) {
      expect(deedFingerprint({ deed: other })).not.toBe(deedFingerprint({ deed: base }))
    }
  })
})
