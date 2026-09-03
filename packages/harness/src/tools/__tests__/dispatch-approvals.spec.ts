import { describe, expect, it } from 'bun:test'

import { EBeforeToolDecision, EStage, type BeforeTool, type EventDraft } from '@dltech/atlas-core'

import { HookChain, type RegisteredHook } from '../../hooks/registry'
import { EApprovalRouting, HookedToolDispatcher } from '../dispatch'
import { InMemoryToolRegistry } from '../registry'
import { readCall, toolNamed } from './fixtures'

const SESSION_DIRECTORY = '/workspace'

const asking: RegisteredHook<BeforeTool> = {
  name: 'asker',
  order: { stage: EStage.Policy, nudge: 0 },
  run: async () => ({
    decision: EBeforeToolDecision.Ask,
    reason: 'this removes a worktree another session is holding.',
  }),
}

const dispatchedUnder = async (approvals: EApprovalRouting): Promise<readonly EventDraft[]> => {
  let invoked = false
  const dispatcher = new HookedToolDispatcher({
    approvals,
    registry: new InMemoryToolRegistry([
      toolNamed({
        name: 'read',
        invoke: async () => {
          invoked = true
          return { ok: true, output: '', modelText: 'rendered' }
        },
      }),
    ]),
    hooks: new HookChain({ beforeTool: [asking] }),
  })

  const drafts = await dispatcher.dispatch({
    call: readCall,
    signal: new AbortController().signal,
    projectDirectory: SESSION_DIRECTORY,
    events: [],
  })

  expect(invoked).toBe(false)
  return drafts
}

describe('an Ask reaching a dispatcher with an operator attached', () => {
  it('asks the operator', async () => {
    const drafts = await dispatchedUnder(EApprovalRouting.Operator)

    expect(drafts.map((draft) => draft.type)).toEqual(['approval-requested'])
  })
})

describe('an Ask reaching a dispatcher no operator is watching', () => {
  it('denies the call instead of wedging a thread that cannot be answered', async () => {
    const drafts = await dispatchedUnder(EApprovalRouting.None)

    expect(drafts.map((draft) => draft.type)).toEqual(['tool-denied'])
  })

  it('says why, so the child can report it and the parent can re-propose it', async () => {
    const [draft] = await dispatchedUnder(EApprovalRouting.None)
    const reason = draft?.type === 'tool-denied' ? draft.reason : ''

    expect(reason).toContain('another session is holding')
    expect(reason).toContain('No operator is attached')
  })
})
