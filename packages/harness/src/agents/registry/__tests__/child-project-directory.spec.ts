import { describe, expect, it } from 'bun:test'

import { EWorktreeExit, toRunId } from '@dltech/atlas-core'

import { openSupervisor, type OpenedSupervisor } from './fixtures'

const WORKTREE = '/repo/.atlas/worktrees/topic'

const opened = async (): Promise<OpenedSupervisor> => openSupervisor()

describe('the project directory a child is handed', () => {
  it('is the session launch directory when the parent never entered a worktree', async () => {
    const { supervisor, runners, parent, close } = await opened()

    await supervisor.spawn({ threadId: parent, agentType: 'explore', brief: 'look around', intent: 'look' })

    expect(runners.started[0]?.request.projectDirectory).toBe('/launch')
    await close()
  })

  it('is the worktree the parent is sitting in, not the launch directory', async () => {
    const { supervisor, runners, parent, harness, close } = await opened()

    await harness.log.append({
      threadId: parent,
      runId: toRunId('run_enter'),
      drafts: [{ type: 'worktree-entered', path: WORKTREE, branch: 'topic', base: 'origin/main' }],
    })

    await supervisor.spawn({ threadId: parent, agentType: 'explore', brief: 'look around', intent: 'look' })

    expect(runners.started[0]?.request.projectDirectory).toBe(WORKTREE)
    await close()
  })

  it('moves back when the parent has since left the worktree', async () => {
    const { supervisor, runners, parent, harness, close } = await opened()

    await harness.log.append({
      threadId: parent,
      runId: toRunId('run_enter'),
      drafts: [{ type: 'worktree-entered', path: WORKTREE, branch: 'topic', base: 'origin/main' }],
    })
    await harness.log.append({
      threadId: parent,
      runId: toRunId('run_exit'),
      drafts: [{ type: 'worktree-exited', path: WORKTREE, action: EWorktreeExit.Keep, returnTo: '/repo' }],
    })

    await supervisor.spawn({ threadId: parent, agentType: 'explore', brief: 'look around', intent: 'look' })

    expect(runners.started[0]?.request.projectDirectory).toBe('/repo')
    await close()
  })
})
