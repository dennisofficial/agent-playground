import { z } from 'zod'

import { EToolEffect, SchemaTool, type ToolOutcome, type ToolRun } from '@dltech/atlas-core'

import { WorkspaceRoot, WorktreeDirectoryToken } from '../../container/tokens'
import {
  addWorktree,
  defaultBranch,
  EDefaultBranchSource,
  fetchOrigin,
} from '../../workspace/worktrees'
import {
  claimWorktree,
  EWorktreeClaim,
  releaseWorktree,
  type WorktreeClaim,
} from '../../workspace/worktree-lock'
import { adoptWorktree, type AdoptedWorktree } from './worktree-adopt'
import {
  hideWorktreeHome,
  nameComplaint,
  pathForName,
  repositoryAt,
  worktreeHomeOf,
} from './worktree-support'

const inputSchema = z.strictObject({
  name: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
})

const NOW_THE_PROJECT_DIRECTORY =
  'That worktree is the project directory now: a path you pass to a tool resolves against it, and a bash command starts there.'

const description = [
  'Create a git worktree and move the session into it.',
  'Use it only when the developer asks for a worktree, or the project instructions say work happens in one; a request to fix something or start a branch is not by itself a request for a worktree.',
  'name creates a new worktree on a new branch of that name, cut from a freshly fetched origin default branch, under the worktree directory this project is configured to use.',
  'path enters a worktree that already exists instead, and must name one git already lists for this repository - not its main checkout, and not one that is bare, prunable or on a detached HEAD.',
  'Entering that way adopts a worktree Atlas did not create: the reply reports the branch it is on, its upstream, and what is uncommitted or unpushed there, and exit_worktree will not remove it however it is called.',
  'The two are mutually exclusive, and a new worktree cannot be created while the session is already in one - exit first, or switch straight to another existing worktree by path.',
  'While the session is in a worktree that worktree is the project directory: paths you pass to a tool resolve against it, a bash command starts there, and the instruction files are re-read from it.',
  'The repository this worktree came from stays checked out where it was; leave that checkout alone.',
  'exit_worktree leaves, keeping or removing the worktree as the developer asks, and worktree_list shows what exists.',
].join(' ')

export class EnterWorktreeTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'enter_worktree'
  readonly description = description
  readonly effect = EToolEffect.Destructive
  readonly inputSchema = inputSchema

  constructor(
     private readonly launchDirectory: string,
     private readonly worktreeDirectory: () => string,
  ) {
    super()
  }

  protected override async run({
    input,
    projectDirectory,
    threadId,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    if (input.name !== undefined && input.path !== undefined) {
      return { ok: false, reason: 'name creates a worktree and path enters one that exists, so pass exactly one of them' }
    }
    if (input.name === undefined && input.path === undefined) {
      return { ok: false, reason: 'pass name to create a worktree, or path to enter one that already exists' }
    }

    const found = await repositoryAt({ cwd: projectDirectory })
    if (!found.ok) return { ok: false, reason: found.reason }

    const { view } = found

    if (input.path !== undefined) {
      const home = worktreeHomeOf({ repositoryRoot: view.root, directory: this.worktreeDirectory() })
      const outcome = await adoptWorktree({ view, path: input.path, worktreeHome: home })
      if (!outcome.ok) return { ok: false, reason: outcome.reason }

      const { adopted } = outcome
      if (adopted.path === projectDirectory) {
        return {
          ok: true,
          output: {},
          modelText: `The session is already in the worktree at ${adopted.path}, on branch ${adopted.branch}. ${adopted.report}`,
        }
      }

      const claimed = await claimWorktree({
        cwd: view.root,
        path: adopted.path,
        label: `thread ${threadId}`,
      })
      if (claimed.claim === EWorktreeClaim.Held) {
        return {
          ok: false,
          reason: `the worktree at ${adopted.path} is not free: ${claimed.note}. Tell the developer, and let them pick a different worktree or wait for that session to leave.`,
        }
      }

      await this.leave({ cwd: view.root, path: projectDirectory })
      return this.adopted({ adopted, claim: claimed })
    }

    const name = input.name ?? ''
    const complaint = nameComplaint(name)
    if (complaint !== undefined) return { ok: false, reason: complaint }

    if (projectDirectory !== this.launchDirectory) {
      return {
        ok: false,
        reason: `the session is already in the worktree at ${projectDirectory}. Leave it with exit_worktree before creating another, or switch straight to an existing one by passing its path.`,
      }
    }

    const home = worktreeHomeOf({ repositoryRoot: view.root, directory: this.worktreeDirectory() })
    await hideWorktreeHome({ home })

    const fetched = await fetchOrigin({ cwd: view.root })
    const resolved = await defaultBranch({ cwd: view.root })
    if (!resolved.ok) return { ok: false, reason: resolved.message }

    const fromOrigin = resolved.source !== EDefaultBranchSource.LocalBranch
    const base = fromOrigin ? `origin/${resolved.branch}` : resolved.branch
    const added = await addWorktree({
      cwd: view.root,
      path: pathForName({ home, name }),
      branch: name,
      base,
    })

    if (!added.ok) return { ok: false, reason: added.message }

    await claimWorktree({ cwd: view.root, path: added.path, label: `thread ${threadId}` })

    return this.created({
      path: added.path,
      branch: added.branch,
      base,
      ...(fetched.ok || !fromOrigin ? {} : { staleBase: fetched.message }),
    })
  }

  private async leave({ cwd, path }: { cwd: string; path: string }): Promise<void> {
    if (path === this.launchDirectory) return
    await releaseWorktree({ cwd, path })
  }

  private created(args: {
    path: string
    branch: string
    base: string
    staleBase?: string
  }): ToolOutcome {
    return {
      ok: true,
      output: { enteredWorktree: { path: args.path, branch: args.branch, base: args.base } },
      modelText: [
        `Created a worktree at ${args.path} on a new branch ${args.branch}, cut from ${args.base}.`,
        NOW_THE_PROJECT_DIRECTORY,
        ...(args.staleBase === undefined
          ? []
          : [`The fetch from origin failed (${args.staleBase}), so the branch was cut from whatever ${args.base} already pointed at locally.`]),
      ].join(' '),
    }
  }

  private adopted(entry: { adopted: AdoptedWorktree; claim: WorktreeClaim }): ToolOutcome {
    const { adopted: args, claim } = entry
    const tracking = args.base === undefined ? 'It has no upstream.' : `It tracks ${args.base}.`

    return {
      ok: true,
      output: {
        enteredWorktree: {
          path: args.path,
          branch: args.branch,
          adopted: true,
          ...(args.base === undefined ? {} : { base: args.base }),
        },
      },
      modelText: [
        `Moved into the existing worktree at ${args.path}, on branch ${args.branch}. ${tracking}`,
        args.report,
        ...(claim.note === undefined ? [] : [claim.note]),
        NOW_THE_PROJECT_DIRECTORY,
        'Atlas did not create this worktree, so exit_worktree will leave it on disk however it is called.',
      ].join(' '),
    }
  }
}
