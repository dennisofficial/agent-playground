import { Injectable } from '@nestjs/common';
import { ConventionProfileResolver } from '../conventions/convention-profile.resolver';
import { McpServerStore } from '../mcp/mcp-server.store';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { WorkspaceSecretFileStore } from '../onboarding/workspace-secret.store';
import { WorkspaceSkillStore } from '../skills/workspace-skill.store';

export interface WorkspaceProfileSnapshot {
  mounts: { path: string; mode: string }[];
  setupScript: { present: boolean; length: number };
  previewRecipe: { present: boolean; length: number };
  secretFiles: { path: string; label: string | null }[];
  mcpServers: {
    name: string;
    tier: 'org' | 'repo';
    surfaces: string[];
    enabled: boolean;
  }[];
  skills: {
    name: string;
    tier: 'org' | 'repo';
    description: string;
    enabled: boolean;
  }[];
  houseStyle: { slug: string; name: string | null } | null;
}

export interface ProfileGap {
  kind: 'unfilled_mcp_secret' | 'new_stack' | 'broken_auth' | 'needs_oauth_connect';
  detail: string;
}

const gapKey = (scope: string, name: string): string => `${scope}\u0000${name}`;

@Injectable()
export class WorkspaceProfileService {
  constructor(
    private readonly workspaceConfig: WorkspaceConfigStore,
    private readonly secretFiles: WorkspaceSecretFileStore,
    private readonly mcp: McpServerStore,
    private readonly skills: WorkspaceSkillStore,
    private readonly conventions: ConventionProfileResolver,
  ) {}

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

    const unfilledKeys = new Set(unfilled.map((u) => gapKey(u.scope, u.name)));
    const authFailing = await this.mcp.authFailingServers(orgId, repoId);
    for (const s of authFailing) {
      if (unfilledKeys.has(gapKey(s.scope, s.name))) continue;
      const detail =
        s.authKind === 'oauth'
          ? `MCP server "${s.name}" [${s.scope}] needs re-authorization (OAuth refresh failed) — the OWNER must Reconnect it from the MCP proposal card or the console (MCP settings → Reconnect); the brain cannot re-consent OAuth itself.`
          : `MCP server "${s.name}" [${s.scope}] is failing auth (${s.reason}) — re-provide its credential via request_secret({ mcp: { server, slot, key } }), then reset_sandbox to reload.`;
      gaps.push({ kind: 'broken_auth', detail });
    }

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

  renderGaps(gaps: ProfileGap[]): string {
    if (gaps.length === 0) return '';
    return [
      'PROFILE GAPS (fix these so future jobs inherit a working profile):',
      ...gaps.map((g) => `- ${g.detail}`),
    ].join('\n');
  }

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
    lines.push(
      s.houseStyle
        ? `- House style: ${s.houseStyle.name ?? s.houseStyle.slug} (${s.houseStyle.slug})`
        : '- House style: none',
    );

    return lines.join('\n');
  }
}
