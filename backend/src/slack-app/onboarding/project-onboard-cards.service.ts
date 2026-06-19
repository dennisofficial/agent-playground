import { EnvService } from '@core/config/env/env.service';
import { ChannelProjectLinker } from '@harness/approvals/channel-project-linker';
import {
  type ProjectOnboardEvent,
  type ProjectOnboardPresenter,
} from '@harness/approvals/project-onboard-presenter.port';
import { ProjectRegistrar } from '@harness/approvals/project-onboard.service';
import { ConductorService } from '@harness/conductor/conductor.service';
import { EmployeeRegistry } from '@harness/employees/employee.registry';
import { Injectable, Logger } from '@nestjs/common';
import { parseSlackSurface } from '../slack-membership';
import { isWorkspaceBoss } from './boss-auth';
import type {
  SlackInbound,
  SlackInboundInterceptor,
  SlackInteractivityPayload,
} from '../slack-inbound.types';
import { TenantSlackClients } from '../tenant-slack-clients';
import { TenantStore } from '../tenant.store';
import {
  ONBOARD_MODAL_BLOCKS,
  ONBOARD_MODAL_CALLBACK_ID,
  ONBOARD_OPEN_ACTION_ID,
  ONBOARD_PREFIX,
  type OnboardCardMeta,
  onboardCardBlocks,
  onboardCardDone,
  onboardModalView,
} from './project-onboard-blocks';

const GITHUB_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+?(\.git)?\/?$/;

/**
 * The Slack adapter for the project-onboarding port, both directions — the `SuggestionCardsService`
 * twin:
 *
 * OUTBOUND (`ProjectOnboardPresenter`): `onboard_project` couldn't auto-register a repo (no token / no
 * access / ambiguous), so it `present()`s a card — "Onboard `name`?" with a button — posted AS Atlas
 * through the main app (Slack routes block_actions to the posting app).
 *
 * INBOUND (`SlackInboundInterceptor`, `onboard:*` ids — namespaced, no overlap with approval/suggestion):
 *   • button click  → open the onboarding MODAL (the click's trigger_id; a tool call has none). The
 *     modal collects the repo URL + an optional GitHub token (the secrets path — never chat).
 *   • view_submission → register via ProjectOnboardService.completeWithUrl, repaint the card, and wake
 *     Atlas (injectSeed) to retry the reference. Boss-gated, fail-closed (the approval-card idiom).
 */
