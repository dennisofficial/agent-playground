import type { SnapshotId } from '../events/ids'

export abstract class WorkspacePort {
  abstract readonly root: string

  abstract snapshot(args: { label: string }): Promise<SnapshotId>

  abstract restore(args: { snapshotId: SnapshotId }): Promise<void>
}
