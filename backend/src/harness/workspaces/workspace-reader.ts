import { Injectable } from '@nestjs/common';
import type { WorkAreaFilter } from './workspace-registry';
import { WorkspaceRegistry } from './workspace-registry';
import { WorkspaceService } from './workspace.service';

/**
 * The agent-facing READ view of a workspace — what `list_workspaces` / existence-checks / the bots'
 * work-context render. A unified projection over BOTH metadata sources so a `workAreaId` (sandbox work
 * area) and a `ws-NNN` (local checkout) both resolve:
 *   - sandbox work areas → `WorkspaceRegistry` (the host's middle-tier record);
 *   - local checkouts    → `WorkspaceService` (the host worktree manager).
 * (In the all-sandbox end state the local source is removed and only the registry remains.)
 */
export interface WorkspaceView {
  /** The id the tools take — a `workAreaId` (`wa-<uuid>`) for a sandbox work area, `ws-NNN` for local. */
  id: string;
  name: string;
  /** The git branch ('' when not yet known/realized). */
  branch: string;
  team: string;
  project: string;
  ownerBot: string;
  /** The shared integration branch this workspace publishes to / pulls from, if any. */
  sharedBranch?: string;
  /** True when the workspace is a containerized sandbox work area (its git lives inside the daemon). */
  containerized: boolean;
}

/**
 * Assembles the unified `WorkspaceView` the workspace tools read, so a sandbox work area (registered in
 * `WorkspaceRegistry`, with its checkout inside the daemon) is just as visible to `list_workspaces` and
 * existence checks as a local `ws-NNN`. Routing/git ops still go through `WorkspaceGitProvider`; this is
 * purely the metadata read seam that used to be `WorkspaceService.get`/`list` directly.
 */
@Injectable()
export class WorkspaceReader {
  constructor(
    private readonly local: WorkspaceService,
    private readonly workAreas: WorkspaceRegistry,
  ) {}

  /** A workspace by id — a sandbox work area (preferred) else a local checkout, or undefined. */
  get(id: string): WorkspaceView | undefined {
    const wa = this.workAreas.get(id);
    if (wa)
      return {
        id: wa.workAreaId,
        name: wa.name,
        branch: wa.branch ?? '',
        team: wa.team,
        project: wa.project,
        ownerBot: wa.ownerBot,
        ...(wa.shared ? { sharedBranch: wa.shared } : {}),
        containerized: true,
      };
    const ws = this.local.get(id);
    if (ws)
      return {
        id: ws.id,
        name: ws.name,
        branch: ws.branch,
        team: ws.team,
        project: ws.project,
        ownerBot: ws.ownerBot,
        ...(ws.sharedBranch ? { sharedBranch: ws.sharedBranch } : {}),
        containerized: false,
      };
    return undefined;
  }

  /** All workspaces (sandbox work areas ∪ local checkouts), optionally filtered. */
  list(filter?: WorkAreaFilter): WorkspaceView[] {
    const sandbox: WorkspaceView[] = this.workAreas.list(filter).map((wa) => ({
      id: wa.workAreaId,
      name: wa.name,
      branch: wa.branch ?? '',
      team: wa.team,
      project: wa.project,
      ownerBot: wa.ownerBot,
      ...(wa.shared ? { sharedBranch: wa.shared } : {}),
      containerized: true,
    }));
    const local: WorkspaceView[] = this.local
      .list(filter?.ownerBot ? { ownerBot: filter.ownerBot } : undefined)
      .filter(
        (w) =>
          (!filter?.team || w.team === filter.team) &&
          (!filter?.project || w.project === filter.project),
      )
      .map((w) => ({
        id: w.id,
        name: w.name,
        branch: w.branch,
        team: w.team,
        project: w.project,
        ownerBot: w.ownerBot,
        ...(w.sharedBranch ? { sharedBranch: w.sharedBranch } : {}),
        containerized: false,
      }));
    return [...sandbox, ...local];
  }
}
