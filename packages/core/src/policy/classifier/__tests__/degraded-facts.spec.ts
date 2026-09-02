import { describe, expect, it } from 'bun:test'

import { EDeedRealm } from '../deed'
import { ESeverity } from '../dimension'
import { NO_FACTS } from '../facts'
import { signalsFor } from '../signals'
import { ETriage } from '../triage'
import { REPO, bashEvidence, factsAt, onMain, triageFor, worktreeFact } from './fixtures'

const blind = (command: string) =>
  triageFor({ evidence: bashEvidence({ command, facts: NO_FACTS }) })

describe('a workspace Atlas could not read', () => {
  it('clears the housekeeping the same call would consult on with facts in hand', () => {
    for (const command of [
      `rm -rf ${REPO}/node_modules`,
      'git checkout -- .',
      `git -C ${REPO} commit -m "a thing"`,
    ]) {
      expect(blind(command).triage).toBe(ETriage.Clear)
    }
  })

  it('records that it could not read the workspace, at a severity that never interrupts', () => {
    const signals = signalsFor({
      evidence: bashEvidence({ command: `rm -rf ${REPO}/node_modules`, facts: NO_FACTS }),
    })

    expect(signals.map((signal) => signal.id)).toEqual(['blast:workspace-unreadable'])
    expect(signals[0]?.severity).toBe(ESeverity.Note)
  })

  it('says nothing about the workspace once it has actually read one', () => {
    const signals = signalsFor({
      evidence: bashEvidence({ command: 'rm -rf node_modules', facts: onMain() }),
    })

    expect(signals.map((signal) => signal.id)).not.toContain('blast:workspace-unreadable')
  })
})

describe('facts nobody gathered', () => {
  const worktreesNobodyInspected = factsAt({
    projectDirectory: REPO,
    gatheredFor: [EDeedRealm.Path],
    worktrees: [worktreeFact({ path: REPO, branch: 'main', isMain: true, changedCount: 276 })],
  })

  it('does not claim a tree is dirty in a realm the collector never gathered', () => {
    const evidence = bashEvidence({
      command: 'git checkout -- .',
      facts: worktreesNobodyInspected,
    })

    expect(triageFor({ evidence }).triage).toBe(ETriage.Clear)
  })
})
