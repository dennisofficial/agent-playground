import { z } from 'zod'

import { EToolEffect, SchemaTool, type ToolOutcome, type ToolRun } from '@dltech/atlas-core'

import { inject, injectable } from '../../container/injection'
import { WorkspaceRoot, WorktreeDirectoryToken } from '../../container/tokens'
import {
  addWorktree,
  defaultBranch,
  EDefaultBranchSource,
  fetchOrigin,
} from '../../workspace/worktrees'
import {
  hideWorktreeHome,
  nameComplaint,
  pathForName,
  repositoryAt,
  worktreeAt,
  worktreeHomeOf,
} from './worktree-support'

const inputSchema = z.strictObject({
  name: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
})

const description = [
  'Create a git worktree and move the session into it.',
  'Use it only when the developer asks for a worktree, or the project instructions say work happens in one; a request to fix something or start a branch is not by itself a request for a worktree.',
  'name creates a new worktree on a new branch of that name, cut from a freshly fetched origin default branch, under the worktree directory this project is configured to use.',
  'path enters a worktree that already exists instead, and must name one git already lists for this repository.',
  'The two are mutually exclusive, and a new worktree cannot be created while the session is already in one - exit first, or switch straight to another existing worktree by path.',
  'While the session is in a worktree that worktree is the project directory: paths you pass to a tool resolve against it, a bash command starts there, and the instruction files are re-read from it.',
  'The repository this worktree came from stays checked out where it was; leave that checkout alone.',
  'exit_worktree leaves, keeping or removing the worktree as the developer asks, and worktree_list shows what exists.',
].join(' ')

@injectable()
export class EnterWorktreeTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'enter_worktree'
  readonly description = description
  readonly effect = EToolEffect.Destructive
  readonly inputSchema = inputSchema

  constructor(
    @inject(WorkspaceRoot) private readonly launchDirectory: string,
    @inject(WorktreeDirectoryToken) private readonly worktreeDirectory: () => string,
  ) {
    super()
  }

  protected override async run({
    input,
    projectDirectory,
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
      const target = worktreeAt({ view, path: input.path })
      if (target === undefined) {
        const known = view.worktrees.map((worktree) => worktree.path).join(', ')
        return {
          ok: false,
          reason: `git does not list ${input.path} as a worktree of the repository at ${view.root}. It lists: ${known}`,
        }
      }
      if (target.branch === undefined) {
        return { ok: false, reason: `the worktree at ${target.path} has a detached HEAD, so there is no branch to work on` }
      }

      return this.entered({ path: target.path, branch: target.branch, base: target.branch, created: false })
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

    return this.entered({
      path: added.path,
      branch: added.branch,
      base,
      created: true,
      ...(fetched.ok || !fromOrigin ? {} : { staleBase: fetched.message }),
    })
  }

  private entered(args: {
    path: string
    branch: string
    base: string
    created: boolean
    staleBase?: string
  }): ToolOutcome {
    const opening = args.created
      ? `Created a worktree at ${args.path} on a new branch ${args.branch}, cut from ${args.base}.`
      : `Moved into the existing worktree at ${args.path}, on branch ${args.branch}.`

    return {
      ok: true,
      output: { enteredWorktree: { path: args.path, branch: args.branch, base: args.base } },
      modelText: [
        opening,
        `That worktree is the project directory now: a path you pass to a tool resolves against it, and a bash command starts there.`,
        ...(args.staleBase === undefined
          ? []
          : [`The fetch from origin failed (${args.staleBase}), so the branch was cut from whatever ${args.base} already pointed at locally.`]),
      ].join(' '),
    }
  }
}
