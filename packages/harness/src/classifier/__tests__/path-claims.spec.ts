import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  DEFAULT_CLASSIFIER_POLICY,
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  ETriage,
  TAKES_NO_PATHS,
  signalsFor,
  toCallId,
  toThreadId,
  triageOf,
  type CallEvidence,
  type DeclaredPathField,
  type ToolCall,
  type ToolDeclaration,
  type WorkspaceFacts,
} from '@dltech/atlas-core'

import { ECandidacy, prefilterOf } from '../prefilter'
import { toolLensFor } from '../tool-lens'
import { OURS, REPO, SIBLING, TOOLS, factsInAWorktree } from './fixtures'

const declarationOf = (args: {
  name: string
  effect: EToolEffect
  pathFields?: ToolDeclaration['pathFields'] | undefined
}): ToolDeclaration => ({
  name: args.name,
  description: args.name,
  effect: args.effect,
  inputSchema: z.unknown(),
  ...(args.pathFields === undefined ? {} : { pathFields: args.pathFields }),
})

const callTo = (args: { name: string; input: unknown; effect: EToolEffect }): ToolCall => ({
  callId: toCallId('call-1'),
  name: args.name,
  input: args.input,
  effect: args.effect,
  threadId: toThreadId('thread-1'),
})

function reading({
  tools,
  call,
  facts,
}: {
  tools: readonly ToolDeclaration[]
  call: ToolCall
  facts: WorkspaceFacts
}) {
  return toolLensFor({ tools }).readingFor({
    name: call.name,
    input: call.input,
    projectDirectory: facts.projectDirectory,
  })
}

function candidacyOf({
  tools,
  call,
  facts,
}: {
  tools: readonly ToolDeclaration[]
  call: ToolCall
  facts: WorkspaceFacts
}): ECandidacy {
  return prefilterOf({
    call,
    declaration: toolLensFor({ tools }).declarationFor(call.name),
    reading: reading({ tools, call, facts }),
    projectDirectory: facts.projectDirectory,
    events: [],
  }).candidacy
}

function evidenceOf({
  tools,
  call,
  facts,
}: {
  tools: readonly ToolDeclaration[]
  call: ToolCall
  facts: WorkspaceFacts
}): CallEvidence {
  const read = reading({ tools, call, facts })

  return {
    deeds: prefilterOf({
      call,
      declaration: toolLensFor({ tools }).declarationFor(call.name),
      reading: read,
      projectDirectory: facts.projectDirectory,
      events: [],
    }).deeds,
    toolName: call.name,
    effect: call.effect,
    threadId: call.threadId,
    reading: read,
    facts,
    recent: [],
    said: [],
    grants: [],
  }
}

const triageFor = (evidence: CallEvidence) =>
  triageOf({
    evidence,
    signals: signalsFor({ evidence }),
    policy: DEFAULT_CLASSIFIER_POLICY,
    asksSoFar: 0,
  })

const PATHLESS_TOOLS = [
  ['agent_spawn', EToolEffect.Write],
  ['agent_say', EToolEffect.Write],
  ['agent_resume', EToolEffect.Write],
  ['agent_stop', EToolEffect.Destructive],
  ['shell_kill', EToolEffect.Destructive],
] as const

describe('a tool that declares it touches no path of its own', () => {
  it('clears every call in phase A, with nothing left to consult about', () => {
    for (const [name, effect] of PATHLESS_TOOLS) {
      const tools = [declarationOf({ name, effect, pathFields: TAKES_NO_PATHS })]
      const call = callTo({ name, input: { agentId: 'agent-1' }, effect })
      const facts = factsInAWorktree()

      expect(candidacyOf({ tools, call, facts })).toBe(ECandidacy.Clear)
      expect(signalsFor({ evidence: evidenceOf({ tools, call, facts }) })).toEqual([])
    }
  })
})

describe('a tool that never said which paths it touches', () => {
  it('stays a candidate and keeps the blast signal that says so', () => {
    const tools = [declarationOf({ name: 'mystery', effect: EToolEffect.Destructive })]
    const call = callTo({ name: 'mystery', input: { target: 'x' }, effect: EToolEffect.Destructive })
    const facts = factsInAWorktree()

    expect(candidacyOf({ tools, call, facts })).toBe(ECandidacy.Candidate)
    expect(signalsFor({ evidence: evidenceOf({ tools, call, facts }) }).map((one) => one.id)).toContain(
      'blast:undeclared-paths',
    )
  })
})

describe('a tool that names a worktree path on some calls and not others', () => {
  const worktreePath: DeclaredPathField = {
    field: 'path',
    presence: EPathPresence.Optional,
    form: EPathForm.Absolute,
    content: EContentAccess.Amends,
  }

  const tools = [
    declarationOf({
      name: 'enter_worktree',
      effect: EToolEffect.Destructive,
      pathFields: [worktreePath],
    }),
  ]

  const enter = (input: unknown) =>
    callTo({ name: 'enter_worktree', input, effect: EToolEffect.Destructive })

  it('clears a call that names no path, because an optional field nobody filled names nothing', () => {
    const facts = factsInAWorktree()
    const call = enter({ name: 'eng-500-sidebar' })

    expect(candidacyOf({ tools, call, facts })).toBe(ECandidacy.Clear)
    expect(signalsFor({ evidence: evidenceOf({ tools, call, facts }) })).toEqual([])
  })

  it('consults when the path it names is a worktree carrying uncommitted work', () => {
    const facts = factsInAWorktree({ siblingChangedCount: 12 })
    const call = enter({ path: SIBLING })

    expect(candidacyOf({ tools, call, facts })).toBe(ECandidacy.Candidate)
    expect(triageFor(evidenceOf({ tools, call, facts })).triage).toBe(ETriage.Consult)
  })
})

describe('a fast-forward pull, which loses nothing in the tree it runs in', () => {
  const shell = (command: string) =>
    callTo({ name: 'bash', input: { command }, effect: EToolEffect.Destructive })

  it('clears in phase A when it runs in our own worktree', () => {
    const facts = factsInAWorktree()

    expect(candidacyOf({ tools: TOOLS, call: shell('git pull --ff-only'), facts })).toBe(
      ECandidacy.Clear,
    )
    expect(candidacyOf({ tools: TOOLS, call: shell(`git -C ${OURS} pull --ff-only`), facts })).toBe(
      ECandidacy.Clear,
    )
  })

  it('gathers evidence and consults when it reaches another agent worktree', () => {
    const facts = factsInAWorktree({ siblingChangedCount: 12 })
    const call = shell(`git -C ${SIBLING} pull --ff-only`)

    expect(candidacyOf({ tools: TOOLS, call, facts })).toBe(ECandidacy.Candidate)
    expect(triageFor(evidenceOf({ tools: TOOLS, call, facts })).triage).toBe(ETriage.Consult)
  })

  it('stays quiet on the main checkout, which the operator own instructions permit', () => {
    const facts = factsInAWorktree()
    const call = shell(`git -C ${REPO} pull --ff-only`)

    expect(triageFor(evidenceOf({ tools: TOOLS, call, facts })).triage).toBe(ETriage.Clear)
  })
})
