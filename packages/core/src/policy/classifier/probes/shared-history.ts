import { EDeed, EDeedRealm, type Deed } from '../deed'
import { ERiskDimension, ESeverity } from '../dimension'
import type { WorkspaceFacts } from '../facts'
import type { RiskSignal, SignalProbe } from '../signals'
import { mutatingDeeds, riskSignal, targetsInRealm, worktreeAt } from './kit'

const dimension = ERiskDimension.SharedHistory

const branchAt = ({ deed, facts }: { deed: Deed; facts: WorkspaceFacts }): string | undefined =>
  worktreeAt({ facts, path: deed.cwd ?? facts.projectDirectory })?.branch

const onRemote = ({ facts, ref }: { facts: WorkspaceFacts; ref: string }): boolean =>
  facts.refs.find((fact) => fact.ref === ref)?.onRemote === true

function published({ deed, facts }: { deed: Deed; facts: WorkspaceFacts }): readonly string[] {
  const named = targetsInRealm({ deed, realm: EDeedRealm.GitRef })
  const refs = named.length > 0 ? named : [branchAt({ deed, facts })]

  return refs.filter((ref): ref is string => ref !== undefined && onRemote({ facts, ref }))
}

function signalsFor({ deed, facts }: { deed: Deed; facts: WorkspaceFacts }): readonly RiskSignal[] {
  if (deed.action === EDeed.ForcePush) {
    return published({ deed, facts }).map((ref) =>
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'shared-history:force-push',
        subject: `ref:${ref}`,
        detail: `overwrites ${ref}, which exists on a remote every other clone fetches`,
      }),
    )
  }

  if (deed.action === EDeed.DeleteBranch) {
    const remote = targetsInRealm({ deed, realm: EDeedRealm.Remote }).length > 0

    return published({ deed, facts }).map((ref) =>
      riskSignal({
        dimension,
        severity: remote ? ESeverity.Grave : ESeverity.Serious,
        id: remote ? 'shared-history:delete-remote-branch' : 'shared-history:delete-branch',
        subject: `ref:${ref}`,
        detail: remote
          ? `deletes ${ref} on the remote, where others fetch it`
          : `deletes ${ref}, whose commits a remote also carries`,
      }),
    )
  }

  if (deed.action !== EDeed.RewriteHistory) return []

  const branch = branchAt({ deed, facts })
  if (branch === undefined || !onRemote({ facts, ref: branch })) return []

  return [
    riskSignal({
      dimension,
      severity: ESeverity.Serious,
      id: 'shared-history:rewrite',
      subject: `ref:${branch}`,
      detail: `rewrites commits on ${branch}, which a remote already carries`,
    }),
  ]
}

export const sharedHistoryProbe: SignalProbe = {
  dimension,
  probe: (evidence) =>
    mutatingDeeds({ evidence }).flatMap((deed) => signalsFor({ deed, facts: evidence.facts })),
}
