import { Injectable } from '@nestjs/common';
import { WorktreeConfigStore } from '../onboarding/worktree-config.store';
import { WorktreeSecretFileStore } from '../onboarding/worktree-secret.store';
import { McpServerStore } from '../mcp';
import { WorkspaceSkillStore } from '../skills';
import { ConventionProfileResolver } from '../conventions';

/**
 * The current state of a repo's WORKSPACE PROFILE — the one named area (secrets, mounts, caches, setup,
 * MCP servers, skills, house style) Atlas provisions ONCE at onboarding and keeps current on every job
 * after. A read-only projection: never a secret VALUE, only refs/metadata safe to show the brain.
 */
export interface WorkspaceProfileSnapshot {
  /** Durable bind mounts (cache/state dirs) — `write_worktree_config`. */
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
    private readonly worktreeConfig: WorktreeConfigStore,
    private readonly secretFiles: WorktreeSecretFileStore,
    private readonly mcp: McpServerStore,
    private readonly skills: WorkspaceSkillStore,
    private readonly conventions: ConventionProfileResolver,
  ) {}

  /** Aggregate the current state across all seven dimensions (~5 cheap queries). */
  async describe(orgId: string, repoId: string): Promise<WorkspaceProfileSnapshot> {
    const [mounts, setupScript, secretFiles, mcpRows, skillRows, houseStyleSlug, houseStyle] =
      await Promise.all([
        this.worktreeConfig.listMounts(orgId, repoId),
        this.worktreeConfig.getSetupScript(orgId, repoId),
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
    lines.push(
      s.skills.length
        ? `- Skills: ${s.skills
            .map((k) => `${k.name} [${k.tier}${k.enabled ? '' : ', disabled'}]`)
            .join(', ')}`
        : '- Skills: none',
    );
    lines.push(
      s.houseStyle
        ? `- House style: ${s.houseStyle.name ?? s.houseStyle.slug} (${s.houseStyle.slug})`
        : '- House style: none',
    );

    return lines.join('\n');
  }
}
