import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { McpServerStore } from '../mcp';
import { MemoryStore } from '../memory';
import { webFileRequestCard, webSecretInputCard } from '../surface';
import type { ToolImpl } from '@shared/engine/engine.types';
import { BrainStoreService } from './brain-store.service';

/** The tenant + authoring context a build/brain thread supplies when asking for this toolset. */
type SelfSufficiencyContext = {
  jobId: string;
  orgId: string;
  repoId: string;
  authorId?: string;
  defaultQuery?: string;
};

/**
 * The self-sufficiency toolset (`request_secret`, `request_file`, `recall`, `remember`) — shared between the
 * brain (`AgentSessionManager`) and headless build/master_review threads (`ThreadDriverService`), so BOTH
 * dispatch through the SAME handler bodies instead of two copies drifting apart. Org/repo/job come from the
 * caller-supplied `ctx` (never tool args) — tenant safety.
 */
@Injectable()
export class SelfSufficiencyToolsService {
  private readonly logger = new Logger(SelfSufficiencyToolsService.name);

  constructor(
    private readonly store: BrainStoreService,
    private readonly memory: MemoryStore,
    @Optional() private readonly mcpStore?: McpServerStore,
  ) {}

  buildTools(ctx: SelfSufficiencyContext): {
    request_secret: ToolImpl;
    request_file: ToolImpl;
    recall: ToolImpl;
    remember: ToolImpl;
    forget: ToolImpl;
    update_memory: ToolImpl;
  } {
    return {
      request_secret: this.buildRequestSecretTool(ctx),
      request_file: this.buildRequestFileTool(ctx),
      recall: async (args) => {
        const query = String(args['query'] ?? ctx.defaultQuery ?? '');
        try {
          const facts = await this.memory.recall(query, {
            scopes: [`project:${ctx.repoId}`, `team:${ctx.orgId}`],
            orgId: ctx.orgId,
            limit: 8,
          });
          return facts.map((f) => ({ id: f.id, fact: f.fact, scope: f.scope }));
        } catch (err) {
          this.logger.debug(`recall failed: ${err}`);
          return [];
        }
      },
      remember: async (args) => {
        const fact = String(args['fact'] ?? '').trim();
        if (!fact) return { stored: false, reason: 'empty fact' };
        const scope = String(args['scope'] ?? `project:${ctx.repoId}`);
        try {
          await this.memory.remember({
            fact,
            scope,
            orgId: ctx.orgId,
            assertedBy: ctx.authorId,
          });
          return { stored: true };
        } catch (err) {
          return { stored: false, reason: String(err) };
        }
      },
      forget: async (args) => {
        const id = String(args['id'] ?? '').trim();
        if (!id) return { forgotten: false, reason: 'id is required' };
        try {
          const { deleted } = await this.memory.forget(id, ctx.orgId);
          return deleted
            ? { forgotten: true }
            : { forgotten: false, reason: 'no such memory' };
        } catch (err) {
          return { forgotten: false, reason: String(err) };
        }
      },
      update_memory: async (args) => {
        const id = String(args['id'] ?? '').trim();
        const fact = String(args['fact'] ?? '').trim();
        if (!id) return { updated: false, reason: 'id is required' };
        if (!fact) return { updated: false, reason: 'fact is required' };
        try {
          const { updated } = await this.memory.updateFact(id, fact, ctx.orgId);
          return updated
            ? { updated: true }
            : { updated: false, reason: 'no such memory' };
        } catch (err) {
          return { updated: false, reason: String(err) };
        }
      },
    };
  }

