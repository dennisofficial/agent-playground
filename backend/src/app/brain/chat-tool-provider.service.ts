import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Decision, TurnEnvelope } from '@shared/domain';
import type { ToolImpl } from '@shared/engine/engine.types';
import {
  type McpProposalServer,
  type WebQuestionCard,
  webConventionProposalCard,
  webConventionEditProposalCard,
  webMcpProposalCard,
  webSkillEditAccessCard,
  webSkillProposalCard,
} from '../surface';
import type {
  McpAuthKind,
  McpOAuthTokenAuthMethod,
  McpSurface,
  StoredMcpOAuthConfig,
} from '../persistence/entities';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import { BuildShipService } from '../driver/build-ship.service';
import { shipOpenPrBody } from '../prompt-kit';
import { WorkspaceConfigStore, WorkspaceSecretFileStore } from '../onboarding';
import { McpServerStore } from '../mcp';
import { ConventionProfileResolver } from '../conventions';
import {
  SkillFileWriter,
  SkillInstallerService,
  WorkspaceSkillStore,
} from '../skills';
import { detectRepoManifests } from '../workspace-profile';
import { normalizeMounts } from '../sandbox/container-paths';
import { LocalGitService } from '../git';
import { isReservedMcpName } from '../sandbox/image/reserved-mcp-names';
import { renderDecisionRecordMd } from './decision-record-md';
import { BrainStoreService } from './brain-store.service';
import { SelfSufficiencyToolsService } from './self-sufficiency-tools.service';
import { DRIVER_REPO, type DriverRepoResolver } from '../driver/repo-resolver';

/** A safe, short error message for a tool's `{ ok:false, reason }` (surfaces validation/404 cleanly). */
function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err)
    return String(err.message).slice(0, 200);
  return String(err).slice(0, 200);
}

/**
 * The chat-turn tool surface's LEAF tool builders — the `build<X>Tool` closures that depend only on durable
 * leaf services (store, workspace config/secret stores, skills/MCP/convention stores, lifecycle, git, ship)
 * with no reach back into the turn engine. Extracted verbatim from `AgentSessionManager` so this slice of the
 * tool surface can be reused later; `AgentSessionManager.buildTools` delegates to these methods. The
 * curation/assembly (which tools each kind/role gets), the `reset_sandbox` tool, and the turn-callback-coupled
 * inline closures (propose_plan/dispatch_build/finalize_build/… ) stay on `AgentSessionManager`.
 */
@Injectable()
export class ChatToolProvider {
  private readonly logger = new Logger(ChatToolProvider.name);

  constructor(
    private readonly store: BrainStoreService,
    private readonly lifecycle: JobLifecycleService,
    private readonly ship: BuildShipService,
    private readonly secretStore: WorkspaceSecretFileStore,
    private readonly configStore: WorkspaceConfigStore,
    private readonly git: LocalGitService,
    private readonly selfSufficiency: SelfSufficiencyToolsService,
    @Inject(DRIVER_REPO) private readonly repos: DriverRepoResolver,
    @Optional() private readonly conventions?: ConventionProfileResolver,
    @Optional() private readonly mcpStore?: McpServerStore,
    @Optional() private readonly skillStore?: WorkspaceSkillStore,
    @Optional() private readonly skillFiles?: SkillFileWriter,
    @Optional() private readonly skillInstaller?: SkillInstallerService,
  ) {}

  /**
   * `request_secret` / `request_file` / `recall` / `remember` — the shared self-sufficiency toolset,
   * dispatched through `SelfSufficiencyToolsService` so the brain and headless build threads run the SAME
   * handler bodies. org/repo/job/author come from the stimulus's closure (never tool args) — tenant safety.
   */
  selfSufficiencyTools(stimulus: TurnEnvelope) {
    return this.selfSufficiency.buildTools({
      jobId: stimulus.jobId,
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      authorId: stimulus.author.id,
      defaultQuery: stimulus.body,
    });
  }

