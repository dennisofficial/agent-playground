import { EnvService } from '@core/config/env/env.service';
import {
  type BoardNotifier,
  type DescriptionChangeEvent,
} from '@harness/approvals/board-notifier.port';
import {
  type PlanProposalEvent,
  type PlanProposalPresenter,
} from '@harness/approvals/proposal-presenter.port';
import { ConductorService } from '@harness/conductor/conductor.service';
import { EmployeeRegistry } from '@harness/employees/employee.registry';
import { BoardStore } from '@harness/memory/board-store';
import { TicketNoteStore } from '@harness/memory/ticket-note-store';
import { Injectable, Logger } from '@nestjs/common';
import { parseSlackSurface } from '../slack-membership';
import { SlackDirectoryService } from '../slack-directory.service';
import type {
  SlackInbound,
  SlackInboundInterceptor,
  SlackInteractivityPayload,
} from '../slack-inbound.types';
import { TenantSlackClients } from '../tenant-slack-clients';
import { TenantStore } from '../tenant.store';
import {
  APPROVE_ACTION_ID,
  type ApprovalActionMeta,
  chunkPlan,
  descriptionChangeCardBlocks,
  DENY_ACTION_ID,
  proposalCardBlocks,
  REQUEST_CHANGES_ACTION_ID,
  REVISION_MODAL_CALLBACK_ID,
  revisionModalView,
  verdictBlocks,
} from './approval-blocks';

const APPROVAL_PREFIX = 'approval:';

/**
 * The Slack adapter for the plan-proposal port, both directions:
 *
 * OUTBOUND (`PlanProposalPresenter`): `propose_plan` calls `present()` — post the approval card
 * (the lead's summary + Approve / Request changes / Deny), then each employee's full plan as
 * thread replies under it. The card is a rendering of board state, never a store.
 *
 * INBOUND (`SlackInboundInterceptor`, after the onboarding guard): a card click is just another ingestion. The
 * clicker must be the BOSS (tenant.installed_by, or APPROVAL_BOSS_USER_ID for dev workspaces that
 * never OAuth-installed; fail-closed when neither is set). The verdict is applied with an atomic
 * compare-and-set on the board (double clicks and stale cards lose harmlessly), recorded as a
 * ticket note, painted onto the card (chat.update), and re-enters the agent system through
 * `conductor.submitFrom` as a Dennis-authored channel message that @mentions the proposing lead —
 * identical, by construction, to Dennis typing the verdict in chat.
 */
