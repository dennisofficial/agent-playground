export type Worktree = {
  path: string
  head: string | undefined
  branch: string | undefined
  isMain: boolean
  isBare: boolean
  isDetached: boolean
  isLocked: boolean
  lockedReason: string | undefined
  isPrunable: boolean
  prunableReason: string | undefined
}

type Draft = {
  path: string
  head: string | undefined
  branch: string | undefined
  isBare: boolean
  isDetached: boolean
  isLocked: boolean
  lockedReason: string | undefined
  isPrunable: boolean
  prunableReason: string | undefined
}

const WORKTREE_KEY = 'worktree '
const HEAD_KEY = 'HEAD '
const BRANCH_KEY = 'branch '
const BRANCH_PREFIX = 'refs/heads/'
const LOCKED_KEY = 'locked'
const PRUNABLE_KEY = 'prunable'
const RENAME_ARROW = ' -> '
const STATUS_PATH_START = 3

const draftFor = (path: string): Draft => ({
  path,
  head: undefined,
  branch: undefined,
  isBare: false,
  isDetached: false,
  isLocked: false,
  lockedReason: undefined,
  isPrunable: false,
  prunableReason: undefined,
})

const reasonAfter = ({ line, key }: { line: string; key: string }): string | undefined => {
  const reason = line.slice(key.length).trim()
  return reason.length === 0 ? undefined : reason
}

const applyAttribute = ({ draft, line }: { draft: Draft; line: string }): void => {
  if (line.startsWith(HEAD_KEY)) {
    draft.head = line.slice(HEAD_KEY.length).trim()
    return
  }
  if (line.startsWith(BRANCH_KEY)) {
    const ref = line.slice(BRANCH_KEY.length).trim()
    draft.branch = ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref
    return
  }
  if (line === 'bare') {
    draft.isBare = true
    return
  }
  if (line === 'detached') {
    draft.isDetached = true
    return
  }
  if (line === LOCKED_KEY || line.startsWith(`${LOCKED_KEY} `)) {
    draft.isLocked = true
    draft.lockedReason = reasonAfter({ line, key: LOCKED_KEY })
    return
  }
  if (line === PRUNABLE_KEY || line.startsWith(`${PRUNABLE_KEY} `)) {
    draft.isPrunable = true
    draft.prunableReason = reasonAfter({ line, key: PRUNABLE_KEY })
  }
}

export function parseWorktreePorcelain({ output }: { output: string }): readonly Worktree[] {
  const drafts: Draft[] = []
  let current: Draft | undefined

  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.length === 0) continue
    if (line.startsWith(WORKTREE_KEY)) {
      current = draftFor(line.slice(WORKTREE_KEY.length).trim())
      drafts.push(current)
      continue
    }
    if (current === undefined) continue
    applyAttribute({ draft: current, line })
  }

  return drafts.map((draft, index) => ({ ...draft, isMain: index === 0 }))
}

const changedPathOf = (line: string): string | undefined => {
  if (line.length <= STATUS_PATH_START) return undefined
  const rest = line.slice(STATUS_PATH_START).trim()
  const arrow = rest.indexOf(RENAME_ARROW)
  const path = arrow < 0 ? rest : rest.slice(arrow + RENAME_ARROW.length)
  return path.length === 0 ? undefined : path
}

export function parseStatusPorcelain({ output }: { output: string }): readonly string[] {
  const paths: string[] = []
  for (const raw of output.split('\n')) {
    const path = changedPathOf(raw.replace(/\r$/, ''))
    if (path !== undefined) paths.push(path)
  }
  return paths
}
