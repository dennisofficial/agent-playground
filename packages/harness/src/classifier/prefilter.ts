import {
  answeredApproval,
  deedsOf,
  EDecision,
  EDeed,
  EPathDeclaration,
  EReadConfidence,
  filesystemTargets,
  isUnderPath,
  normalisePath,
  type CallId,
  type CommandReading,
  type Deed,
  type Event,
  type PathDeclarationView,
  type ToolCall,
} from '@dltech/atlas-core'

export enum ECandidacy {
  Clear = 'clear',
  Candidate = 'candidate',
}

export type Prefiltered = { candidacy: ECandidacy; deeds: readonly Deed[] }

const NESTED_CHECKOUT_SEGMENTS: ReadonlySet<string> = new Set(['worktrees', '.git'])

const QUIET_DEEDS: ReadonlySet<EDeed> = new Set([EDeed.Routine, EDeed.ReadOnly])

const alreadyApproved = ({
  events,
  callId,
}: {
  events: readonly Event[]
  callId: CallId
}): boolean => answeredApproval({ events, callId })?.decision === EDecision.Allow

export function insideOurCheckout({
  projectDirectory,
  path,
}: {
  projectDirectory: string
  path: string
}): boolean {
  if (!isUnderPath({ directory: projectDirectory, path })) return false

  const root = normalisePath({ path: projectDirectory })
  const below = normalisePath({ path }).slice(root.length).split('/')
  return !below.some((segment) => NESTED_CHECKOUT_SEGMENTS.has(segment))
}

function placesTouched({ deed }: { deed: Deed }): readonly string[] {
  const named = filesystemTargets({ deed }).map((target) => target.value)
  if (named.length > 0) return named
  return deed.cwd === undefined ? [] : [deed.cwd]
}

function settledInPlace({
  deed,
  projectDirectory,
}: {
  deed: Deed
  projectDirectory: string
}): boolean {
  if (QUIET_DEEDS.has(deed.action)) return true
  if (deed.action !== EDeed.WriteFile) return false

  return placesTouched({ deed }).every((path) => insideOurCheckout({ projectDirectory, path }))
}

function shellReadsPlainly({ reading }: { reading: CommandReading | undefined }): boolean {
  if (reading === undefined) return true
  if (reading.confidence !== EReadConfidence.Read) return false

  return !reading.segments.some((segment) => segment.pipesIntoInterpreter)
}

export function prefilterOf({
  call,
  declaration,
  reading,
  projectDirectory,
  events,
}: {
  call: ToolCall
  declaration: PathDeclarationView
  reading: CommandReading | undefined
  projectDirectory: string
  events: readonly Event[]
}): Prefiltered {
  if (alreadyApproved({ events, callId: call.callId })) {
    return { candidacy: ECandidacy.Clear, deeds: [] }
  }
  if (declaration.kind === EPathDeclaration.Unregistered) {
    return { candidacy: ECandidacy.Clear, deeds: [] }
  }

  const deeds = deedsOf({ call, declaration, reading, projectDirectory })
  const quiet =
    shellReadsPlainly({ reading }) &&
    deeds.every((deed) => settledInPlace({ deed, projectDirectory }))

  return { candidacy: quiet ? ECandidacy.Clear : ECandidacy.Candidate, deeds }
}