@Injectable()
export class ApprovalCardsService
  implements PlanProposalPresenter, SlackInboundInterceptor, BoardNotifier
{
  private readonly logger = new Logger(ApprovalCardsService.name);

  /** `${AVATAR_BASE_URL}/${AVATAR_STYLE}` — the chat surface's username-override icon idiom. */
  private readonly avatarBase?: string;

  constructor(
    private readonly clients: TenantSlackClients,
    private readonly tenants: TenantStore,
    private readonly directory: SlackDirectoryService,
    private readonly board: BoardStore,
    private readonly notes: TicketNoteStore,
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

  // ── Outbound: post the card ─────────────────────────────────────────────────────────────────

  async present(e: PlanProposalEvent): Promise<void> {
    const parsed = parseSlackSurface(e.surfaceId);
    if (!parsed)
      throw new Error(
        `proposal for #${e.taskId} was made from a non-Slack room (${e.surfaceId}) — no card here`,
      );
    const web = await this.clients.clientFor(parsed.teamId);
    if (!web) throw new Error(`no Slack client for workspace ${parsed.teamId}`);
    // The card POSTS AS the proposing lead — username/icon override (the chat surface's idiom),
    // but through the MAIN app on purpose: Slack routes block_actions to the app that posted the
    // message, so the card must be app-posted for button interactivity to work.
    const proposer = this.employees.byId(e.proposedBy);
    const card = await web.chat.postMessage({
      channel: parsed.channel,
      text: `Proposal — ticket #${e.taskId}: ${e.title} (verdict needed)`,
      blocks: proposalCardBlocks(e) as never,
      username: proposer?.name ?? e.proposedBy,
      ...(this.avatarBase
        ? { icon_url: `${this.avatarBase}/${e.proposedBy}.png` }
        : {}),
    });
    if (!card.ts) throw new Error('card post returned no ts');
    // Full plans under the card — readable copy; the ticket holds the durable text.
    for (const plan of e.plans) {
      await this.postPlanArtifact(
        web,
        parsed.teamId,
        parsed.channel,
        card.ts,
        e.taskId,
        plan,
      );
    }
  }

  // ── Outbound: description-change notification ───────────────────────────────────────────────

  async notifyDescriptionChange(e: DescriptionChangeEvent): Promise<void> {
    const parsed = parseSlackSurface(e.surfaceId);
    if (!parsed)
      throw new Error(
        `description-change card for #${e.taskId} from a non-Slack room (${e.surfaceId})`,
      );
    const web = await this.clients.clientFor(parsed.teamId);
    if (!web) throw new Error(`no Slack client for workspace ${parsed.teamId}`);

    // Resolve the boss mention — <@Uxxxx> when configured; literal fallback so the card still
    // posts but without a ping (dev workspaces without APPROVAL_BOSS_USER_ID configured).
    const tenant = await this.tenants.get(parsed.teamId).catch(() => undefined);
    const bossId = tenant?.installedBy ?? this.env.get('APPROVAL_BOSS_USER_ID');
    const bossMention = bossId ? `<@${bossId}>` : 'Dennis';

    const actor = this.employees.byId(e.changedBy);
    const actorName = actor?.name ?? e.changedBy;

    await web.chat.postMessage({
      channel: parsed.channel,
      text: `${bossMention} — description changed on ticket #${e.taskId}: ${e.title} (by ${actorName})`,
      blocks: descriptionChangeCardBlocks(e, bossMention) as never,
      username: actorName,
      ...(this.avatarBase
        ? { icon_url: `${this.avatarBase}/${e.changedBy}.png` }
        : {}),
    });
  }

  /**
   * One plan into the card's thread, best rendering first:
   *  1. A FILE SNIPPET (`files.uploadV2`, .md) — Slack gives it a real markdown viewer, no chunk
   *     caps. Uploaded by the single app (needs the `files:write` scope) — missing scope falls through.
   *  2. Fallback: the chunked plain-text thread replies (universal, no extra scope, ugly).
   */
  private async postPlanArtifact(
    web: NonNullable<Awaited<ReturnType<TenantSlackClients['clientFor']>>>,
    teamId: string,
    channel: string,
    cardTs: string,
    taskId: number,
    plan: { employee: string; planMd: string },
  ): Promise<void> {
    const upload = {
      channel_id: channel,
      thread_ts: cardTs,
      filename: `ticket-${taskId}-${plan.employee}-plan.md`,
      title: `${plan.employee}'s plan — ticket #${taskId}`,
      content: plan.planMd,
      initial_comment: `*${plan.employee}'s plan* for ticket #${taskId}`,
    };
    // Single voice: the one app uploads the snippet (no per-author posting client).
    try {
      await web.filesUploadV2(upload);
      return;
    } catch (err) {
      this.logger.warn(
        `plan snippet upload (#${taskId}, ${plan.employee}) failed — ${err instanceof Error ? err.message : String(err)}; falling back`,
      );
    }
    for (const [i, chunk] of chunkPlan(plan.planMd).entries()) {
      const header = i === 0 ? `*${plan.employee}'s plan*\n` : '';
      await web.chat.postMessage({
        channel,
        thread_ts: cardTs,
        text: `${header}${chunk}`,
      });
    }
  }

  // ── Inbound: verdicts ───────────────────────────────────────────────────────────────────────

  /** Router contract: true = consumed. Everything non-`approval:*` falls through. */
  async maybeHandle(item: SlackInbound): Promise<boolean> {
    if (item.kind !== 'interactivity') return false;
    const payload = item.payload;
    if (payload.type === 'block_actions') {
      const action = payload.actions?.find((a) =>
        a.action_id?.startsWith(APPROVAL_PREFIX),
      );
      if (!action) return false;
      await item.respond();
      await this.handleAction(payload, action).catch((err) =>
        this.logger.error(`approval action failed: ${err}`),
      );
      return true;
    }
    if (
      payload.type === 'view_submission' &&
      payload.view?.callback_id === REVISION_MODAL_CALLBACK_ID
    ) {
      await this.handleRevisionSubmission(item, payload).catch((err) =>
        this.logger.error(`revision submission failed: ${err}`),
      );
      return true;
    }
    return false;
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
        text: `Only the workspace owner rules on proposals — this one's for Dennis.`,
      });
      return;
    }

    if (action.action_id === REQUEST_CHANGES_ACTION_ID) {
      // No board write yet — collect the notes first; the modal submission applies the verdict.
      await web.views.open({
        trigger_id: payload.trigger_id ?? '',
        view: revisionModalView(
          JSON.stringify({
            taskId: meta.taskId,
            channel,
            ts: message.ts,
            surfaceId: `slack:${teamId}:${channel}`,
          } satisfies ApprovalActionMeta),
        ) as never,
      });
      return;
    }

    if (
      action.action_id !== APPROVE_ACTION_ID &&
      action.action_id !== DENY_ACTION_ID
    )
      return; // an approval:* id this build doesn't know — consumed (acked) but a no-op
    await this.applyVerdict({
      teamId,
      channel,
      userId,
      cardTs: message.ts,
      cardBlocks: message.blocks ?? [],
      taskId: meta.taskId,
      verdict: action.action_id === APPROVE_ACTION_ID ? 'approve' : 'deny',
    });
  }

  private async handleRevisionSubmission(
    item: Extract<SlackInbound, { kind: 'interactivity' }>,
    payload: SlackInteractivityPayload,
  ): Promise<void> {
    const teamId = payload.team?.id;
    const userId = payload.user?.id;
    const meta = this.parseMeta(payload.view?.private_metadata);
    const notesText =
      payload.view?.state?.values?.notes?.notes?.value?.trim() ?? '';
    if (!teamId || !userId || !meta?.channel || !meta.ts) {
      await item.respond();
      return;
    }
    if (!(await this.isBoss(teamId, userId))) {
      await item.respond(); // close the modal; the button path already ephemerally refused
      return;
    }
    await item.respond(); // close the modal
    await this.applyVerdict({
      teamId,
      channel: meta.channel,
      userId,
      cardTs: meta.ts,
      cardBlocks: undefined, // a view_submission carries no message — repaint fetches nothing
      taskId: meta.taskId,
      verdict: 'request_changes',
      notesText,
    });
  }

  /** The one verdict path: CAS the board, note it, repaint the card, ingest the Dennis message. */
  private async applyVerdict(v: {
    teamId: string;
    channel: string;
    userId: string;
    cardTs: string;
    cardBlocks: Array<Record<string, unknown>> | undefined;
    taskId: number;
    verdict: 'approve' | 'deny' | 'request_changes';
    notesText?: string;
  }): Promise<void> {
    const web = await this.clients.clientFor(v.teamId);
    if (!web) return;

    // Atomic CAS from 'awaiting_approval' — double clicks, stale cards, and concurrent verdicts
    // all lose here, harmlessly.
    const to =
      v.verdict === 'approve'
        ? { status: 'approved' as const }
        : v.verdict === 'deny'
          ? { status: 'open' as const, assignee: null }
          : { status: 'planning' as const };
    const flipped = await this.board.transition(
      v.teamId,
      v.taskId,
      'awaiting_approval',
      to,
    );
    if (!flipped) {
      const now = await this.board.get(v.teamId, v.taskId);
      await web.chat.postEphemeral({
        channel: v.channel,
        user: v.userId,
        text: `Proposal #${v.taskId} was already ruled on (now '${now?.status ?? 'gone'}').`,
      });
      return;
    }

    const boss = await this.directory.resolveUser(v.teamId, v.userId);
    const noteBody =
      v.verdict === 'approve'
        ? 'Approved the proposal (via the Slack approval card).'
        : v.verdict === 'deny'
          ? 'Denied the proposal (via the Slack approval card) — ticket released to the board.'
          : `Requested changes on the proposal (via the Slack approval card): ${v.notesText || '(no notes)'}`;
    await this.notes
      .add(v.teamId, v.taskId, boss.authorId, noteBody)
      .catch((err) => this.logger.warn(`verdict note failed: ${err}`));

    const verdictLine =
      v.verdict === 'approve'
        ? `✅ Approved by <@${v.userId}>`
        : v.verdict === 'deny'
          ? `❌ Denied by <@${v.userId}> — released to the board`
          : `✏️ Changes requested by <@${v.userId}>`;
    await web.chat
      .update({
        channel: v.channel,
        ts: v.cardTs,
        text: `Proposal — ticket #${v.taskId} (${verdictLine.replace(/<@[^>]+>/, 'Dennis')})`,
        blocks: verdictBlocks(
          v.cardBlocks ?? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Proposal — ticket #${v.taskId}*`,
              },
            },
          ],
          verdictLine,
        ) as never,
      })
      .catch((err) => this.logger.warn(`card repaint failed: ${err}`));

    // SILENT wake-up for Atlas (the orchestrator) — a gate-bypassed seed, not a channel message.
    // The card edit is the public record (Dennis sees ✅/❌ on the card itself); the board and the
    // ticket note are the durable ones. On approval the board CAS already fired `ticket-approved`,
    // so the pipeline runner resumes the paused run on its own — this seed just lets Atlas narrate
    // the verdict if it's worth a line. Atlas decides what, if anything, to say.
    const atlas = this.employees.teamLead();
    const verdictNote =
      v.verdict === 'approve'
        ? `${boss.authorName} APPROVED ticket #${v.taskId} via the approval card.`
        : v.verdict === 'deny'
          ? `${boss.authorName} DENIED ticket #${v.taskId} via the approval card — released back to the backlog (open, unassigned).`
          : `${boss.authorName} requested CHANGES on ticket #${v.taskId} via the approval card: "${v.notesText || '(no notes given)'}".`;
    const nextStep =
      v.verdict === 'approve'
        ? 'The pipeline resumes its remaining stages on its own — nothing for you to do.'
        : v.verdict === 'deny'
          ? 'The ticket is back in the backlog and its pipeline run is parked.'
          : 'The ticket is back in planning for a revision pass.';
    this.conductor.injectSeed(
      atlas.id,
      `slack:${v.teamId}:${v.channel}`,
      `[Approval card] ${verdictNote} The board is already updated and the card shows the verdict — this is a silent heads-up, not a message in the channel. ${nextStep} Decide what's next yourself: usually NOTHING needs saying right now (don't re-announce the verdict — Dennis can already see the card).`,
    );
  }

  private parseMeta(raw: string | undefined): ApprovalActionMeta | undefined {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<ApprovalActionMeta>;
      return typeof parsed.taskId === 'number'
        ? (parsed as ApprovalActionMeta)
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
