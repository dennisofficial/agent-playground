export enum EDeedRealm {
  Path = 'path',
  GitRef = 'git-ref',
  GitWorktree = 'git-worktree',
  Remote = 'remote',
  Process = 'process',
  Package = 'package',
}

export enum EDeed {
  Routine = 'routine',
  ReadOnly = 'read-only',
  WriteFile = 'write-file',
  FastForward = 'fast-forward',
  RemovePath = 'remove-path',
  DiscardWorkingTree = 'discard-working-tree',
  RewriteHistory = 'rewrite-history',
  DropRecovery = 'drop-recovery',
  DeleteBranch = 'delete-branch',
  ForcePush = 'force-push',
  MutateStash = 'mutate-stash',
  RemoveWorktree = 'remove-worktree',
  AddWorktree = 'add-worktree',
  CleanUntracked = 'clean-untracked',
  MutateDependencies = 'mutate-dependencies',
  KillProcess = 'kill-process',
  SendOutbound = 'send-outbound',
  PublishArtifact = 'publish-artifact',
  DeployEnvironment = 'deploy-environment',
  Unreadable = 'unreadable',
}

export type DeedTarget = { realm: EDeedRealm; value: string }

export type Deed = {
  action: EDeed
  toolName: string
  targets: readonly DeedTarget[]
  cwd: string | undefined
  summary: string
}

const QUIET_DEEDS: ReadonlySet<EDeed> = new Set([EDeed.Routine, EDeed.ReadOnly])

const FILESYSTEM_REALMS: ReadonlySet<EDeedRealm> = new Set([
  EDeedRealm.Path,
  EDeedRealm.GitWorktree,
])

export function mutates({ deed }: { deed: Deed }): boolean {
  if (deed.action === EDeed.Unreadable) return false
  return !QUIET_DEEDS.has(deed.action)
}

export function contendsForItsPlace({ deed }: { deed: Deed }): boolean {
  if (deed.action === EDeed.Unreadable) return false
  return deed.action !== EDeed.ReadOnly
}

export function filesystemTargets({ deed }: { deed: Deed }): readonly DeedTarget[] {
  return deed.targets.filter((target) => FILESYSTEM_REALMS.has(target.realm))
}

export function deedFingerprint({ deed }: { deed: Deed }): string {
  const targets = [...new Set(deed.targets.map((target) => `${target.realm}:${target.value}`))]
  targets.sort()
  return [deed.action, deed.toolName, deed.cwd ?? '', targets.join(' ')].join('|')
}
