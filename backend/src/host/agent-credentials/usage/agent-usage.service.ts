import { Injectable, Logger } from '@nestjs/common';
import {
  type AccountUsage,
  type AccountUsageSnapshot,
  type ClaudeUsageWindowKey,
  EAgentCredentialKind,
  EAgentProvider,
  type ModelUsageWindow,
  type StoredUsageWindow,
} from '@workspace/shared';
import axios from 'axios';
import {
  AgentCredential,
  AgentCredentialRepo,
} from '../../../_lib/database/entities/agent-credential.entity';
import { AgentCredentialRefreshService } from '../agent-credential-refresh.service';
import { AgentCredentialService } from '../agent-credential.service';
import { type ClaudeCredentialBlob } from '../oauth/claude-oauth.client';
import {
  type ParsedUsage,
  parseUsageResponse,
  RATE_LIMIT_TYPE_TO_WINDOW,
  resetEpochToIso,
  toPercentUtilization,
} from './usage-parse.util';

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
// User-Agent the usage API expects (spoofs the Claude Code CLI). Bump alongside the SDK if it starts 4xx-ing.
const CLAUDE_CODE_VERSION = '2.1.204';
const POLL_FLOOR_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export type HarvestInfo = {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
};

/**
 * Per-account subscription usage. Two sources both write the SAME per-account snapshot
 * (`agent_credentials.usage_snapshot`): {@link applyHarvest} (fed by the engine from `rate_limit_event`
 * frames — the receiving end of the harvest seam) and {@link pollClaudeUsage} (a direct `/api/oauth/usage`
 * poll, Claude only). Snapshot writes are WAL deltas, so the web sees usage update live over realtime —
 * no bespoke event bus. Codex has no usage poll (no public ChatGPT-plan usage API); its windows populate
 * only via harvest once the engine surfaces Codex rate limits.
 */
@Injectable()
export class AgentUsageService {
  private readonly logger = new Logger(AgentUsageService.name);
  private readonly pollFloor = new Map<string, number>();

  constructor(
    private readonly repo: AgentCredentialRepo,
    private readonly store: AgentCredentialService,
    private readonly refresh: AgentCredentialRefreshService,
  ) {}

  /** Receiving end of the live-harvest seam — merge a rate-limit frame into the account's snapshot. */
  async applyHarvest(orgId: string, credentialId: string, info: HarvestInfo): Promise<void> {
    const resetsAt = resetEpochToIso(info.resetsAt);
    if (!resetsAt) return;
    const rejected = info.status === 'rejected';
    const utilization = rejected ? 100 : toPercentUtilization(info.utilization);
    if (utilization == null) return;
    const rateLimitType = info.rateLimitType ?? (rejected ? 'five_hour' : undefined);
    const key = rateLimitType ? RATE_LIMIT_TYPE_TO_WINDOW[rateLimitType] : undefined;
    if (!key) return;
    await this.mergeWindows(
      orgId,
      credentialId,
      { [key]: { utilization, resetsAt } },
      [],
      'harvested',
    );
  }

  /** Poll Claude's usage API for an account and store the result. Returns the projected usage view. */
  async pollClaudeUsage(orgId: string, credentialId: string): Promise<AccountUsage | null> {
    const row = await this.store.getById(orgId, credentialId);
    if (!row || row.provider !== EAgentProvider.CLAUDE) return null;

    const floor = this.pollFloor.get(credentialId);
    if (floor && Date.now() - floor < POLL_FLOOR_MS) return this.store.toView(row).usage;

    let material: string;
    try {
      material = await this.refresh.ensureFresh(orgId, credentialId);
    } catch (err) {
      this.logger.warn(`usage refresh failed for ${credentialId}: ${String(err)}`);
      return null;
    }
    const token = AgentUsageService.bearerFromMaterial(material, row.kind);
    if (!token) return null;

    const parsed = await this.fetchUsage(token);
    if (!parsed) return null;
    this.pollFloor.set(credentialId, Date.now());
    await this.mergeWindows(orgId, credentialId, parsed.windows, parsed.modelWindows, 'usage_api');

    const updated = await this.store.getById(orgId, credentialId);
    return updated ? this.store.toView(updated).usage : null;
  }

  private async fetchUsage(accessToken: string): Promise<ParsedUsage | null> {
    try {
      const res = await axios.get(USAGE_API_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
          'User-Agent': `claude-code/${CLAUDE_CODE_VERSION}`,
          'content-type': 'application/json',
        },
        timeout: FETCH_TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (res.status < 200 || res.status >= 300) {
        this.logger.warn(`usage fetch failed: HTTP ${res.status}`);
        return null;
      }
      return parseUsageResponse(res.data);
    } catch (err) {
      this.logger.warn(`usage fetch error: ${String(err)}`);
      return null;
    }
  }

  /**
   * Overlay new windows onto the account's stored snapshot (newest write wins per window, since both
   * sources stamp `fetchedAt=now`). Skips the write when nothing changed, so realtime isn't spammed.
   */
  private async mergeWindows(
    orgId: string,
    credentialId: string,
    windows: Partial<Record<ClaudeUsageWindowKey, StoredUsageWindow>>,
    modelWindows: ModelUsageWindow[],
    source: AccountUsageSnapshot['source'],
  ): Promise<void> {
    await this.repo.manager.transaction(async (m) => {
      const row = await m.findOne(AgentCredential, {
        where: { id: credentialId, orgId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) return;
      const prev = row.usageSnapshot;
      const mergedWindows = { ...(prev?.windows ?? {}), ...windows };
      // Poll carries modelWindows; harvest passes []. Keep the previous ones when the source has none.
      const mergedModels = modelWindows.length > 0 ? modelWindows : (prev?.modelWindows ?? []);
      const unchanged =
        prev &&
        JSON.stringify(prev.windows) === JSON.stringify(mergedWindows) &&
        JSON.stringify(prev.modelWindows ?? []) === JSON.stringify(mergedModels);
      if (unchanged) return;
      row.usageSnapshot = {
        windows: mergedWindows,
        modelWindows: mergedModels,
        fetchedAt: Date.now(),
        source,
      };
      await m.save(row);
    });
  }

  private static bearerFromMaterial(material: string, kind: EAgentCredentialKind): string | null {
    if (kind === EAgentCredentialKind.SETUP_TOKEN) return material.trim() || null;
    try {
      const token = (JSON.parse(material) as ClaudeCredentialBlob).claudeAiOauth?.accessToken;
      return typeof token === 'string' && token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }
}
