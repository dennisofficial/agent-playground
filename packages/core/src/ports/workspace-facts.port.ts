import type { DeedTarget, EDeedRealm } from '../policy/classifier/deed'
import type { WorkspaceFacts } from '../policy/classifier/facts'

export type FactRequest = {
  realms: readonly EDeedRealm[]
  targets: readonly DeedTarget[]
  projectDirectory: string
  launchDirectory: string
}

export type FactWarming = { projectDirectory: string; launchDirectory: string }

export abstract class WorkspaceFactsPort {
  abstract factsFor(args: FactRequest): Promise<WorkspaceFacts>

  abstract prewarm(args: FactWarming): void

  abstract invalidate(): void
}