@Injectable()
export class ProjectOnboardCardsService
  implements ProjectOnboardPresenter, SlackInboundInterceptor
{
  private readonly logger = new Logger(ProjectOnboardCardsService.name);
  private readonly avatarBase?: string;

  constructor(
    private readonly clients: TenantSlackClients,
    private readonly tenants: TenantStore,
    private readonly registrar: ProjectRegistrar,
    // Presenter-FREE linker (NOT ProjectOnboardService, which carries the presenter — that would
    // re-introduce the service↔card DI cycle this service exists on `ProjectRegistrar` to avoid).
    private readonly linker: ChannelProjectLinker,
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

  async present(e: ProjectOnboardEvent): Promise<void> {
    const parsed = parseSlackSurface(e.surfaceId);
    if (!parsed)
      throw new Error(
        `onboarding card requested from a non-Slack room (${e.surfaceId})`,
      );
    const web = await this.clients.clientFor(parsed.teamId);
    if (!web) throw new Error(`no Slack client for workspace ${parsed.teamId}`);
    const atlas = this.employees.teamLead();
    // The button value carries what the modal needs that the click payload doesn't (name + a URL guess
    // + the harness surface coordinate); channel + card ts come from the click payload at open time.
    const value = JSON.stringify({
      name: e.name,
      gitUrl: e.gitUrl ?? '',
      surfaceId: e.surfaceId,
    });
    const card = await web.chat.postMessage({
      channel: parsed.channel,
      text: `Onboard ${e.name}? — ${e.reason}`,
      blocks: onboardCardBlocks({
        name: e.name,
        gitUrl: e.gitUrl,
        reason: e.reason,
        value,
      }) as never,
      username: atlas.name,
      ...(this.avatarBase
        ? { icon_url: `${this.avatarBase}/${atlas.id}.png` }
        : {}),
    });
    if (!card.ts) throw new Error('onboarding card post returned no ts');
  }

  // ── Inbound ─────────────────────────────────────────────────────────────────────────────────

  async maybeHandle(item: SlackInbound): Promise<boolean> {
    if (item.kind !== 'interactivity') return false;
    const payload = item.payload;
    if (payload.type === 'block_actions') {
      const action = payload.actions?.find((a) =>
        a.action_id?.startsWith(ONBOARD_PREFIX),
      );
      if (!action) return false;
      await item.respond();
      if (action.action_id === ONBOARD_OPEN_ACTION_ID)
        await this.openModal(payload, action.value).catch((err) =>
          this.logger.error(`onboard modal open failed: ${err}`),
        );
      return true;
    }
    if (
      payload.type === 'view_submission' &&
      payload.view?.callback_id === ONBOARD_MODAL_CALLBACK_ID
    ) {
      return this.handleSubmission(item, payload);
    }
    return false;
  }

  private async openModal(
    payload: SlackInteractivityPayload,
    value: string | undefined,
  ): Promise<void> {
    const teamId = payload.team?.id;
    if (!teamId || !payload.trigger_id) return;
    if (!(await this.isBoss(teamId, payload.user?.id))) {
      const web = await this.clients.clientFor(teamId);
      await web?.chat.postEphemeral({
        channel: payload.channel?.id ?? '',
        user: payload.user?.id ?? '',
        text: `Only the workspace owner onboards projects — this one's for Dennis.`,
      });
      return;
    }
    const btn = this.parseValue(value);
    if (!btn) return;
    const meta: OnboardCardMeta = {
      team: teamId,
      channel: payload.channel?.id ?? '',
      cardTs: (payload.message as { ts?: string } | undefined)?.ts,
      surfaceId: btn.surfaceId,
      name: btn.name,
      gitUrl: btn.gitUrl || undefined,
    };
    const web = await this.clients.clientFor(teamId);
    await web?.views.open({
      trigger_id: payload.trigger_id,
      view: onboardModalView(
        JSON.stringify(meta),
        btn.name,
        btn.gitUrl || undefined,
      ) as never,
    });
  }

  private async handleSubmission(
    item: Extract<SlackInbound, { kind: 'interactivity' }>,
    payload: SlackInteractivityPayload,
  ): Promise<boolean> {
    const meta = this.parseMeta(payload.view?.private_metadata);
    if (!meta) {
      await item.respond();
      return true;
    }
    if (!(await this.isBoss(meta.team, payload.user?.id))) {
      await item.respond({
        response_action: 'errors',
        errors: {
          [ONBOARD_MODAL_BLOCKS.url.blockId]:
            'Only the workspace owner can onboard a project.',
        },
      });
      return true;
    }
    const values = payload.view?.state?.values ?? {};
    const read = (c: { blockId: string; actionId: string }): string =>
      (values[c.blockId]?.[c.actionId]?.value ?? '').trim();
    const url = read(ONBOARD_MODAL_BLOCKS.url);
    const token = read(ONBOARD_MODAL_BLOCKS.token);
    if (!GITHUB_URL.test(url)) {
      await item.respond({
        response_action: 'errors',
        errors: {
          [ONBOARD_MODAL_BLOCKS.url.blockId]:
            'Enter an https://github.com/<owner>/<repo> URL.',
        },
      });
      return true;
    }

    let outcome;
    try {
      outcome = await this.registrar.completeWithUrl({
        team: meta.team,
        url,
        token: token || undefined,
      });
    } catch (err) {
      this.logger.error(`onboard submission failed: ${err}`);
      await item.respond({
        response_action: 'errors',
        errors: {
          [ONBOARD_MODAL_BLOCKS.url.blockId]:
            'Registering failed on the server — check the stack logs.',
        },
      });
      return true;
    }

    if (
      outcome.status === 'needs-token' ||
      outcome.status === 'not-found' ||
      outcome.status === 'ambiguous'
    ) {
      await item.respond({
        response_action: 'errors',
        errors: {
          [ONBOARD_MODAL_BLOCKS.token.blockId]:
            outcome.status === 'needs-token'
              ? `Couldn't register it — ${outcome.reason}.`
              : `That doesn't look like a reachable GitHub repo.`,
        },
      });
      return true;
    }

    await item.respond(); // close the modal
    const projectId = outcome.projectId;
    // Bind it as the channel's main repo if the channel doesn't have one yet (the same rule as the
    // tool path); otherwise it's a read-only reference.
    const { linkedAsMain } = await this.linker
      .linkChannelProject({
        team: meta.team,
        surfaceId: meta.surfaceId,
        projectId,
      })
      .catch(() => ({ linkedAsMain: false }));
    await this.repaintCard(
      meta,
      linkedAsMain
        ? `✅ Linked \`${projectId}\` as this channel's repo.`
        : `✅ Onboarded \`${projectId}\` (read-only).`,
    );
    const atlas = this.employees.teamLead();
    this.conductor.injectSeed(
      atlas.id,
      meta.surfaceId,
      linkedAsMain
        ? `[Project onboarding] Dennis just linked ${projectId} as this channel's main repo via the onboarding card — it's the project you build here now. Confirm you're set up and offer to get started.`
        : `[Project onboarding] Dennis just registered ${projectId} (read-only) via the onboarding card. If you were waiting on it, reference_project({ name: "${projectId}" }) now and carry on; otherwise just note it's available.`,
    );
    return true;
  }

  private async repaintCard(meta: OnboardCardMeta, line: string): Promise<void> {
    if (!meta.cardTs) return;
    const web = await this.clients.clientFor(meta.team);
    const blocks = onboardCardBlocks({
      name: meta.name,
      gitUrl: meta.gitUrl,
      reason: '',
      value: '',
    }).blocks;
    await web?.chat
      .update({
        channel: meta.channel,
        ts: meta.cardTs,
        text: line,
        blocks: onboardCardDone(
          blocks as Array<Record<string, unknown>>,
          line,
        ) as never,
      })
      .catch((err) => this.logger.warn(`onboard card repaint failed: ${err}`));
  }

  private parseValue(
    raw: string | undefined,
  ): { name: string; gitUrl: string; surfaceId: string } | undefined {
    if (!raw) return undefined;
    try {
      const v = JSON.parse(raw) as {
        name?: string;
        gitUrl?: string;
        surfaceId?: string;
      };
      return v.name && v.surfaceId
        ? { name: v.name, gitUrl: v.gitUrl ?? '', surfaceId: v.surfaceId }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private parseMeta(raw: string | undefined): OnboardCardMeta | undefined {
    if (!raw) return undefined;
    try {
      const m = JSON.parse(raw) as Partial<OnboardCardMeta>;
      return m.team && m.surfaceId && m.name
        ? (m as OnboardCardMeta)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private isBoss(teamId: string, userId: string | undefined): Promise<boolean> {
    return isWorkspaceBoss(this.tenants, this.env, teamId, userId);
  }
}
