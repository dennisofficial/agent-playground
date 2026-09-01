import { EDeed, type Deed } from '../deed'
import { ERiskDimension, ESeverity } from '../dimension'
import type { WorkspaceFacts } from '../facts'
import { basenameOf } from '../path-set'
import type { RiskSignal, SignalProbe } from '../signals'
import {
  belongsToTheOperatorsTools,
  insideProject,
  isOurs,
  losesSomething,
  mutatingDeeds,
  placesOf,
  riskSignal,
  worktreeAt,
} from './kit'

const dimension = ERiskDimension.Reach

const EXEMPT: ReadonlySet<EDeed> = new Set([EDeed.AddWorktree])

function describe({ facts, path }: { facts: WorkspaceFacts; path: string }): {
  subject: string
  where: string
} {
  const worktree = worktreeAt({ facts, path })
  if (worktree === undefined) return { subject: `path:${path}`, where: `${path}` }

  const name = basenameOf({ path: worktree.path })
  const kind = worktree.isMain ? 'the main checkout' : `the worktree ${name}`
  return { subject: `worktree:${name}`, where: `${path}, inside ${kind}` }
}

function signalsFor({ deed, facts }: { deed: Deed; facts: WorkspaceFacts }): readonly RiskSignal[] {
  if (EXEMPT.has(deed.action)) return []

  return placesOf({ deed }).flatMap((path) => {
    if (insideProject({ facts, path })) return []
    if (belongsToTheOperatorsTools({ path })) return []

    const worktree = worktreeAt({ facts, path })
    if (worktree !== undefined && isOurs({ facts, worktree })) return []

    const { subject, where } = describe({ facts, path })

    return [
      riskSignal({
        dimension,
        severity: losesSomething({ deed, facts }) ? ESeverity.Serious : ESeverity.Note,
        id: 'reach:outside-project',
        subject,
        detail: `${deed.summary} at ${where}, outside ${facts.projectDirectory}`,
      }),
    ]
  })
}

export const reachProbe: SignalProbe = {
  dimension,
  probe: (evidence) =>
    mutatingDeeds({ evidence }).flatMap((deed) => signalsFor({ deed, facts: evidence.facts })),
}
