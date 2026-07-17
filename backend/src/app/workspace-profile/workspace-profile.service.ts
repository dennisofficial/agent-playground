import { Injectable } from '@nestjs/common';
import { ConventionProfileResolver } from '../conventions';
import { McpServerStore } from '../mcp';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { WorkspaceSecretFileStore } from '../onboarding/workspace-secret.store';
import { WorkspaceSkillStore } from '../skills';

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
  /** The demo-ready preview recipe — `write_preview_instructions`. Presence + size only. */
  previewRecipe: { present: boolean; length: number };
  /** Secret FILE refs the hydrator renders in — `request_secret`/`request_file`. Path + label ONLY. */
  secretFiles: { path: string; label: string | null }[];
  /** MCP servers effective for this repo — `propose_mcp_servers`. Name/tier/surfaces/enabled, no secrets. */
  mcpServers: {
    name: string;
    tier: 'org' | 'repo';
    surfaces: string[];
    enabled: boolean;
  }[];
  /** Skills effective for this repo — `propose_skill`. Name/tier/description/enabled. */
  skills: {
    name: string;
    tier: 'org' | 'repo';
    description: string;
    enabled: boolean;
  }[];
  /** The attached house-style profile — `propose_convention_profile`. Slug + display name, or null. */
  houseStyle: { slug: string; name: string | null } | null;
}

/**
 * A host-DERIVED gap in the Workspace Profile — a misconfiguration the brain cannot see from the
 * snapshot alone, surfaced conditionally so upkeep is a concrete signal rather than standing prompt
 * prose. Covers: an approved MCP server with an unfilled secret slot (silently can't authenticate), and
 * a NEW dependency manifest the profile hasn't acknowledged (a stack that may want a skill/MCP), and an
 * MCP server whose auth USED to work and later FAILED (expired static secret / dead OAuth refresh token).
 */
export interface ProfileGap {
  kind: 'unfilled_mcp_secret' | 'new_stack' | 'broken_auth' | 'needs_oauth_connect';
  /** Human-readable, secret-SAFE (names only) description including the tool to fix it. */
  detail: string;
}

const gapKey = (scope: string, name: string): string => `${scope}\u0000${name}`;