  /**
   * `request_secret({ name, path, description })` — securely request an env-file SECRET VALUE from the
   * operator. Mirrors `ask_question`: posts a value-FREE card + opens the durable `awaiting_secret_id`
   * gate, then the brain stops and waits. The value never passes through this tool — it arrives only at the
   * owner-gated `provide-secret` endpoint, which writes it to the encrypted store + grants it; the brain
   * later sees a masked confirmation. org/repo come from the closure (never tool args) — tenant safety.
   */
  private buildRequestSecretTool(ctx: SelfSufficiencyContext): ToolImpl {
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const path = String(args['path'] ?? '').trim();
      const description = String(args['description'] ?? '').trim();
      // Optional headless-login URL (e.g. `gcloud auth login --no-launch-browser`): surfaced as a clickable
      // link on the card so the operator opens it, then pastes the resulting code back. https only.
      const rawUrl = String(args['url'] ?? '').trim();
      const url = /^https:\/\//.test(rawUrl) ? rawUrl : undefined;
      const ephemeral = args['ephemeral'] === true;
      const deliverTo = String(args['deliver_to'] ?? '').trim();

      if (!description)
        return {
          ok: false,
          reason: 'description is required (why the secret is needed)',
        };

      // EPHEMERAL: a one-time, short-lived value (an OAuth verification code, a 2FA code) piped straight to a
      // process the brain has running and NEVER stored. `deliver_to` (an absolute in-container path — the FIFO
      // the brain already wired its waiting process to read) replaces `path`; `name` is just a display label.
      if (ephemeral) {
        if (!deliverTo.startsWith('/') || deliverTo.split('/').includes('..')) {
          return {
            ok: false,
            reason:
              'deliver_to must be an absolute in-container path (e.g. /tmp/atlas-login-in), no ..',
          };
        }
        const label = name || 'ONE_TIME_CODE';
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) {
          return {
            ok: false,
            reason:
              'name (label) must be an identifier (e.g. GCLOUD_AUTH_CODE)',
          };
        }
        const requestId = `s-${randomUUID()}`;
        const card = webSecretInputCard({
          jobId: ctx.jobId,
          requestId,
          name: label,
          description,
          ephemeral: true,
          deliver_to: deliverTo,
          ...(url ? { url } : {}),
        });
        const opened = await this.store.openSecretRequest(ctx.jobId, {
          requestId,
          card,
        });
        if (!opened.ok) {
          return {
            ok: false,
            reason: opened.alreadyOpen
              ? 'A secret request is already awaiting the operator — wait for it before requesting another.'
              : 'Could not open the secret request (thread not found).',
          };
        }
        return {
          ok: true,
          requestId,
          message:
            `Ephemeral secure card posted for "${label}". Make SURE your process is already reading ${deliverTo} ` +
            `(open the FIFO read-write: \`exec 0<>${deliverTo}\`) before the operator submits. Stop and wait — ` +
            'the value is piped straight into that path and never stored; you only get a masked confirmation.',
        };
      }

