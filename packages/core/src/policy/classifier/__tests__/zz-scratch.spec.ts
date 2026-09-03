import { describe, expect, it } from 'bun:test'

import { toCallId, toThreadId } from '../../../events/ids'
import { EToolEffect, type ToolCall } from '../../../tools/tool'
import { EPathDeclaration, deedsOf } from '../deed-of'
import { signalsFor } from '../signals'
import { bashEvidence, inAWorktree, onMain, triageFor, SIBLING } from './fixtures'
import type { CallEvidence } from '../evidence'

const SEVEN = [
  ['agent_spawn', EToolEffect.Write],
  ['agent_say', EToolEffect.Write],
  ['agent_resume', EToolEffect.Write],
  ['agent_stop', EToolEffect.Destructive],
  ['shell_kill', EToolEffect.Destructive],
  ['enter_worktree', EToolEffect.Destructive],
  ['exit_worktree', EToolEffect.Destructive],
] as const

function ev({ name, effect }: { name: string; effect: EToolEffect }): CallEvidence {
  const facts = onMain()
  const call: ToolCall = {
    callId: toCallId('c'),
    name,
    input: { path: SIBLING },
    effect,
    threadId: toThreadId('t'),
  }
  return {
    deeds: deedsOf({
      call,
      declaration: { kind: EPathDeclaration.Declared, fields: [] },
      reading: undefined,
      projectDirectory: facts.projectDirectory,
    }),
    toolName: name,
    effect,
    threadId: toThreadId('t'),
    reading: undefined,
    facts,
    recent: [],
    said: [],
    grants: [],
  }
}

describe('scratch', () => {
  for (const [name, effect] of SEVEN) {
    it(`reports ${name}`, () => {
      const evidence = ev({ name, effect })
      console.log(name, JSON.stringify(evidence.deeds), JSON.stringify(signalsFor({ evidence })), triageFor({ evidence }).triage)
      expect(true).toBe(true)
    })
  }

  it('git pull ff-only into a sibling', () => {
    const evidence = bashEvidence({ command: `git -C ${SIBLING} pull --ff-only`, facts: inAWorktree({ siblingChangedCount: 4 }) })
    console.log('deeds', JSON.stringify(evidence.deeds))
    console.log('signals', JSON.stringify(signalsFor({ evidence })))
    console.log('triage', triageFor({ evidence }).triage)
    expect(true).toBe(true)
  })

  it('git pull ff-only on main', () => {
    const evidence = bashEvidence({ command: 'git pull --ff-only', facts: onMain() })
    console.log('deeds', JSON.stringify(evidence.deeds))
    console.log('triage', triageFor({ evidence }).triage)
    expect(true).toBe(true)
  })
})