/**
 * Read-model over the seven Workspace Profile dimensions. It COMPOSES the existing per-dimension stores —
 * it owns NO storage of its own — and renders a compact snapshot the brain sees every turn (see
 * `prompt-kit/system/groups/workspace-profile.group.ts`). This is what makes "keep it up to date" actionable:
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
    const [
      mounts,
      setupScript,
      previewInstructions,
      secretFiles,
      mcpRows,
      skillRows,
      houseStyleSlug,
      houseStyle,
    ] = await Promise.all([
      this.workspaceConfig.listMounts(orgId, repoId),
      this.workspaceConfig.getSetupScript(orgId, repoId),
      this.workspaceConfig.getPreviewInstructions(orgId, repoId),
      this.secretFiles.list(orgId, repoId),
      this.mcp.rowsForTurn(orgId, repoId),
      this.skills.rowsForTurn(orgId, repoId),
      this.conventions.attachedSlug(orgId, repoId),
      this.conventions.resolveForRepo(orgId, repoId),
    ]);

    return {
      mounts: mounts.map((m) => ({ path: m.path, mode: m.mode })),
      setupScript: { present: !!setupScript, length: setupScript?.length ?? 0 },
      previewRecipe: {
        present: !!previewInstructions,
        length: previewInstructions?.length ?? 0,
      },
      secretFiles: secretFiles.map((f) => ({
        path: f.path,
        label: f.label ?? null,
      })),
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
      houseStyle: houseStyleSlug ? { slug: houseStyleSlug, name: houseStyle?.name ?? null } : null,
    };
  }

  /**
   * Host-derived gaps in the profile — misconfigurations the brain cannot see from the snapshot. Cheap,
   * conditional: returns [] when the profile is healthy, so the caller renders nothing (no prompt bloat).
   * Sources: (1) an approved MCP server with a declared secret slot that has never been filled (silently
   * fails auth); (2) a NEW dependency manifest present in the worktree that the profile hasn't yet
   * acknowledged (`repos.profile_seen_manifests`) — the "noticed a new package" signal. Pass
   * `currentManifests` (from `detectRepoManifests`) to enable (2); omit it to skip the worktree-dependent
   * check. Returns secret-SAFE strings only.
   */
  async computeGaps(
    orgId: string,
    repoId: string,
    currentManifests?: string[],
  ): Promise<ProfileGap[]> {
    const gaps: ProfileGap[] = [];

    const unfilled = await this.mcp.unfilledSecretSlots(orgId, repoId);
    for (const u of unfilled) {
      gaps.push({
        kind: 'unfilled_mcp_secret',
        detail: `MCP server "${u.name}" [${u.scope}] has unfilled secret slot(s): ${u.slots.join(', ')} — it cannot authenticate until filled via request_secret({ mcp: { server, slot, key } }).`,
      });
    }

    // Broken auth: a server that USED to work and later failed its validation probe (expired static
    // secret / dead OAuth refresh token). De-dupe against the unfilled set (name+scope): a never-filled
    // slot is already reported above and shouldn't also read as "broken" — unfilled wins.
    const unfilledKeys = new Set(unfilled.map((u) => gapKey(u.scope, u.name)));
    const authFailing = await this.mcp.authFailingServers(orgId, repoId);
    for (const s of authFailing) {
      if (unfilledKeys.has(gapKey(s.scope, s.name))) continue;
      // The fix differs by auth kind: the brain CAN re-provide a static secret itself, but OAuth
      // re-consent is operator-only (it cannot re-authorize an OAuth flow).
      const detail =
        s.authKind === 'oauth'
          ? `MCP server "${s.name}" [${s.scope}] needs re-authorization (OAuth refresh failed) — the OWNER must Reconnect it from the MCP proposal card or the console (MCP settings → Reconnect); the brain cannot re-consent OAuth itself.`
          : `MCP server "${s.name}" [${s.scope}] is failing auth (${s.reason}) — re-provide its credential via request_secret({ mcp: { server, slot, key } }), then reset_sandbox to reload.`;
      gaps.push({ kind: 'broken_auth', detail });
    }

    // Needs-connect: an OAuth server registered but never connected (no access token — a never-started or
    // started-but-cancelled consent). Only the OWNER can complete OAuth consent, so the brain can't fix it
    // itself; the nudge keeps it from being silently forgotten once the proposal card scrolls away. Dedup
    // defensively against the already-emitted keys (exclusive with broken_auth/unfilled in practice).
    const emitted = new Set([
      ...unfilled.map((u) => gapKey(u.scope, u.name)),
      ...authFailing.map((s) => gapKey(s.scope, s.name)),
    ]);
    const needConnect = await this.mcp.needsOAuthConnect(orgId, repoId);
    for (const s of needConnect) {
      if (emitted.has(gapKey(s.scope, s.name))) continue;
      gaps.push({
        kind: 'needs_oauth_connect',
        detail: `MCP server "${s.name}" [${s.scope}] is registered but not yet connected (OAuth consent never completed) — the OWNER must Connect it: use the Connect button on the MCP proposal card, or the console (MCP settings → Connect). The brain cannot consent OAuth itself.`,
      });
    }

    // New-stack: only once the profile has been SEEDED (seen !== null) — an un-onboarded repo never
    // nags. A manifest present now but not acknowledged means a stack the profile hasn't covered.
    if (currentManifests && currentManifests.length > 0) {
      const seen = await this.workspaceConfig.getSeenManifests(orgId, repoId);
      if (seen) {
        const seenSet = new Set(seen);
        const fresh = currentManifests.filter((m) => !seenSet.has(m));
        if (fresh.length > 0) {
          gaps.push({
            kind: 'new_stack',
            detail: `New dependency manifest(s) not yet reflected in the profile: ${fresh.join(', ')} — consider whether this stack wants a skill (propose_skill) or an MCP server (propose_mcp_servers), and record any bring-up in write_setup_script.`,
          });
        }
      }
    }

    return gaps;
  }

  /** Render gaps as a compact block appended after the snapshot. Returns '' when there are none. */
  renderGaps(gaps: ProfileGap[]): string {
    if (gaps.length === 0) return '';
    return [
      'PROFILE GAPS (fix these so future jobs inherit a working profile):',
      ...gaps.map((g) => `- ${g.detail}`),
    ].join('\n');
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
      s.previewRecipe.present
        ? `- Preview recipe: recorded (${s.previewRecipe.length} chars)`
        : '- Preview recipe: none',
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
