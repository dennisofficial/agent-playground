import { Injectable } from '@nestjs/common';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { WorkspaceSecretFileStore } from '../onboarding/workspace-secret.store';
import { McpServerStore } from '../mcp';
import { WorkspaceSkillStore } from '../skills';
import { ConventionProfileResolver } from '../conventions';

/**
 * The current state of a repo's WORKSPACE PROFILE — the one named area (secrets, mounts, caches, setup,
 * MCP servers, skills, house style) Atlas provisions ONCE at onboarding and keeps current on every job
 * after. A read-only projection: never a secret VALUE, only refs/metadata safe to show the brain.
 */
export interface WorkspaceProfileSnapshot {
  /** Durable bind mounts (cache/state dirs) — `write_workspace_config`. */
  mounts: { path: string; mode: string }[];
  /** The cold-boot setup script — `write_setup_script`. Presence + size only (the body can be long). */
  setupScript: { present: boolean; length: number };
  /** Secret FILE refs the hydrator renders in — `request_secret`/`request_file`. Path + label ONLY. */
  secretFiles: { path: string; label: string | null }[];
  /** MCP servers effective for this repo — `propose_mcp_servers`. Name/tier/surfaces/enabled, no secrets. */
  mcpServers: { name: string; tier: 'org' | 'repo'; surfaces: string[]; enabled: boolean }[];
  /** Skills effective for this repo — `propose_skill`. Name/tier/description/enabled. */
  skills: { name: string; tier: 'org' | 'repo'; description: string; enabled: boolean }[];
  /** The attached house-style profile — `propose_convention_profile`. Slug + display name, or null. */
  houseStyle: { slug: string; name: string | null } | null;
}

/**
 * A host-DERIVED gap in the Workspace Profile — a misconfiguration the brain cannot see from the
 * snapshot alone, surfaced conditionally so upkeep is a concrete signal rather than standing prompt
 * prose. v1 covers unfilled MCP secret slots (an approved server that silently can't authenticate);
 * broken-auth detection and new-stack ("noticed a new package") detection are planned follow-ups.
 */
export interface ProfileGap {
  kind: 'unfilled_mcp_secret';
  /** Human-readable, secret-SAFE (names only) description including the tool to fix it. */
  detail: string;
}

/**
 * Read-model over the seven Workspace Profile dimensions. It COMPOSES the existing per-dimension stores —
 * it owns NO storage of its own — and renders a compact snapshot the brain sees every turn (see
 * `prompt-kit/groups/workspace-profile.group.ts`). This is what makes "keep it up to date" actionable:
 * the brain can only maintain the profile if it can see what already exists.
 *
 * `@Global` module; injected next to `ConventionProfileResolver` on the brain turn-assembly path.
 */
@Injectable()
export class WorkspaceProfileService {
  constructor(
    private readonly workspaceConfig: WorkspaceConfigStore,
    private readonly secretFiles: WorkspaceSecretFileStore,
    private readonly mcp: McpServerStore,
    private readonly skills: WorkspaceSkillStore,
    private readonly conventions: ConventionProfileResolver,
  ) {}

  /** Aggregate the current state across all seven dimensions (~5 cheap queries). */
  async describe(orgId: string, repoId: string): Promise<WorkspaceProfileSnapshot> {
    const [mounts, setupScript, secretFiles, mcpRows, skillRows, houseStyleSlug, houseStyle] =
      await Promise.all([
        this.workspaceConfig.listMounts(orgId, repoId),
        this.workspaceConfig.getSetupScript(orgId, repoId),
        this.secretFiles.list(orgId, repoId),
        this.mcp.rowsForTurn(orgId, repoId),
        this.skills.rowsForTurn(orgId, repoId),
        this.conventions.attachedSlug(orgId, repoId),
        this.conventions.resolveForRepo(orgId, repoId),
      ]);

    return {
      mounts: mounts.map((m) => ({ path: m.path, mode: m.mode })),
      setupScript: { present: !!setupScript, length: setupScript?.length ?? 0 },
      secretFiles: secretFiles.map((f) => ({ path: f.path, label: f.label ?? null })),
      mcpServers: mcpRows.map((r) => ({
        name: r.name,
        tier: r.scope === '*' ? 'org' : 'repo',
        surfaces: r.surfaces,
        enabled: r.enabled,
      })),
      skills: skillRows.map((r) => ({
        name: r.name,
        tier: r.scope === '*' ? 'org' : 'repo',
        description: r.description,
        enabled: r.enabled,
      })),
      houseStyle: houseStyleSlug
        ? { slug: houseStyleSlug, name: houseStyle?.name ?? null }
        : null,
    };
  }

  /**
   * Host-derived gaps in the profile — misconfigurations the brain cannot see from the snapshot. Cheap,
   * conditional: returns [] when the profile is healthy, so the caller renders nothing (no prompt bloat).
   * v1: an approved MCP server with a declared secret slot that has never been filled (it silently fails
   * auth). Returns secret-SAFE strings only (slot names, never values).
   */
  async computeGaps(orgId: string, repoId: string): Promise<ProfileGap[]> {
    const gaps: ProfileGap[] = [];
    const unfilled = await this.mcp.unfilledSecretSlots(orgId, repoId);
    for (const u of unfilled) {
      gaps.push({
        kind: 'unfilled_mcp_secret',
        detail: `MCP server "${u.name}" [${u.scope}] has unfilled secret slot(s): ${u.slots.join(', ')} — it cannot authenticate until filled via request_secret({ mcp: { server, slot, key } }).`,
      });
    }
    return gaps;
  }

  /** Render gaps as a compact block appended after the snapshot. Returns '' when there are none. */
  renderGaps(gaps: ProfileGap[]): string {
    if (gaps.length === 0) return '';
    return ['PROFILE GAPS (fix these so future jobs inherit a working profile):', ...gaps.map((g) => `- ${g.detail}`)].join('\n');
  }

  /** Render a snapshot as a compact markdown block for the brain prompt. Returns '' when totally empty. */
  render(s: WorkspaceProfileSnapshot): string {
    const lines: string[] = [];

    lines.push(
      s.mounts.length
        ? `- Mounts: ${s.mounts.map((m) => `${m.path} (${m.mode})`).join(', ')}`
        : '- Mounts: none',
    );
    lines.push(
      s.setupScript.present
        ? `- Setup script: recorded (${s.setupScript.length} chars)`
        : '- Setup script: none',
    );
    lines.push(
      s.secretFiles.length
        ? `- Secret files: ${s.secretFiles.map((f) => f.path + (f.label ? ` (${f.label})` : '')).join(', ')}`
        : '- Secret files: none',
    );
    lines.push(
      s.mcpServers.length
        ? `- MCP servers: ${s.mcpServers
            .map((m) => `${m.name} [${m.tier}${m.enabled ? '' : ', disabled'}]`)
            .join(', ')}`
        : '- MCP servers: none',
    );
    // NOTE: no "Skills:" line here (dropped) — the SDK's native `skills: 'all'` listing (engine-core.ts)
    // now owns skill surfacing for the model, with its own 1%-context budget + progressive disclosure.
    // Repeating bare names here was pure duplication (see the skills-redesign plan's duplication finding).
    lines.push(
      s.houseStyle
        ? `- House style: ${s.houseStyle.name ?? s.houseStyle.slug} (${s.houseStyle.slug})`
        : '- House style: none',
    );

    return lines.join('\n');
  }
}
