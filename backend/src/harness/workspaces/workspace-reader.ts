import { Injectable } from '@nestjs/common';
import { SandboxRegistry } from './sandbox-registry';
import type { WorkAreaFilter, WorkAreaRecord } from './workspace-registry';
import { WorkspaceRegistry } from './workspace-registry';

/**
 * The agent-facing READ view of a workspace — what `list_workspaces` / existence-checks / the bots'
 * work-context render. Every workspace is now a sandbox WORK AREA (the all-sandbox standard), so this
 * projects `WorkspaceRegistry` records. Routing/git ops go through `WorkspaceGitProvider`; this is purely
 * the metadata read seam that used to be `WorkspaceService.get`/`list`.
 */
export interface WorkspaceView {
  /** The id the tools take — a `workAreaId` (`wa-<uuid>`). */
  id: string;
  name: string;
  /** The git branch ('' when not yet known/realized). */
  branch: string;
  team: string;
  project: string;
  ownerBot: string;
  /** Always true — every workspace is a containerized sandbox work area. */
  containerized: boolean;
  /** The localhost URL the workstation's dev server is viewable at (`http://localhost:<devPort>`), when a
   * host port was allocated for it. Undefined when the port pool was exhausted at create, or for a sandbox
   * that predates the dev-server exposure feature. The agent runs its dev server in the sandbox's inner
   * compose published to `0.0.0.0:WORKSPACE_DEV_PORT` (7000) to make it reachable here. */
  devUrl?: string;
}

/**
 * Assembles the `WorkspaceView` the workspace tools read, from `WorkspaceRegistry` (the host's work-area
 * records) joined to `SandboxRegistry` for the published dev-server port. The metadata read seam — keeps
 * the tools off the (now-deleted) `WorkspaceService`.
 */
@Injectable()
export class WorkspaceReader {
  constructor(
    private readonly workAreas: WorkspaceRegistry,
    private readonly sandboxes: SandboxRegistry,
  ) {}

  /** Project a `WorkAreaRecord` into the agent-facing view, joining the sandbox's published dev port (the
   * work area is 1:1 with the sandbox; `sandboxId` keys into `SandboxRegistry`). */
  private viewOf(wa: WorkAreaRecord): WorkspaceView {
    const devPort = this.sandboxes.get(wa.sandboxId)?.devPort;
    return {
      id: wa.workAreaId,
      name: wa.name,
      branch: wa.branch ?? '',
      team: wa.team,
      project: wa.project,
      ownerBot: wa.ownerBot,
      containerized: true,
      ...(devPort !== undefined
        ? { devUrl: `http://localhost:${devPort}` }
        : {}),
    };
  }

  /** A workspace (work area) by id, or undefined. */
  get(id: string): WorkspaceView | undefined {
    const wa = this.workAreas.get(id);
    return wa ? this.viewOf(wa) : undefined;
  }

  /** All work areas, optionally filtered. */
  list(filter?: WorkAreaFilter): WorkspaceView[] {
    return this.workAreas.list(filter).map((wa) => this.viewOf(wa));
  }
}