      // MCP-TARGET: the value is a credential slot (header/env) for a user-defined MCP server the OWNER just
      // approved (via propose_mcp_servers). It writes into `mcp_servers.secrets_enc` (McpServerStore.setSecret)
      // — NOT the worktree store — and does not grant/rehydrate; the scope is re-derived from this thread's
      // repo at commit (never trusted from the card). No worktree `path`.
      const mcpArg = args['mcp'];
      if (mcpArg && typeof mcpArg === 'object' && !Array.isArray(mcpArg)) {
        const m = mcpArg as Record<string, unknown>;
        const server = String(m['server'] ?? '').trim();
        const slot = String(m['slot'] ?? '').trim();
        const key = String(m['key'] ?? '').trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(server)) {
          return {
            ok: false,
            reason: 'mcp.server must be the name of a registered MCP server',
          };
        }
        if (slot !== 'header' && slot !== 'env') {
          return { ok: false, reason: "mcp.slot must be 'header' or 'env'" };
        }
        if (!key)
          return {
            ok: false,
            reason: 'mcp.key is required (the header/env key name)',
          };
        // An OAuth server has NO fillable secret slot — its Authorization is minted by the owner Connect flow
        // (McpOAuthService), so a request_secret against it would inject a bearer that bypasses the token
        // lifecycle. Reject early (the host provideSecret lane enforces this authoritatively too). MCP secrets
        // land on THIS repo's scope, so check the repo-scoped row.
        const oauthRow = await this.mcpStore
          ?.rawRow(ctx.orgId, ctx.repoId, server)
          .catch(() => null);
        if (oauthRow?.auth_kind === 'oauth') {
          return {
            ok: false,
            reason: `MCP server "${server}" uses OAuth — it is connected by the OWNER via the Connect button on the MCP proposal card or in the console (MCP settings → Connect), not via a secret slot. Do not request a secret or inject an Authorization/Bearer header for it.`,
          };
        }
        const requestId = `s-${randomUUID()}`;
        const card = webSecretInputCard({
          jobId: ctx.jobId,
          requestId,
          name: key,
          description,
          mcp: { server, slot, key },
          ...(url ? { url } : {}),
        });
        const opened = await this.store.openSecretRequest(ctx.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason: 'Could not open the secret request (thread not found).',
          };
        return {
          ok: true,
          requestId,
          message:
            `Secure secret card posted for MCP server "${server}" (${slot}:${key}). The operator's value goes ` +
            'straight into the encrypted MCP store and activates the server; you only see a masked ' +
            'confirmation. Never ask for the value in chat. You may open several secret requests at once.',
        };
      }

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return {
          ok: false,
          reason:
            'name must be an env-var-style identifier (e.g. DATABASE_URL)',
        };
      }
      if (!path || path.startsWith('/') || path.split('/').includes('..')) {
        return {
          ok: false,
          reason:
            'path must be a worktree-relative file path (e.g. .env), no leading / or ..',
        };
      }
      const requestId = `s-${randomUUID()}`;
      const card = webSecretInputCard({
        jobId: ctx.jobId,
        requestId,
        name,
        path,
        description,
        ...(url ? { url } : {}),
      });
      const opened = await this.store.openSecretRequest(ctx.jobId, {
        requestId,
        card,
      });
      if (!opened.ok)
        return {
          ok: false,
          reason: 'Could not open the secret request (thread not found).',
        };
      return {
        ok: true,
        requestId,
        message:
          `Secure secret card posted for "${name}". The operator's value goes straight to encrypted storage; ` +
          'you will only see a masked confirmation. Never ask for the value in chat. You may open several ' +
          'secret requests at once (and withdraw_secret_request any you no longer need).',
      };
    };
  }

  /**
   * `request_file({ path, description })` — ask the operator to UPLOAD a file whose contents can't be
   * typed (a service-account JSON, a keystore/`.pem`, a gitignored `.env.keys`). Posts a value-FREE card;
   * the file arrives only at the owner-gated `provide-file` endpoint, which stores the contents ENCRYPTED
   * (as a file-valued secret) + grants them to `path` for future build threads. PER-CARD (multiple may be
   * open at once — no one-at-a-time gate). The brain only ever sees a masked confirmation. org/repo come
   * from the closure (never tool args) — tenant safety. The destination MUST be gitignored, or the
   * hydrator refuses to render it (it would leak into the PR).
   */
  private buildRequestFileTool(ctx: SelfSufficiencyContext): ToolImpl {
    return async (args) => {
      const path = String(args['path'] ?? '').trim();
      const description = String(args['description'] ?? '').trim();
      if (!path || path.startsWith('/') || path.split('/').includes('..')) {
        return {
          ok: false,
          reason:
            'path must be a worktree-relative file path (e.g. .env.keys), no leading / or ..',
        };
      }
      if (!description)
        return {
          ok: false,
          reason: 'description is required (why the file is needed)',
        };
      const requestId = await this.store.nextFileRequestId(ctx.jobId);
      const card = webFileRequestCard({
        jobId: ctx.jobId,
        requestId,
        path,
        description,
      });
      const opened = await this.store.openFileRequest(ctx.jobId, {
        requestId,
        card,
      });
      if (!opened.ok)
        return {
          ok: false,
          reason: 'Could not open the file request (thread not found).',
        };
      return {
        ok: true,
        requestId,
        message:
          `File-upload card posted for "${path}". The operator uploads the file through a secure field; ` +
          'its contents go straight to encrypted storage and you will only see a masked confirmation. ' +
          'Never ask them to paste file contents in chat. Ensure the destination is gitignored.',
      };
    };
  }
}
