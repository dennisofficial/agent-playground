import { EnvService } from '@core/config/env/env.service';
import {
  type TaskSuggestionEvent,
  type TaskSuggestionPresenter,
} from '@harness/approvals/task-suggestion-presenter.port';
import { ConductorService } from '@harness/conductor/conductor.service';
import { EmployeeRegistry } from '@harness/employees/employee.registry';
import { BoardStore } from '@harness/memory/board-store';
import { Injectable, Logger } from '@nestjs/common';
import { parseSlackSurface } from '../slack-membership';
import type {
  SlackInbound,
  SlackInboundInterceptor,
  SlackInteractivityPayload,
} from '../slack-inbound.types';
import { TenantSlackClients } from '../tenant-slack-clients';
import { TenantStore } from '../tenant.store';
import {
  SUGGESTION_BACKLOG_ACTION_ID,
  SUGGESTION_DISMISS_ACTION_ID,
  SUGGESTION_PREFIX,
  SUGGESTION_RUN_ACTION_ID,
  type SuggestionActionMeta,
  suggestionCardBlocks,
  suggestionVerdictBlocks,
} from './suggestion-blocks';

/**
 * The Slack adapter for the task-suggestion port, both directions — the `ApprovalCardsService` twin:
 *
 * OUTBOUND (`TaskSuggestionPresenter`): `suggest_task` calls `present()` — post the chip (Atlas's
 * "here's something worth doing" + Run / Keep / Dismiss) as the suggesting orchestrator through the
 * main app (Slack routes block_actions to the posting app). The chip renders a parked board row.
 *
 * INBOUND (`SlackInboundInterceptor`, after the approval interceptor — `suggestion:*` ids are
 * namespaced, so the two never overlap): a chip click is just another ingestion. The clicker must be
 * the BOSS (tenant.installed_by, or APPROVAL_BOSS_USER_ID for dev workspaces; fail-closed). The
 * disposition is applied with an ATOMIC board write FIRST, then the card is repainted, then (Run /
 * Dismiss only) Atlas is silently woken via `conductor.injectSeed` — so a stale/double click or a
 * Run racing a Dismiss can never wake him twice or after the row is gone (the approval-card lesson:
 * CAS, then seed).
 *   • Run now  → BoardStore.claim (open→planning, assignee=atlas): wake Atlas to dispatch it.
 *   • Keep     → no board write (already parked open): repaint only, no wake.
 *   • Dismiss  → BoardStore.dropOpen (guarded delete): wake Atlas low-key so he doesn't re-suggest.
 */
