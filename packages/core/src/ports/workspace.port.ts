import type { SnapshotId } from '../events/ids'

export interface WorkspacePort {
  readonly root: string

  snapshot(args: { label: string }): Promise<SnapshotId>

  restore(args: { snapshotId: SnapshotId }): Promise<void>
}
