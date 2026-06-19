import { Injectable } from '@nestjs/common';
import type { WorkAreaFilter } from './workspace-registry';
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
}

/** Project a `WorkAreaRecord` into the agent-facing view. */
function viewOf(wa: {
  workAreaId: string;
  name: string;
  branch?: string;
  team: string;
  project: string;
  ownerBot: string;
}): WorkspaceView {
  return {
    id: wa.workAreaId,
    name: wa.name,
    branch: wa.branch ?? '',
    team: wa.team,
    project: wa.project,
    ownerBot: wa.ownerBot,
    containerized: true,
  };
}

/**
 * Assembles the `WorkspaceView` the workspace tools read, from `WorkspaceRegistry` (the host's work-area
 * records). The metadata read seam — keeps the tools off the (now-deleted) `WorkspaceService`.
 */
@Injectable()
export class WorkspaceReader {
  constructor(private readonly workAreas: WorkspaceRegistry) {}

  /** A workspace (work area) by id, or undefined. */
  get(id: string): WorkspaceView | undefined {
    const wa = this.workAreas.get(id);
    return wa ? viewOf(wa) : undefined;
  }

  /** All work areas, optionally filtered. */
  list(filter?: WorkAreaFilter): WorkspaceView[] {
    return this.workAreas.list(filter).map(viewOf);
  }
}
