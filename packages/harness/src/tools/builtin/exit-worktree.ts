import { z } from 'zod'

import {
  EToolEffect,
  EWorktreeExit,
  SchemaTool,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import { inject, injectable } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'
import { inspectWorktree, removeWorktree, type WorktreeInspection } from '../../workspace/worktrees'
import { repositoryAt, worktreeAt } from './worktree-support'

const inputSchema = z.strictObject({
  action: z.enum(EWorktreeExit),
  discardChanges: z.boolean().optional(),
})

const description = [
  'Leave the worktree the session is in and return to the directory Atlas was launched in.',
  'keep leaves the worktree and its branch on disk to come back to; remove deletes both.',
  'Call it only when the developer asks to leave, never on your own initiative, and never as tidying up after finishing a task.',
  'A remove is refused while the worktree holds uncommitted changes or commits that are not on its upstream; the refusal names what would be lost.',
  'discardChanges forces that removal through, so ask the developer before setting it rather than deciding for them.',
  'When the session is not in a worktree this does nothing at all and says so, leaving every file where it is.',
].join(' ')

const listOf = (inspection: WorktreeInspection): string => {
  const parts: string[] = []
  if (inspection.changedCount > 0) {
    const sample = inspection.changedPaths.join(', ')
    const more = inspection.changedCount - inspection.changedPaths.length
    parts.push(`${inspection.changedCount} uncommitted ${inspection.changedCount === 1 ? 'file' : 'files'} (${sample}${more > 0 ? `, and ${more} more` : ''})`)
  }
  if (inspection.unpushedCommits > 0) {
    const against = inspection.comparedAgainst ?? 'its base'
    parts.push(`${inspection.unpushedCommits} ${inspection.unpushedCommits === 1 ? 'commit' : 'commits'} not on ${against}`)
  }
  return parts.join(' and ')
}

@injectable()
export class ExitWorktreeTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'exit_worktree'
  readonly description = description
  readonly effect = EToolEffect.Destructive
  readonly inputSchema = inputSchema

  constructor(@inject(WorkspaceRoot) private readonly launchDirectory: string) {
    super()
  }

  protected override async run({
    input,
    projectDirectory,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    if (projectDirectory === this.launchDirectory) {
      return {
        ok: true,
        output: { exited: false },
        modelText: `The session is not in a worktree - it is in ${this.launchDirectory}, where it started - so nothing was left and nothing was removed.`,
      }
    }

    const path = projectDirectory

    if (input.action === EWorktreeExit.Keep) {
      return {
        ok: true,
        output: { exitedWorktree: { path, action: EWorktreeExit.Keep } },
        modelText: `Left the worktree at ${path}, which stays on disk with its branch. The project directory is ${this.launchDirectory} again.`,
      }
    }

    const found = await repositoryAt({ cwd: path })
    if (!found.ok) return { ok: false, reason: found.reason }

    const target = worktreeAt({ view: found.view, path })
    const branch = target?.branch

    if (input.discardChanges !== true) {
      const inspection = await inspectWorktree({
        cwd: path,
        ...(branch === undefined ? {} : { base: branch }),
      })

      if (!inspection.isClean) {
        return {
          ok: false,
          reason: `removing the worktree at ${path} would lose ${listOf(inspection)}. Tell the developer what is there and let them decide: they can commit and push it, exit with keep instead, or ask you to call this again with discardChanges set.`,
        }
      }
    }

    const removal = await removeWorktree({
      cwd: found.view.root,
      path,
      force: input.discardChanges === true,
      ...(branch === undefined ? {} : { branch }),
    })

    if (!removal.worktreeRemoved.ok) {
      return { ok: false, reason: `git would not remove the worktree at ${path}: ${removal.worktreeRemoved.message}` }
    }

    const branchNote =
      removal.branchDeleted === undefined || removal.branchDeleted.ok
        ? ''
        : ` The branch ${branch} could not be deleted (${removal.branchDeleted.message}), so it is still there.`

    return {
      ok: true,
      output: { exitedWorktree: { path, action: EWorktreeExit.Remove } },
      modelText: `Removed the worktree at ${path}${branch === undefined ? '' : ` and its branch ${branch}`}.${branchNote} The project directory is ${this.launchDirectory} again.`,
    }
  }
}
