import { z } from 'zod'

import { EToolEffect, SchemaTool, type ToolOutcome, type ToolRun } from '@dltech/atlas-core'

import { type Worktree } from '../../workspace/worktrees'
import { repositoryAt } from './worktree-support'

const inputSchema = z.strictObject({})

const description = [
  'List the git worktrees of the repository the session is in, with the branch each one is on.',
  'The main checkout is marked, as is whichever worktree the session is standing in.',
  'Read it before entering a worktree by path, or to tell the developer what work is already laid out.',
].join(' ')

const lineFor = (args: { worktree: Worktree; current: string }): string => {
  const marks = [
    args.worktree.isMain ? 'main checkout' : undefined,
    args.worktree.path === args.current ? 'this session' : undefined,
    args.worktree.isLocked ? 'locked' : undefined,
    args.worktree.isPrunable ? 'prunable' : undefined,
  ].filter((mark): mark is string => mark !== undefined)

  const branch = args.worktree.branch ?? 'detached HEAD'
  return `${args.worktree.path} on ${branch}${marks.length === 0 ? '' : ` (${marks.join(', ')})`}`
}

export class WorktreeListTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'worktree_list'
  readonly description = description
  readonly effect = EToolEffect.Read
  readonly inputSchema = inputSchema

  override isConcurrencySafe(): boolean {
    return true
  }

  protected override async run({
    projectDirectory,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const found = await repositoryAt({ cwd: projectDirectory })
    if (!found.ok) return { ok: false, reason: found.reason }

    const { worktrees, root } = found.view

    return {
      ok: true,
      output: {
        repository: root,
        current: projectDirectory,
        worktrees: worktrees.map((worktree) => ({
          path: worktree.path,
          branch: worktree.branch,
          isMain: worktree.isMain,
        })),
      },
      modelText: worktrees
        .map((worktree) => lineFor({ worktree, current: projectDirectory }))
        .join('\n'),
    }
  }
}