  /**
   * `withdraw_file_request({ requestId, reason? })` — retract a still-open `request_file` card (wrong path,
   * no longer needed). The file-card mirror of `withdraw_question`: race-safe + idempotent (if the operator
   * already uploaded, the withdraw is a no-op and you should work from the delivered file, not re-request).
   * A withdrawn card greys out (no file picker) and a racing upload for it becomes a no-op. org/repo/job
   * come from the closure (never tool args) — tenant safety.
   */
  buildWithdrawFileRequestTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const requestId = String(args['requestId'] ?? '').trim();
      if (!requestId) return { ok: false, reason: 'requestId is required' };
      const reason = String(args['reason'] ?? '').trim();
      const res = await this.store.withdrawFileRequest(
        stimulus.jobId,
        requestId,
        reason || undefined,
      );
      if (!res.withdrawn) {
        return {
          ok: false,
          reason:
            'That file request could not be withdrawn — it was already uploaded, already withdrawn, or not ' +
            'found. If the operator already uploaded it, work from that file instead of re-requesting.',
        };
      }
      return {
        ok: true,
        requestId,
        message:
          'File request withdrawn — the operator no longer sees it as awaiting an upload. Post a corrected ' +
          'request_file if you still need a file.',
      };
    };
  }

  /**
   * `withdraw_secret_request({ requestId, reason? })` — retract a still-open durable/mcp `request_secret`
   * card (wrong target, no longer needed). The secret-card mirror of `withdraw_file_request`: race-safe +
   * idempotent (if the operator already submitted the value, the withdraw is a no-op). Applies only to the
   * per-card durable/mcp lane — the ephemeral (`deliver_to`) lane is single-slot and not withdrawable here.
   * org/repo/job come from the closure (never tool args) — tenant safety.
   */
  buildWithdrawSecretRequestTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const requestId = String(args['requestId'] ?? '').trim();
      if (!requestId) return { ok: false, reason: 'requestId is required' };
      const reason = String(args['reason'] ?? '').trim();
      const res = await this.store.withdrawSecretRequest(
        stimulus.jobId,
        requestId,
        reason || undefined,
      );
      if (!res.withdrawn) {
        return {
          ok: false,
          reason:
            'That secret request could not be withdrawn — it was already provided, already withdrawn, or not ' +
            'found. If the operator already provided it, work from that secret instead of re-requesting.',
        };
      }
      return {
        ok: true,
        requestId,
        message:
          'Secret request withdrawn — the operator no longer sees it as awaiting a value. Post a corrected ' +
          'request_secret if you still need one.',
      };
    };
  }

  /**
   * `derive_secret({ name, path, value, description, overwrite? })` — durably store a value YOU already
   * computed (not operator-provided) — e.g. a webhook signing secret from `stripe listen --print-secret`,
   * derived from an already-granted API key. Unlike `request_secret`, there is NO operator round-trip: you
   * already hold the value (it never came from anywhere an operator needed to gate), so it writes straight
   * to the SAME encrypted store as this repo's secret file at (repo, path), then renders on your next
   * hydration and EVERY future job's — no re-derivation tax. Refuses by default if a value already exists
   * at `path` (protects an operator-provided secret from being silently clobbered) — pass `overwrite: true`
   * only when you are deliberately replacing it. Posts a quiet system-event pill for operator visibility
   * (name/path only, never the value — same rule as every other secret path).
   */
  buildDeriveSecretTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const path = String(args['path'] ?? '').trim();
      const value = String(args['value'] ?? '');
      const description = String(args['description'] ?? '').trim();
      const overwrite = args['overwrite'] === true;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return {
          ok: false,
          reason:
            'name must be an env-var-style identifier (e.g. STRIPE_WEBHOOK_SECRET)',
        };
      }
      if (!path || path.startsWith('/') || path.split('/').includes('..')) {
        return {
          ok: false,
          reason:
            'path must be a worktree-relative file path (e.g. .env.personal), no leading / or ..',
        };
      }
      if (!value) {
        return {
          ok: false,
          reason:
            'value is required — this tool stores a value you already computed, it never generates or asks for one',
        };
      }
      if (!description) {
        return {
          ok: false,
          reason:
            'description is required (what this value is and how you derived it)',
        };
      }
      const existing = await this.secretStore.read(
        stimulus.orgId,
        stimulus.repoId,
        path,
      );
      if (existing != null && !overwrite) {
        return {
          ok: false,
          reason:
            `a secret file already exists at "${path}" (possibly operator-provided) — pass overwrite: true ` +
            'only if you are deliberately replacing it, or pick a different path',
        };
      }
      // A single write IS the value + the authority: (repo, path) is the file's identity; `name` rides
      // along as the display label. Renders on your next hydration and every future job's.
      await this.secretStore.write(
        stimulus.orgId,
        stimulus.repoId,
        path,
        value,
        name,
      );
      await this.store.appendSystemEvent(
        stimulus.jobId,
        `🔑 Derived and stored \`${name}\` (${description}) — future jobs on this repo won't need to re-derive it.`,
      );
      return { ok: true, name, path, overwritten: existing != null };
    };
  }

  /**
   * `write_workspace_config({ mounts })` — AMEND the repo's DB-backed workspace config (the NON-secret
   * hydration half: cache/auth mounts; see docs/adr/0003). A pure DB write keyed by org+repo — a mount is
   * upserted by `path` (same path replaces that entry, everything else untouched) — it never
   * blind-overwrites, and it needs no sandbox. This is what makes it safe as an ANY-THREAD tool: the
   * ceremony calls it repeatedly while authoring from scratch, and a later build thread can add ONE mount
   * without wiping out what the ceremony (or an earlier amendment) already recorded, AND it reaches every
   * OTHER in-flight job's very next hydration instantly — no PR, no wait. Secrets are NEVER written here
   * (they live as encrypted grants); a `secrets` field is rejected. Validated before write.
   */
  buildWriteWorkspaceConfigTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      if (args['secrets'] !== undefined) {
        return {
          ok: false,
          reason:
            'secrets do not go in workspace config — use request_secret instead',
        };
      }
      const { mounts: newMounts, warnings } = normalizeMounts(args['mounts']);

      // A DB hiccup here must never crash the turn — warn, tell Atlas the real error via `reason` (its
      // next tool call is retryable), don't leave it silently believing the write landed.
      try {
        // Snapshot the mount SET before the upserts: a genuinely new/changed mount changes the container's
        // mount fingerprint, so its NEXT attach recreates the container (binds only apply at create time).
        // We warn about that so the brain configures mounts BEFORE starting long-running processes — adding a
        // mount mid-login was what silently killed the gcloud process + wiped its `.gcloud` dir.
        const priorMountSig = (
          await this.configStore.listMounts(stimulus.orgId, stimulus.repoId)
        )
          .map((m) => `${m.path}:${m.mode}`)
          .sort()
          .join(',');
        for (const m of newMounts) {
          await this.configStore.upsertMount(
            stimulus.orgId,
            stimulus.repoId,
            m.path,
            m.mode,
          );
        }

        const mounts = await this.configStore.listMounts(
          stimulus.orgId,
          stimulus.repoId,
        );
        const mountSetChanged =
          mounts
            .map((m) => `${m.path}:${m.mode}`)
            .sort()
            .join(',') !== priorMountSig;
        await this.store.appendSystemEvent(
          stimulus.jobId,
          `⚙️ Updated workspace config (${mounts.length} mount(s)) — live for every job on this repo immediately.` +
            (mountSetChanged
              ? ' The mount set changed — this sandbox recreates on your NEXT turn (in-container processes/state are lost); configure mounts BEFORE starting a login or other long-running process.'
              : ''),
        );
        return {
          ok: true,
          mounts: mounts.length,
          ...(mountSetChanged ? { restarts_sandbox: true } : {}),
          ...(warnings.length ? { warnings } : {}),
        };
      } catch (err) {
        this.logger.warn(
          `write_workspace_config failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `write_setup_script({ script })` — save (or clear, with an empty `script`) the repo's DB-backed cold-boot
   * SETUP SCRIPT. The host runs it on every COLD sandbox bring-up (fresh create / restart-from-stopped /
   * `reset_sandbox`) for EVERY future job on this repo — no PR — and skips it on a warm reuse. It MUST be
   * idempotent (it re-runs on each cold boot) and must NOT init submodules (already automatic). org/repo come
   * from the closure (never tool args) — tenant safety. Writes to the same store as `write_workspace_config`.
   * The right way to test it is `reset_sandbox`, which recreates the container so the script runs cold.
   */
  buildWriteSetupScriptTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const script = String(args['script'] ?? '').trim()
        ? String(args['script'])
        : null;
      try {
        await this.configStore.setSetupScript(
          stimulus.orgId,
          stimulus.repoId,
          script,
        );
        // Recording a setup script is an "I've addressed the stack" moment — acknowledge the worktree's
        // current dependency manifests so a manifest already present stops reading as a NEW stack.
        if (script) {
          const sandbox = await this.lifecycle.findSandbox(
            stimulus.jobId,
            stimulus.orgId,
          );
          if (sandbox)
            await this.refreshSeenManifests(
              stimulus.orgId,
              stimulus.repoId,
              sandbox.worktreePath,
            );
        }
        await this.store.appendSystemEvent(
          stimulus.jobId,
          script
            ? '⚙️ Saved the repo setup script — it runs on every COLD sandbox bring-up for every job on this repo. Call `reset_sandbox` to test it cold.'
            : '⚙️ Cleared the repo setup script — no cold-boot setup step will run.',
        );
        return { ok: true, saved: !!script };
      } catch (err) {
        this.logger.warn(
          `write_setup_script failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `read_setup_script()` — return the repo's CURRENT cold-boot setup script (the raw body, not just its
   * length like the profile snapshot). Read-before-edit for `write_setup_script`, which REPLACES the whole
   * script: read it here, edit the body, then write the full new script back. Pure read — no mutation, no
   * system event. org/repo come from the closure (never tool args) — tenant safety. Reuses the same store
   * (`WorkspaceConfigStore.getSetupScript`) that resolves the script on cold attach.
   */
  buildReadSetupScriptTool(stimulus: TurnEnvelope): ToolImpl {
    return async () => {
      try {
        const script = await this.configStore.getSetupScript(
          stimulus.orgId,
          stimulus.repoId,
        );
        return { ok: true, present: script !== null, script };
      } catch (err) {
        this.logger.warn(
          `read_setup_script failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  buildWritePreviewInstructionsTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const instructions = String(args['instructions'] ?? '').trim()
        ? String(args['instructions'])
        : null;
      try {
        await this.configStore.setPreviewInstructions(
          stimulus.orgId,
          stimulus.repoId,
          instructions,
        );
        await this.store.appendSystemEvent(
          stimulus.jobId,
          instructions
            ? '🎬 Saved the repo preview recipe — it is injected into the "Spin up preview" seed for every job on this repo. `read_preview_instructions` to amend (write REPLACES the whole recipe).'
            : '🎬 Cleared the repo preview recipe — the Spin-up-preview seed will prompt to save a fresh one.',
        );
        return { ok: true, saved: !!instructions };
      } catch (err) {
        this.logger.warn(
          `write_preview_instructions failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  buildReadPreviewInstructionsTool(stimulus: TurnEnvelope): ToolImpl {
    return async () => {
      try {
        const instructions = await this.configStore.getPreviewInstructions(
          stimulus.orgId,
          stimulus.repoId,
        );
        return { ok: true, present: instructions !== null, instructions };
      } catch (err) {
        this.logger.warn(
          `read_preview_instructions failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * Record the worktree's current dependency manifests as ACKNOWLEDGED (`repos.profile_seen_manifests`) —
   * the baseline the new-stack gap diffs against (see `WorkspaceProfileService.computeGaps`). Seeded when
   * onboarding finishes (the bulk pass saw the whole stack) and refreshed when a setup script is recorded.
   * Best-effort: never throws into the caller.
   */
  private async refreshSeenManifests(
    orgId: string,
    repoId: string,
    worktreePath: string,
  ): Promise<void> {
    try {
      await this.configStore.setSeenManifests(
        orgId,
        repoId,
        detectRepoManifests(worktreePath),
      );
    } catch (err) {
      this.logger.warn(
        `refreshSeenManifests failed for org=${orgId} repo=${repoId}: ${err}`,
      );
    }
  }

  /**
   * `propose_mcp_servers({ servers })` — recommend a stack-matched set of MCP servers for the operator to
   * approve, mirroring Anthropic's "Claude Code Setup" plugin. The brain NEVER writes an MCP server itself
   * (that's an owner-only Administer action, gated the same as the console `McpServersController`): this
   * posts a value-FREE PROPOSAL card that the OWNER approves at the owner-gated
   * `…/jobs/:jobId/mcp-proposals/:requestId/approve` endpoint, which commits each server on THIS repo's
   * scope. Secret header/env slots are declared here by NAME only (`secret:true`) and filled AFTER approval
   * via `request_secret` (with an `mcp` target) — no secret value ever passes through this tool. Reserved
   * system names are rejected. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  buildProposeMcpServersTool(stimulus: TurnEnvelope): ToolImpl {
    const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
    const VALID_SURFACES = new Set<McpSurface>(['brain', 'build', 'review']);
    // A secret entry carries NO value (the operator supplies it later via request_secret — invariant). A
    // non-secret entry may carry a static value (e.g. an API-version header) since it isn't a credential.
    const normPairs = (
      v: unknown,
    ): { name: string; secret?: boolean; value?: string }[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const out: { name: string; secret?: boolean; value?: string }[] = [];
      for (const e of v as unknown[]) {
        const rec = (e ?? {}) as Record<string, unknown>;
        const n = String(rec['name'] ?? '').trim();
        if (!n) continue;
        if (rec['secret'] === true) {
          out.push({ name: n, secret: true });
        } else {
          const val = rec['value'] != null ? String(rec['value']) : undefined;
          out.push(val != null ? { name: n, value: val } : { name: n });
        }
      }
      return out.length > 0 ? out : undefined;
    };
    return async (args) => {
      const raw = Array.isArray(args['servers'])
        ? (args['servers'] as unknown[])
        : null;
      if (!raw || raw.length === 0) {
        return {
          ok: false,
          reason:
            'servers must be a non-empty array of proposed MCP server definitions',
        };
      }
      const servers: McpProposalServer[] = [];
      for (const item of raw) {
        const s = (item ?? {}) as Record<string, unknown>;
        const name = String(s['name'] ?? '').trim();
        if (!NAME_RE.test(name)) {
          return {
            ok: false,
            reason: `invalid server name "${name}" — use letters/digits/_/- (e.g. github, sentry)`,
          };
        }
        if (isReservedMcpName(name)) {
          return {
            ok: false,
            reason: `"${name}" is a reserved system server (already provided) — pick a different tool`,
          };
        }
        const transport = String(s['transport'] ?? '').trim();
        if (
          transport !== 'http' &&
          transport !== 'sse' &&
          transport !== 'stdio'
        ) {
          return {
            ok: false,
            reason: `server "${name}": transport must be http | sse | stdio`,
          };
        }
        const url = String(s['url'] ?? '').trim() || undefined;
        const command = String(s['command'] ?? '').trim() || undefined;
        // Transport-shape guard (mirrors McpServersController.assertShape).
        if (transport === 'stdio') {
          if (!command)
            return {
              ok: false,
              reason: `server "${name}": stdio transport requires a command`,
            };
        } else if (!url) {
          return {
            ok: false,
            reason: `server "${name}": ${transport} transport requires a url`,
          };
        }
        const argv = Array.isArray(s['args'])
          ? (s['args'] as unknown[]).map((a) => String(a))
          : undefined;
        const headers = normPairs(s['headers']);
        const env = normPairs(s['env']);
        const surfaces = (
          Array.isArray(s['surfaces'])
            ? (s['surfaces'] as unknown[]).map((x) => String(x))
            : []
        ).filter((x): x is McpSurface => VALID_SURFACES.has(x as McpSurface));
        const reason = String(s['reason'] ?? '').trim() || undefined;
        // Auth kind: 'static' (header/env slots filled via request_secret) or 'oauth' (interactive OAuth 2.1
        // the OWNER completes via Connect). OAuth is http/sse-only and owns the Authorization header itself,
        // so a secret slot on an oauth server is invalid (it would read as an unfillable gap). Mirrors
        // McpServersController.assertShape.
        const authKind: McpAuthKind =
          s['authKind'] === 'oauth' ? 'oauth' : 'static';
        if (authKind === 'oauth') {
          if (transport === 'stdio') {
            return {
              ok: false,
              reason: `server "${name}": oauth is only supported for http/sse transports`,
            };
          }
          if (
            (headers ?? []).some((h) => h.secret) ||
            (env ?? []).some((e) => e.secret)
          ) {
            return {
              ok: false,
              reason: `server "${name}": an oauth server must NOT declare secret header/env slots — the OWNER completes OAuth with the proposal-card Connect button or in the console (MCP settings → Connect); OAuth manages the Authorization header itself`,
            };
          }
        }
        const oauthRaw = (s['oauth'] ?? {}) as Record<string, unknown>;
        const oauthScope = String(oauthRaw['scope'] ?? '').trim() || undefined;
        const oauthTam = [
          'none',
          'client_secret_post',
          'client_secret_basic',
        ].includes(String(oauthRaw['tokenAuthMethod'] ?? ''))
          ? (String(oauthRaw['tokenAuthMethod']) as McpOAuthTokenAuthMethod)
          : undefined;
        const oauth: StoredMcpOAuthConfig | undefined =
          authKind === 'oauth' && (oauthScope || oauthTam)
            ? {
                ...(oauthScope ? { scope: oauthScope } : {}),
                ...(oauthTam ? { tokenAuthMethod: oauthTam } : {}),
              }
            : undefined;
        servers.push({
          name,
          transport,
          ...(url ? { url } : {}),
          ...(command ? { command } : {}),
          ...(argv && argv.length ? { args: argv } : {}),
          ...(headers ? { headers } : {}),
          ...(env ? { env } : {}),
          ...(surfaces.length ? { surfaces } : {}),
          ...(reason ? { reason } : {}),
          ...(authKind === 'oauth' ? { authKind } : {}),
          ...(oauth ? { oauth } : {}),
        });
      }
      const lowerNames = servers.map((s) => s.name.toLowerCase());
      if (new Set(lowerNames).size !== lowerNames.length) {
        return { ok: false, reason: 'duplicate server names in the proposal' };
      }
      // Registration scope: 'repo' (this repo only, the default) or 'org' (every repo in the org) — mirrors
      // propose_skill. Repo scope OVERRIDES an org server of the same name at resolve time.
      const scope: 'org' | 'repo' =
        String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';
      try {
        const requestId = `mcp-${randomUUID()}`;
        const card = webMcpProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          servers,
        });
        const opened = await this.store.openMcpProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason: 'Could not open the MCP proposal (thread not found).',
          };
        const needSecrets = servers.flatMap((s) => [
          ...(s.headers ?? [])
            .filter((h) => h.secret)
            .map((h) => `${s.name} header:${h.name}`),
          ...(s.env ?? [])
            .filter((e) => e.secret)
            .map((e) => `${s.name} env:${e.name}`),
        ]);
        const oauthNames = servers
          .filter((s) => s.authKind === 'oauth')
          .map((s) => s.name);
        return {
          ok: true,
          requestId,
          proposed: servers.map((s) => s.name),
          message:
            `Posted an MCP proposal card for ${servers.length} server(s), ${scope}-scoped. The OWNER approves ` +
            `it to register ${scope === 'org' ? 'them org-wide (every repo)' : 'them on this repo'} — you ` +
            'cannot register servers yourself. Stop and wait for approval. After approval, use request_secret ' +
            '(with an mcp target) to fill each secret slot' +
            (needSecrets.length ? `: ${needSecrets.join('; ')}.` : '.') +
            (oauthNames.length
              ? ` OAuth server(s) [${oauthNames.join(', ')}] have NO secret to fill — after approval the OWNER ` +
                'must Connect them from the MCP proposal card or in the console (MCP settings → Connect) to complete consent. You cannot ' +
                'consent yourself; do NOT try to inject an Authorization/Bearer header via request_secret.'
              : ''),
        };
      } catch (err) {
        this.logger.warn(
          `propose_mcp_servers failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `list_convention_profiles()` — list the org's reusable house-style profiles (slug/name/detect_hint) so
   * the onboarding brain can compare the stack it just mapped against each profile's `detect_hint` and pick
   * the best match (or decide none fits). Read-only; org comes from the closure (never a tool arg).
   */
  buildListConventionProfilesTool(stimulus: TurnEnvelope): ToolImpl {
    return async () => {
      if (!this.conventions)
        return {
          ok: true,
          profiles: [],
          message: 'No house-style profiles are configured.',
        };
      try {
        const profiles = await this.conventions.listProfiles(stimulus.orgId);
        return {
          ok: true,
          profiles,
          message: profiles.length
            ? 'Compare the repo stack you mapped against each `detectHint`, then call propose_convention_profile with the best-matching `slug` — or with "none" if the repo does not follow any of these house styles.'
            : 'This org has no house-style profiles defined — skip propose_convention_profile.',
        };
      } catch (err) {
        this.logger.warn(
          `list_convention_profiles failed for org=${stimulus.orgId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_convention_profile({ slug, rationale })` — recommend the house-style profile that matches THIS
   * repo's stack for the operator to approve. Like `propose_mcp_servers`, the brain NEVER attaches a profile
   * itself (owner-only): a concrete `slug` posts an owner-gated proposal card that the OWNER approves at
   * `…/jobs/:jobId/convention-proposals/:requestId/approve`, which sets `repos.convention_profile_slug`.
   * `slug:'none'` (or empty) posts NO card — a repo that follows no house style just stays unset (the safe
   * default), and the tool acknowledges. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  buildProposeConventionProfileTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const slug = String(args['slug'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      // "none"/empty ⇒ the repo matches no house style; leave the pointer unset (the default) — nothing to approve.
      if (!slug || slug.toLowerCase() === 'none') {
        return {
          ok: true,
          proposed: null,
          message:
            'Recorded that no house-style profile matches this repo — leaving its conventions unset (the default). Continue onboarding.',
        };
      }
      if (!this.conventions)
        return {
          ok: false,
          reason: 'house-style profiles are not configured for this org',
        };
      try {
        const profile = await this.conventions.getProfile(stimulus.orgId, slug);
        if (!profile) {
          return {
            ok: false,
            reason: `no house-style profile "${slug}" exists in this org — call list_convention_profiles to see the valid slugs`,
          };
        }
        const requestId = `conv-${randomUUID()}`;
        const card = webConventionProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          slug: profile.slug,
          profileName: profile.name,
          rationale: rationale || `Matches this repo's stack.`,
        });
        const opened = await this.store.openConventionProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason:
              'Could not open the convention proposal (thread not found).',
          };
        return {
          ok: true,
          requestId,
          proposed: profile.slug,
          message:
            `Posted a house-style proposal card for the "${profile.name}" profile. The OWNER approves it to ` +
            'attach it to this repo — you cannot attach it yourself. Stop and wait for approval, then continue.',
        };
      } catch (err) {
        this.logger.warn(
          `propose_convention_profile failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_convention_profile_change({ slug, name?, body, detectHint?, rationale })` — propose CREATING or
   * EDITING a reusable house-style profile's CONTENT (distinct from `propose_convention_profile`, which
   * ATTACHES an existing one to a repo). A house-style change is cross-cutting — it affects EVERY repo and
   * job in the org — so the brain NEVER writes it: this posts an owner-approvable card, and only the OWNER's
   * approval at `…/jobs/:jobId/convention-edit-proposals/:requestId/approve` upserts the profile. Use this when
   * you notice the reusable convention itself is wrong/outdated (NOT for a this-repo-only durable fact — that
   * belongs in repo memory via `remember`). If `slug` matches an existing profile it's an EDIT (the card
   * shows the prior body); a new `slug` is a CREATE. org/repo/job come from the closure (never tool args).
   */
  buildProposeConventionProfileChangeTool(stimulus: TurnEnvelope): ToolImpl {
    const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    return async (args) => {
      const slug = String(args['slug'] ?? '').trim();
      const body = String(args['body'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const nameArg = String(args['name'] ?? '').trim();
      const detectHintArg = String(args['detectHint'] ?? '').trim();
      if (!SLUG_RE.test(slug)) {
        return {
          ok: false,
          reason:
            'slug must be lowercase letters/digits/_/- (e.g. nestjs-next-shared)',
        };
      }
      if (!body)
        return {
          ok: false,
          reason: 'body (the house-style rules) is required',
        };
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why the house style should change — is required',
        };
      if (!this.conventions)
        return {
          ok: false,
          reason: 'house-style profiles are not configured for this org',
        };
      try {
        const existing = await this.conventions.getProfile(
          stimulus.orgId,
          slug,
        );
        const mode: 'create' | 'update' = existing ? 'update' : 'create';
        const name = nameArg || existing?.name;
        if (!name)
          return {
            ok: false,
            reason: 'name is required when creating a new profile',
          };
        const requestId = `conv-edit-${randomUUID()}`;
        const card = webConventionEditProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          slug,
          name,
          body,
          detectHint: detectHintArg || existing?.detect_hint || null,
          mode,
          ...(existing ? { priorBody: existing.body } : {}),
          rationale,
        });
        const opened = await this.store.openConventionEditProposal(
          stimulus.jobId,
          { requestId, card },
        );
        if (!opened.ok)
          return {
            ok: false,
            reason: 'Could not open the proposal (thread not found).',
          };
        return {
          ok: true,
          requestId,
          mode,
          message:
            `Posted a house-style ${mode === 'create' ? 'creation' : 'change'} proposal for "${name}". Because ` +
            'this changes the reusable convention for EVERY repo in the org, only the OWNER can approve it — you ' +
            'cannot apply it yourself. Do NOT hand-edit repo code to force the new convention; keep building to ' +
            'the CURRENT house style. Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(
          `propose_convention_profile_change failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `list_mcp_servers()` — the MCP servers currently registered for this org (org-wide + repo-scoped).
   * Read-only, ungated — the brain reads it before proposing so it doesn't duplicate an existing server.
   * NEVER returns a secret value (secret header/env slots surface as `secretKeys` names only). org comes
   * from the closure (never tool args) — tenant safety.
   */
  buildListMcpServersTool(stimulus: TurnEnvelope): ToolImpl {
    return async () => {
      if (!this.mcpStore)
        return {
          ok: true,
          servers: [],
          message: 'MCP servers are not configured for this org.',
        };
      try {
        const servers = (await this.mcpStore.list(stimulus.orgId)).map((s) => ({
          name: s.name,
          scope: s.scope === 'org' ? 'org' : 'repo',
          transport: s.transport,
          surfaces: s.surfaces,
          enabled: s.enabled,
          secretKeys: s.secretKeys,
          // Auth model, so the brain reads a 401 correctly: `authKind:'oauth'` + `oauthConnected:false` means
          // the OWNER must Connect it (NOT a request_secret target); `'static'` uses secretKeys.
          authKind: s.authKind,
          oauthConnected: s.oauthConnected,
          // Secret-SAFE failure state so a brain that lists servers sees a broken one directly (not only
          // via the PROFILE GAPS block): `validationError` is a safe message; `needsReauth` is OAuth-only.
          validationError: s.validationError,
          needsReauth: s.needsReauth,
        }));
        return {
          ok: true,
          servers,
          message:
            (servers.length
              ? 'Existing MCP servers — propose_mcp_servers with the SAME name to REPLACE one, or a new name to add one.'
              : 'No MCP servers registered yet — propose_mcp_servers to add the first (owner-approved).') +
            (servers.some((s) => s.authKind === 'oauth' && !s.oauthConnected)
              ? ' An oauth server with oauthConnected:false is NOT broken auth you can fix — the OWNER must Connect it from the MCP proposal card or in the console (MCP settings → Connect). Do not use request_secret / inject an Authorization header for it.'
              : ''),
        };
      } catch (err) {
        this.logger.warn(
          `list_mcp_servers failed for org=${stimulus.orgId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `list_skills()` — the skills currently registered for this org (org-wide + repo-scoped). Read-only,
   * ungated (like `list_convention_profiles`) — the brain reads it before proposing a new/edited one so it
   * doesn't duplicate an existing skill. org comes from the closure (never tool args) — tenant safety.
   */
  buildListSkillsTool(stimulus: TurnEnvelope): ToolImpl {
    return async () => {
      if (!this.skillStore)
        return {
          ok: true,
          skills: [],
          message: 'Skills are not configured for this org.',
        };
      try {
        const skills = (await this.skillStore.list(stimulus.orgId)).map(
          (s) => ({
            name: s.name,
            scope: s.scope === 'org' ? 'org' : 'repo',
            description: s.description,
            surfaces: s.surfaces,
            enabled: s.enabled,
          }),
        );
        return {
          ok: true,
          skills,
          message: skills.length
            ? 'Existing skills — propose_skill with a NEW name to create another; request_skill_edit_access ' +
              'to iteratively edit one of these (Edit/Write, once the owner grants it).'
            : 'No skills registered yet — propose_skill to create the first.',
        };
      } catch (err) {
        this.logger.warn(
          `list_skills failed for org=${stimulus.orgId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_skill({ name, description, scope?, rationale })` — SUBMIT a skill the brain AUTHORED as real
   * files (via its built-in `run-skill-generator` skill) under `/context/skill-drafts/<name>/` for owner
   * approval. NO `body` — a skill is a multi-file dir (SKILL.md + references/scripts/assets), authored with
   * `Read`/`Write`/`Edit` in the writable `/context` scratch area, NOT crammed into a tool arg. This tool
   * FREEZES that draft into an immutable request-scoped staging dir (the brain cannot mutate it after) and
   * posts an owner-approvable card with a preview; only the OWNER's approval at
   * `…/jobs/:jobId/skill-proposals/:requestId/approve` vendors the frozen copy into the store and removes the
   * draft. CREATE-ONLY: a `name` that already exists is refused — to change one, `request_skill_edit_access`
   * and Edit/Write it in place. `scope` is `'repo'` (default) or `'org'`. All lanes (brain/build/review) get
   * the skill — on-demand description-match already gates loading, so there is no per-lane knob. org/repo/job
   * come from the closure (never tool args) — tenant safety.
   */
  buildProposeSkillTool(stimulus: TurnEnvelope): ToolImpl {
    const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    const ALL_SURFACES: McpSurface[] = ['brain', 'build', 'review'];
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const description = String(args['description'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' =
        String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';

      if (!NAME_RE.test(name)) {
        return {
          ok: false,
          reason:
            'name must be lowercase letters/digits/_/- (e.g. house-migrations)',
        };
      }
      if (!description)
        return {
          ok: false,
          reason: 'description (the "Use when …" trigger blurb) is required',
        };
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why this skill helps builds here — is required',
        };
      if (!this.skillStore || !this.skillFiles) {
        return { ok: false, reason: 'skills are not configured for this org' };
      }
      try {
        const dbScope = scope === 'org' ? '*' : stimulus.repoId;
        const existing = await this.skillStore.get(
          stimulus.orgId,
          dbScope,
          name,
        );
        if (existing) {
          return {
            ok: false,
            reason:
              `a ${scope}-scoped skill "${name}" already exists — propose_skill only CREATES. Call ` +
              "request_skill_edit_access({ skill: '" +
              name +
              "' }) to get owner-approved edit access, " +
              'then Edit/Write its files directly.',
          };
        }
        // The brain authors the skill as real files here first (with its built-in run-skill-generator).
        const draftDir = join(
          this.lifecycle.contextDirHost(stimulus.jobId, stimulus.orgId),
          'skill-drafts',
          name,
        );
        if (!existsSync(join(draftDir, 'SKILL.md'))) {
          return {
            ok: false,
            reason:
              `no authored skill found at /context/skill-drafts/${name}/SKILL.md. Author it FIRST — use your ` +
              'built-in run-skill-generator skill to scaffold and write the folder (SKILL.md + any ' +
              'references/scripts) under /context/skill-drafts/' +
              name +
              '/, then call propose_skill again.',
          };
        }
        const requestId = `skill-${randomUUID()}`;
        // Freeze exactly what exists now — approval vendors this immutable copy, not the still-writable draft.
        const stagingPath = this.skillFiles.freezeDraft(
          draftDir,
          stimulus.orgId,
          requestId,
        );
        const preview = this.skillFiles.previewDir(stagingPath) ?? undefined;
        const card = webSkillProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          name,
          description,
          surfaces: ALL_SURFACES,
          mode: 'create',
          rationale,
          stagingPath,
          preview,
        });
        const opened = await this.store.openSkillProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok) {
          this.skillFiles.removeStaging(stimulus.orgId, requestId);
          return {
            ok: false,
            reason: 'Could not open the skill proposal (thread not found).',
          };
        }
        return {
          ok: true,
          requestId,
          mode: 'create',
          message:
            `Posted a skill creation proposal for "${name}" (${scope}-scoped) from your authored files. Only the ` +
            'OWNER can approve it — you cannot register it yourself. On approval it moves into the durable skill ' +
            'store (every future job inherits it) and the draft is removed; it loads on the next fresh session ' +
            '(reset_sandbox to pick it up). Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(
          `propose_skill failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_skill_install({ sourceUrl, ref?, subpath?, scope?, rationale })` — propose INSTALLING a
   * maintained skill from a git marketplace (e.g. `github.com/anthropics/skills`,
   * `github.com/agents-inc/skills`) instead of authoring one from stale memory. SINGLE-skill only: `subpath`
   * MUST point at one skill dir (a `SKILL.md`), not a marketplace root. The tool DRY-RUNS the source
   * (`SkillInstallerService.preview`) to resolve the REAL frontmatter name/description and detect an overwrite
   * conflict, so the owner's card shows exactly what will land. The brain never installs directly — only the
   * OWNER's approval routes to `SkillInstallerService.install` (`provenance:'git'`, auto-updating). `scope` is
   * `'repo'` (default) or `'org'`. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  buildProposeSkillInstallTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const sourceUrl = String(args['sourceUrl'] ?? '').trim();
      const ref = String(args['ref'] ?? '').trim() || undefined;
      const subpath = String(args['subpath'] ?? '').trim() || undefined;
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' =
        String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';

      if (!/^https:\/\/\S+$/.test(sourceUrl)) {
        return {
          ok: false,
          reason:
            'sourceUrl must be an https git URL (e.g. https://github.com/anthropics/skills)',
        };
      }
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why this skill helps builds here — is required',
        };
      if (!this.skillStore || !this.skillInstaller) {
        return { ok: false, reason: 'skills are not configured for this org' };
      }
      try {
        const dbScope = scope === 'org' ? '*' : stimulus.repoId;
        let rows;
        try {
          rows = await this.skillInstaller.preview({
            orgId: stimulus.orgId,
            scope: dbScope,
            sourceUrl,
            ref,
            subpath,
          });
        } catch (err) {
          return {
            ok: false,
            reason: `could not resolve that skill source: ${errText(err)}`,
          };
        }
        const resolved = rows[0];
        if (!resolved)
          return {
            ok: false,
            reason: 'that source resolved no installable skill',
          };
        const requestId = `skill-${randomUUID()}`;
        const card = webSkillProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          name: resolved.name,
          description: resolved.description,
          surfaces: ['brain', 'build', 'review'],
          mode: 'install',
          rationale,
          sourceUrl,
          sourceRef: ref,
          sourceSubpath: subpath,
          installPreview: { rows },
        });
        const opened = await this.store.openSkillProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason:
              'Could not open the skill install proposal (thread not found).',
          };
        return {
          ok: true,
          requestId,
          mode: 'install',
          message:
            `Posted an install proposal for the "${resolved.name}" skill (${scope}-scoped)${resolved.overwrites ? ' — NOTE it would overwrite an existing skill of that name' : ''}. ` +
            'Only the OWNER can approve it. On approval it installs from git (kept up to date) and loads on the ' +
            'next fresh session (reset_sandbox to pick it up). Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(
          `propose_skill_install failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `request_skill_edit_access({ skill, rationale })` — request live `Edit`/`Write` access to an ALREADY
   * REGISTERED skill for the rest of THIS session. Skills are read-only by default (`makeCanUseTool`'s
   * skill guard, `engine-core.ts`) — a small fix or an iterative multi-file edit shouldn't need a whole new
   * `propose_skill` body-replace proposal. Mirrors `request_secret`'s shape: posts an owner-approvable card
   * and tells the model to stop and wait — the owner approves at
   * `…/jobs/:jobId/skill-edit-access/:requestId/approve`, which (for a `git`-provenance skill) forks it to a
   * custom copy FIRST, then records the grant this manager forwards on every subsequent brain turn
   * (`grantSkillEditAccess` → `RunEngineArgs.grantedSkills`). PER-CARD (like `request_file`) — several may
   * be open at once. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  buildRequestSkillEditAccessTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const name = String(args['skill'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      if (!name)
        return {
          ok: false,
          reason:
            'skill (the name to unlock) is required — call list_skills first',
        };
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why you need to edit this skill — is required',
        };
      if (!this.skillStore)
        return { ok: false, reason: 'skills are not configured for this org' };
      try {
        // Repo scope overrides an org skill of the same name (SkillResolver's own precedence) — resolve
        // whichever one is actually ACTIVE for this repo/job.
        const repoRow = await this.skillStore.get(
          stimulus.orgId,
          stimulus.repoId,
          name,
        );
        const orgRow = repoRow
          ? null
          : await this.skillStore.get(
              stimulus.orgId,
              WorkspaceSkillStore.toDbScope('org'),
              name,
            );
        const row = repoRow ?? orgRow;
        if (!row) {
          return {
            ok: false,
            reason: `no skill named "${name}" is registered — call list_skills to see what's available`,
          };
        }
        const scope: 'org' | 'repo' = repoRow ? 'repo' : 'org';
        const requestId = `skill-edit-${randomUUID()}`;
        const card = webSkillEditAccessCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          name,
          provenance: row.provenance,
          sourceUrl: row.source_url,
          sourceRef: row.source_ref,
          rationale,
        });
        const opened = await this.store.openSkillEditAccessRequest(
          stimulus.jobId,
          { requestId, card },
        );
        if (!opened.ok) {
          return {
            ok: false,
            reason:
              'Could not open the edit-access request (thread not found).',
          };
        }
        return {
          ok: true,
          requestId,
          message:
            `Posted an edit-access request for the "${name}" skill. Stop and wait — only the OWNER can grant ` +
            'it. If it is installed from git, approval forks it to a custom copy first (the git original ' +
            'stays clean and updatable) and the grant applies to the fork under a possibly DIFFERENT name — ' +
            'the confirmation names the exact skill/dir to edit.',
        };
      } catch (err) {
        this.logger.warn(
          `request_skill_edit_access failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_skill_removal({ name, scope?, rationale })` — propose DELETING a registered skill. Like
   * `propose_skill`, the brain never deletes directly (a skill affects every future build): this posts an
   * owner-approvable card showing what would be removed, and only the OWNER's approval at the skill-proposal
   * approve endpoint deletes it via `WorkspaceSkillStore`. `scope` is `'repo'` (default) or `'org'` — it must
   * match the tier the skill lives on. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  buildProposeSkillRemovalTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' =
        String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';
      if (!name)
        return { ok: false, reason: 'name (the skill to remove) is required' };
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why the skill should be removed — is required',
        };
      if (!this.skillStore)
        return { ok: false, reason: 'skills are not configured for this org' };
      try {
        const dbScope = scope === 'org' ? '*' : stimulus.repoId;
        const existing = await this.skillStore.get(
          stimulus.orgId,
          dbScope,
          name,
        );
        if (!existing) {
          return {
            ok: false,
            reason: `no ${scope}-scoped skill "${name}" exists — call list_skills to see the registered skills`,
          };
        }
        const requestId = `skill-${randomUUID()}`;
        const card = webSkillProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          name,
          description: '',
          surfaces: existing.surfaces,
          mode: 'remove',
          priorBody: this.skillFiles?.readSkillBody(
            stimulus.orgId,
            dbScope,
            name,
          ),
          rationale,
        });
        const opened = await this.store.openSkillProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason:
              'Could not open the skill removal proposal (thread not found).',
          };
        return {
          ok: true,
          requestId,
          message:
            `Posted a removal proposal for the "${name}" skill (${scope}-scoped). Only the OWNER can approve ` +
            'the deletion — you cannot remove it yourself. Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(
          `propose_skill_removal failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_mcp_removal({ name, scope?, rationale })` — propose DELETING a registered MCP server. Owner-gated
   * like `propose_mcp_servers`: posts a removal card; only the OWNER's approval at the mcp-proposal approve
   * endpoint deletes it via `McpServerStore`. `scope` is `'repo'` (default) or `'org'` — the tier the server
   * lives on. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  buildProposeMcpRemovalTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' =
        String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';
      if (!name)
        return {
          ok: false,
          reason: 'name (the MCP server to remove) is required',
        };
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why the server should be removed — is required',
        };
      if (!this.mcpStore)
        return {
          ok: false,
          reason: 'MCP servers are not configured for this org',
        };
      try {
        const dbScope = scope === 'org' ? '*' : stimulus.repoId;
        const existing = await this.mcpStore.rawRow(
          stimulus.orgId,
          dbScope,
          name,
        );
        if (!existing) {
          return {
            ok: false,
            reason: `no ${scope}-scoped MCP server "${name}" exists — call list_mcp_servers to see the registered servers`,
          };
        }
        const requestId = `mcp-${randomUUID()}`;
        const card = webMcpProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          mode: 'remove',
          removeNames: [name],
          servers: [],
        });
        const opened = await this.store.openMcpProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason:
              'Could not open the MCP removal proposal (thread not found).',
          };
        return {
          ok: true,
          requestId,
          message:
            `Posted a removal proposal for the "${name}" MCP server (${scope}-scoped). Only the OWNER can ` +
            'approve the deletion — you cannot remove it yourself. Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(
          `propose_mcp_removal failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `finish_onboarding({ summary })` — conclude the onboarding session. Posts the operator-visible summary.
   * Secrets and workspace config (mounts/seed) are ALREADY live the instant they were written (encrypted
   * grants / DB rows — see docs/adr/0003), so `onboarded_at` is stamped immediately regardless. If the
   * ceremony also made an actual repo edit (a script fix, a `.gitignore` change, a dependency bump — real
   * code changes are a normal part of onboarding, not just config), that diff still needs to reach the
   * repo, so it's shipped as its own PR for the operator to merge.
   */
  buildFinishOnboardingTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const summary = String(args['summary'] ?? '').trim();
      // Green-gate: onboarding may only conclude once Atlas has actually brought the stack up and checked
      // it. `verified` is that evidence (which services booted, how they were health-checked, any dry-run).
      // It is required + non-trivial so the ceremony can't rubber-stamp a stack it never ran; the operator
      // approving/merging the PR is the final human gate. (See docs/adr/0002 §6.)
      const verified = String(args['verified'] ?? '').trim();
      if (verified.length < 20) {
        return {
          ok: false,
          reason:
            'finish_onboarding requires `verified`: describe what you actually booted and how you checked it ' +
            '(the services you brought up via atlas-svc, the health checks/log lines, any dry-run). For a repo ' +
            'with USER-FACING surfaces, `verified` must ALSO include live preview-accessibility proof — each ' +
            'public preview URL loaded + hydrated as a browser via atlas-probe, AND (where the surface has ' +
            'auth) the authed-handshake proof via a real dev-login + `atlas-probe --storage-state`; a local ' +
            'health check is not enough. If the stack would not boot or a surface is not browser-accessible, ' +
            'do NOT finish — say what is still blocking instead.',
        };
      }
      const sandbox = await this.lifecycle.findSandbox(
        stimulus.jobId,
        stimulus.orgId,
      );
      if (!sandbox)
        return { ok: false, reason: 'no sandbox for this thread yet' };

      // Persist the boot evidence as a durable, operator-visible record before concluding.
      await this.store.appendSystemEvent(
        stimulus.jobId,
        `✅ Boot verified — ${verified}`,
      );
      if (summary)
        await this.store.appendSystemEvent(
          stimulus.jobId,
          `🎉 Onboarding complete — ${summary}`,
        );

      // Everything past this point (marking onboarded, checking for a diff, shipping) can hit a transient
      // DB/git/GitHub failure — never let that throw and crash the turn. Warn, and give Atlas the real
      // error via `reason` so it can retry (e.g. re-call finish_onboarding) instead of the ceremony
      // silently wedging with no feedback.
      try {
        // Secrets + workspace config are already durably live (encrypted grants / DB rows) the instant
        // they were written — onboarding is marked done regardless of whether there's a code diff to ship.
        await this.lifecycle.markRepoOnboarded(stimulus.orgId, stimulus.repoId);
        // Seed the new-stack baseline: the bulk pass has seen the whole stack, so acknowledge every
        // dependency manifest now — future jobs only flag manifests that appear AFTER this.
        await this.refreshSeenManifests(
          stimulus.orgId,
          stimulus.repoId,
          sandbox.worktreePath,
        );

        const hasChanges = await this.git.hasChanges(sandbox.worktreePath);
        if (!hasChanges) {
          return {
            ok: true,
            prOpened: false,
            message: 'Onboarding complete. Repo marked ready.',
          };
        }

        // A real repo edit was made along the way (script fix, .gitignore change, etc.) — ship it as its
        // own PR (reuses the shared ship path: commit → autofix → push → open ONE PR → record
        // pr_url/pr_number on the thread → flips it done).
        const job = await this.store.loadJob(stimulus.jobId);
        const repo = await this.repos.resolve(job);
        // HOST PRE-SHIP GATE only (no-token + leak-scan — the host NEVER commits). `finish_onboarding` runs
        // INSIDE this brain turn, so (like `finalize_build`) it cannot seed a nested open-PR turn — it
        // leak-scans host-side, then hands `shipOpenPrBody` back so the brain commits its env-setup changes and
        // opens the PR itself in THIS turn. The git-state reconciler records the PR later.
        const pre = await this.ship.preShip(job, repo, sandbox, (m) =>
          this.store.appendSystemEvent(stimulus.jobId, m),
        );
        if (!pre.ok) {
          if (pre.reason === 'leak-scan') {
            // Hard security block — a hydrated secret/seed path was committed on the onboarding branch.
            return {
              ok: false,
              reason:
                `PR blocked by the pre-ship security scan — a managed secret/seed file was committed: ` +
                `${pre.leaked.join(', ')}. Remove it from the branch history and retry.`,
            };
          }
          return {
            ok: true,
            prOpened: false,
            message:
              'Made repo changes but no GitHub token is set — connect one to open the PR.',
          };
        }
        return {
          ok: true,
          prOpened: false,
          message: shipOpenPrBody({
            branch: sandbox.branch,
            defaultBranch: repo.defaultBranch,
            title: 'Environment setup',
          }),
        };
      } catch (err) {
        this.logger.warn(
          `finish_onboarding failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * Resolve which ANSWERED `ask_question` card a decision should attach, with multiple questions possibly
   * open: an explicit `questionId` (the brain named one) wins, else the card THIS turn delivered
   * (`stimulus.deliveredQuestionIds`), else the most-recently-answered not-yet-logged card. Returns the card +
   * its id, or null when none is answered. There is no single-slot pointer to read.
   */
  async resolveAnsweredCard(
    stimulus: TurnEnvelope,
    explicitQuestionId?: string,
  ): Promise<{ id: string; card: WebQuestionCard } | null> {
    const byId = async (id?: string) => {
      if (!id) return null;
      const card = await this.store.getQuestionCard(stimulus.jobId, id);
      return card?.answer != null ? { id, card } : null;
    };
    const explicit = await byId(explicitQuestionId);
    if (explicit) return explicit;
    // A card-answer delivery carries exactly one delivered question id (the batch send never resolves a
    // decision through this path), so the head of the array is the card THIS turn delivered.
    const seeded = await byId(stimulus.deliveredQuestionIds?.[0]);
    if (seeded) return seeded;
    const row = await this.store.latestAnsweredQuestionCard(stimulus.jobId);
    const card = row?.card as WebQuestionCard | undefined;
    return row?.ts && card?.answer != null ? { id: row.ts, card } : null;
  }

  /**
   * (Re)generate the thread's `decision-record.md` from its working-set decisions and write it to the
   * READ-ONLY `/context/generated/` bucket (host-side path; the container sees `/context/generated` as a
   * read-only mount). Called on every decision mutation, so the file stays incremental + in lockstep with
   * the structured `pending_decisions` — coding agents read it for grounding but never author it.
   */
  async writeDecisionRecordMd(
    jobId: string,
    orgId: string,
    decisions: Decision[],
  ): Promise<void> {
    const generatedDir = join(
      this.lifecycle.contextDirHost(jobId, orgId),
      'generated',
    );
    await mkdir(generatedDir, { recursive: true });
    await writeFile(
      join(generatedDir, 'decision-record.md'),
      renderDecisionRecordMd(decisions),
      'utf8',
    );
  }
}