@Injectable()
export class SuggestionCardsService
  implements TaskSuggestionPresenter, SlackInboundInterceptor
{
  private readonly logger = new Logger(SuggestionCardsService.name);

  /** `${AVATAR_BASE_URL}/${AVATAR_STYLE}` — the chat surface's username-override icon idiom. */
  private readonly avatarBase?: string;

  constructor(
    private readonly clients: TenantSlackClients,
    private readonly tenants: TenantStore,
    private readonly board: BoardStore,
    private readonly conductor: ConductorService,
    private readonly employees: EmployeeRegistry,
    private readonly env: EnvService,
  ) {
    const base = this.env.get('AVATAR_BASE_URL');
    if (base) {
      const style = this.env.get('AVATAR_STYLE') ?? 'illustrated';
      this.avatarBase = `${base.replace(/\/+$/, '')}/${style}`;
    }
  }

  // ── Outbound: post the chip ─────────────────────────────────────────────────────────────────

  async present(e: TaskSuggestionEvent): Promise<void> {
    const parsed = parseSlackSurface(e.surfaceId);
    if (!parsed)
      throw new Error(
        `suggestion for #${e.taskId} was made from a non-Slack room (${e.surfaceId}) — no chip here`,
      );
    const web = await this.clients.clientFor(parsed.teamId);
    if (!web) throw new Error(`no Slack client for workspace ${parsed.teamId}`);
    // Posts AS the suggesting orchestrator (username/icon override), but through the MAIN app: Slack
    // routes block_actions to the app that posted the message, so the chip must be app-posted for
    // its buttons to work.
    const proposer = this.employees.byId(e.proposedBy);
    const card = await web.chat.postMessage({
      channel: parsed.channel,
      text: `Suggestion — #${e.taskId}: ${e.title} (run / keep / dismiss)`,
      blocks: suggestionCardBlocks(e) as never,
      username: proposer?.name ?? e.proposedBy,
      ...(this.avatarBase
        ? { icon_url: `${this.avatarBase}/${e.proposedBy}.png` }
        : {}),
    });
    if (!card.ts) throw new Error('chip post returned no ts');
  }

  // ── Inbound: dispositions ───────────────────────────────────────────────────────────────────

  /** Router contract: true = consumed. Everything non-`suggestion:*` falls through. */
  async maybeHandle(item: SlackInbound): Promise<boolean> {
    if (item.kind !== 'interactivity') return false;
    const payload = item.payload;
    if (payload.type !== 'block_actions') return false;
    const action = payload.actions?.find((a) =>
      a.action_id?.startsWith(SUGGESTION_PREFIX),
    );
    if (!action) return false;
    await item.respond();
    await this.handleAction(payload, action).catch((err) =>
      this.logger.error(`suggestion action failed: ${err}`),
    );
    return true;
  }

  private async handleAction(
    payload: SlackInteractivityPayload,
    action: { action_id?: string; value?: string },
  ): Promise<void> {
    const teamId = payload.team?.id;
    const channel = payload.channel?.id;
    const userId = payload.user?.id;
    const message = payload.message as
      | { ts?: string; blocks?: Array<Record<string, unknown>> }
      | undefined;
    if (!teamId || !channel || !userId || !message?.ts) return;
    const meta = this.parseMeta(action.value);
    if (!meta) return;

    const web = await this.clients.clientFor(teamId);
    if (!web) return;

    if (!(await this.isBoss(teamId, userId))) {
      await web.chat.postEphemeral({
        channel,
        user: userId,
        text: `Only the workspace owner triages suggestions — this one's for Dennis.`,
      });
      return;
    }

    const disposition =
      action.action_id === SUGGESTION_RUN_ACTION_ID
        ? 'run'
        : action.action_id === SUGGESTION_BACKLOG_ACTION_ID
          ? 'backlog'
          : action.action_id === SUGGESTION_DISMISS_ACTION_ID
            ? 'dismiss'
            : undefined;
    if (!disposition) return; // a suggestion:* id this build doesn't know — consumed, no-op
    await this.applyDisposition({
      teamId,
      channel,
      userId,
      cardTs: message.ts,
      cardBlocks: message.blocks ?? [],
      taskId: meta.taskId,
      disposition,
    });
  }

  /** The one disposition path: atomic board write FIRST, then repaint, then (Run/Dismiss) wake Atlas. */
  private async applyDisposition(d: {
    teamId: string;
    channel: string;
    userId: string;
    cardTs: string;
    cardBlocks: Array<Record<string, unknown>>;
    taskId: number;
    disposition: 'run' | 'backlog' | 'dismiss';
  }): Promise<void> {
    const web = await this.clients.clientFor(d.teamId);
    if (!web) return;

    const ephemeral = (text: string) =>
      web.chat
        .postEphemeral({ channel: d.channel, user: d.userId, text })
        .catch((err) => this.logger.warn(`ephemeral failed: ${err}`));

    const atlas = this.employees.teamLead();
    const seedChannel = `slack:${d.teamId}:${d.channel}`;

    let dispositionLine: string;
    let seed: string | undefined;

    if (d.disposition === 'run') {
      // Atomic claim (open→planning, assignee=atlas) — a second click / a Run racing a Dismiss loses
      // the from='open' guard. The seed fires only on the win.
      const claimed = await this.board.claim(d.teamId, d.taskId, atlas.id);
      if (typeof claimed === 'string') {
        await ephemeral(
          claimed === 'missing'
            ? `Suggestion #${d.taskId} is no longer on the board (already dismissed?).`
            : claimed === 'blocked'
              ? `Suggestion #${d.taskId} is blocked by an unfinished dependency — can't run it yet.`
              : `Suggestion #${d.taskId} was already picked up.`,
        );
        return;
      }
      dispositionLine = `▶️ Running — handed to Atlas by <@${d.userId}>`;
      seed = `[Suggestion chip] Dennis chose RUN NOW on #${d.taskId} "${claimed.title}" — it's now picked up (planning, assigned to you). Treat it like a direct ask and BUILD it: a small fix runs straight as a bugfix; a real feature you investigate + scope the section breakdown with him, then dispatch. This is the go-ahead.`;
    } else if (d.disposition === 'dismiss') {
      // Atomic guarded delete — wins once (RETURNING), refuses a picked-up or depended-on row.
      const dropped = await this.board.dropOpen(d.teamId, d.taskId);
      if (typeof dropped === 'string') {
        await ephemeral(
          dropped === 'missing'
            ? `Suggestion #${d.taskId} is no longer on the board.`
            : dropped === 'not-open'
              ? `Suggestion #${d.taskId} was already picked up — can't dismiss it now.`
              : `Can't dismiss #${d.taskId} — another task depends on it; resolve that first.`,
        );
        return;
      }
      dispositionLine = `🗑️ Dismissed by <@${d.userId}>`;
      seed = `[Suggestion chip] Dennis DISMISSED suggestion #${d.taskId} "${dropped.title}" — it's removed from the backlog. Note it so you don't re-suggest the same thing; this is a silent heads-up, usually nothing needs saying.`;
    } else {
      // Keep in backlog — a pure no-op (it's already parked open). Read to give a clean message if it
      // was meanwhile picked up / dismissed, but never write and never wake Atlas (nothing changed).
      const task = await this.board.get(d.teamId, d.taskId);
      if (!task) {
        await ephemeral(`Suggestion #${d.taskId} is no longer on the board.`);
        return;
      }
      if (task.status !== 'open') {
        await ephemeral(
          `Suggestion #${d.taskId} was already picked up (now '${task.status}').`,
        );
        return;
      }
      dispositionLine = `📥 Kept in backlog by <@${d.userId}>`;
    }

    await web.chat
      .update({
        channel: d.channel,
        ts: d.cardTs,
        text: `Suggestion — #${d.taskId} (${dispositionLine.replace(/<@[^>]+>/, 'Dennis')})`,
        blocks: suggestionVerdictBlocks(d.cardBlocks, dispositionLine) as never,
      })
      .catch((err) => this.logger.warn(`chip repaint failed: ${err}`));

    // SILENT wake-up for Atlas (Run / Dismiss only) — a gate-bypassed seed, not a channel message.
    // The card edit is the public record; the board is the durable one. Atlas decides what (if
    // anything) to say.
    if (seed) this.conductor.injectSeed(atlas.id, seedChannel, seed);
  }

  private parseMeta(raw: string | undefined): SuggestionActionMeta | undefined {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<SuggestionActionMeta>;
      return typeof parsed.taskId === 'number'
        ? (parsed as SuggestionActionMeta)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Boss check: the OAuth installer, or the env fallback for dev workspaces. Fail-closed. */
  private async isBoss(teamId: string, userId: string): Promise<boolean> {
    const tenant = await this.tenants.get(teamId).catch(() => undefined);
    const boss = tenant?.installedBy ?? this.env.get('APPROVAL_BOSS_USER_ID');
    return !!boss && boss === userId;
  }
}
