import { EnvService } from '@core/config/env/env.service';
import { ConductorService } from '@harness/conductor/conductor.service';
import { EmployeeRegistry } from '@harness/employees/employee.registry';
import { CredentialRotationBus } from '@harness/llm-keys/credential-rotation.bus';
import { LlmReadinessService } from '@harness/llm-keys/llm-readiness.service';
import { ProviderKeyStore } from '@harness/llm-keys/provider-key.store';
import {
  type RotateKeysEvent,
  type RotateKeysPresenter,
} from '@harness/llm-keys/rotate-keys-presenter.port';
import { Injectable, Logger } from '@nestjs/common';
import { parseSlackSurface } from '../slack-membership';
import type {
  SlackInbound,
  SlackInboundInterceptor,
  SlackInteractivityPayload,
} from '../slack-inbound.types';
import { TenantSlackClients } from '../tenant-slack-clients';
import { TenantStore } from '../tenant.store';
import { isWorkspaceBoss } from './boss-auth';
import { ANTHROPIC_KEY, OPENAI_KEY } from './key-validators';
import {
  ROTATE_MODAL_BLOCKS,
  ROTATE_MODAL_CALLBACK_ID,
  ROTATE_OPEN_ACTION_ID,
  ROTATE_PREFIX,
  type RotateCardMeta,
  rotateCardBlocks,
  rotateCardDone,
  rotateKeysModalView,
} from './rotate-keys-blocks';

/**
 * The Slack adapter for the credential-rotation port, both directions — the ProjectOnboardCardsService
 * twin.
 *
 * OUTBOUND (`RotateKeysPresenter`): `present()`s an "update your keys" card with a button (the secret
 * can't cross chat, and a modal needs a click's trigger_id). Posted AS Atlas through the main app.
 *
 * INBOUND (`SlackInboundInterceptor`, `rotate:*` ids — namespaced, no overlap):
 *   • button click  → open the rotate MODAL (the click's trigger_id). Boss-gated.
 *   • view_submission → store ONLY the filled fields (put / putSubscription), fan the rotation out to
 *     every keyed cache (CredentialRotationBus), refresh readiness, repaint the card, and wake Atlas
 *     so a turn that was blocked on the dead key can retry. Boss-gated, fail-closed.
 */
@Injectable()
export class RotateKeysCardsService
  implements RotateKeysPresenter, SlackInboundInterceptor
{
  private readonly logger = new Logger(RotateKeysCardsService.name);
  private readonly avatarBase?: string;

  constructor(
    private readonly clients: TenantSlackClients,
    private readonly tenants: TenantStore,
    private readonly employees: EmployeeRegistry,
    private readonly providerKeys: ProviderKeyStore,
    private readonly readiness: LlmReadinessService,
    private readonly rotation: CredentialRotationBus,
    private readonly conductor: ConductorService,
    private readonly env: EnvService,
  ) {
    const base = this.env.get('AVATAR_BASE_URL');
    if (base) {
      const style = this.env.get('AVATAR_STYLE') ?? 'illustrated';
      this.avatarBase = `${base.replace(/\/+$/, '')}/${style}`;
    }
  }

  // ── Outbound: post the card ─────────────────────────────────────────────────────────────────

  async present(e: RotateKeysEvent): Promise<void> {
    const parsed = parseSlackSurface(e.surfaceId);
    if (!parsed)
      throw new Error(
        `rotate-keys card requested from a non-Slack room (${e.surfaceId})`,
      );
    const web = await this.clients.clientFor(parsed.teamId);
    if (!web) throw new Error(`no Slack client for workspace ${parsed.teamId}`);
    const atlas = this.employees.teamLead();
    // The button value carries the harness surface coordinate the click payload doesn't; channel +
    // card ts come from the click payload at open time.
    const value = JSON.stringify({ surfaceId: e.surfaceId });
    const card = await web.chat.postMessage({
      channel: parsed.channel,
      text: `Update your API keys — ${e.reason}`,
      blocks: rotateCardBlocks({
        reason: e.reason,
        suspected: e.suspected,
        value,
      }).blocks as never,
      username: atlas.name,
      ...(this.avatarBase
        ? { icon_url: `${this.avatarBase}/${atlas.id}.png` }
        : {}),
    });
    if (!card.ts) throw new Error('rotate-keys card post returned no ts');
  }

  // ── Inbound ─────────────────────────────────────────────────────────────────────────────────

  async maybeHandle(item: SlackInbound): Promise<boolean> {
    if (item.kind !== 'interactivity') return false;
    const payload = item.payload;
    if (payload.type === 'block_actions') {
      const action = payload.actions?.find((a) =>
        a.action_id?.startsWith(ROTATE_PREFIX),
      );
      if (!action) return false;
      await item.respond();
      if (action.action_id === ROTATE_OPEN_ACTION_ID)
        await this.openModal(payload, action.value).catch((err) =>
          this.logger.error(`rotate modal open failed: ${err}`),
        );
      return true;
    }
    if (
      payload.type === 'view_submission' &&
      payload.view?.callback_id === ROTATE_MODAL_CALLBACK_ID
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
    if (!(await isWorkspaceBoss(this.tenants, this.env, teamId, payload.user?.id))) {
      const web = await this.clients.clientFor(teamId);
      await web?.chat.postEphemeral({
        channel: payload.channel?.id ?? '',
        user: payload.user?.id ?? '',
        text: `Only the workspace owner updates the keys — this one's for Dennis.`,
      });
      return;
    }
    const surfaceId = this.parseValue(value);
    const meta: RotateCardMeta = {
      team: teamId,
      channel: payload.channel?.id ?? '',
      cardTs: (payload.message as { ts?: string } | undefined)?.ts,
      surfaceId: surfaceId ?? `slack:${teamId}:${payload.channel?.id ?? ''}`,
    };
    const web = await this.clients.clientFor(teamId);
    await web?.views.open({
      trigger_id: payload.trigger_id,
      view: rotateKeysModalView(JSON.stringify(meta)) as never,
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
    if (!(await isWorkspaceBoss(this.tenants, this.env, meta.team, payload.user?.id))) {
      await item.respond({
        response_action: 'errors',
        errors: {
          [ROTATE_MODAL_BLOCKS.anthropic.blockId]:
            'Only the workspace owner can update the keys.',
        },
      });
      return true;
    }
    const values = payload.view?.state?.values ?? {};
    const read = (c: { blockId: string; actionId: string }): string =>
      (values[c.blockId]?.[c.actionId]?.value ?? '').trim();
    const anthropic = read(ROTATE_MODAL_BLOCKS.anthropic);
    const openai = read(ROTATE_MODAL_BLOCKS.openai);
    const anthropicSub = read(ROTATE_MODAL_BLOCKS.anthropicSub);
    const openaiSub = read(ROTATE_MODAL_BLOCKS.openaiSub);

    // At least one field, and any filled API key must look valid.
    const errors: Record<string, string> = {};
    if (anthropic && !ANTHROPIC_KEY.test(anthropic))
      errors[ROTATE_MODAL_BLOCKS.anthropic.blockId] =
        'That does not look like an Anthropic key (sk-ant-…).';
    if (openai && !OPENAI_KEY.test(openai))
      errors[ROTATE_MODAL_BLOCKS.openai.blockId] =
        'That does not look like an OpenAI key (sk-…).';
    if (!anthropic && !openai && !anthropicSub && !openaiSub)
      errors[ROTATE_MODAL_BLOCKS.anthropic.blockId] =
        'Enter at least one credential to update.';
    if (Object.keys(errors).length > 0) {
      await item.respond({ response_action: 'errors', errors });
      return true;
    }

    const updated: string[] = [];
    try {
      if (anthropic) {
        await this.providerKeys.put(meta.team, 'anthropic', anthropic);
        updated.push('Anthropic API key');
      }
      if (openai) {
        await this.providerKeys.put(meta.team, 'openai', openai);
        updated.push('OpenAI API key');
      }
      if (anthropicSub) {
        await this.providerKeys.putSubscription(
          meta.team,
          'anthropic',
          'subscription',
          anthropicSub,
        );
        updated.push('Claude subscription token');
      }
      if (openaiSub) {
        await this.providerKeys.putSubscription(
          meta.team,
          'openai',
          'subscription',
          openaiSub,
        );
        updated.push('Codex subscription token');
      }
    } catch (err) {
      this.logger.error(`rotate submission failed: ${err}`);
      await item.respond({
        response_action: 'errors',
        errors: {
          [ROTATE_MODAL_BLOCKS.anthropic.blockId]:
            'Storing failed on the server (encryption key missing?) — check the stack logs.',
        },
      });
      return true;
    }

    await item.respond(); // close the modal
    // Fan the rotation out to every credential-keyed cache, then re-evaluate readiness.
    this.rotation.emit(meta.team);
    await this.readiness.refresh(meta.team);
    const summary = updated.join(', ');
    await this.repaintCard(meta, `✅ Updated: ${summary}.`);
    const atlas = this.employees.teamLead();
    this.conductor.injectSeed(
      atlas.id,
      meta.surfaceId,
      `[Credentials] Dennis just updated the keys (${summary}) via the update-keys card. If you were blocked on an auth/unauthorized failure, retry the work that failed now; otherwise just confirm you're back online.`,
    );
    return true;
  }

  private async repaintCard(meta: RotateCardMeta, line: string): Promise<void> {
    if (!meta.cardTs) return;
    const web = await this.clients.clientFor(meta.team);
    const blocks = rotateCardBlocks({ reason: '', value: '' }).blocks;
    await web?.chat
      .update({
        channel: meta.channel,
        ts: meta.cardTs,
        text: line,
        blocks: rotateCardDone(
          blocks as Array<Record<string, unknown>>,
          line,
        ) as never,
      })
      .catch((err) => this.logger.warn(`rotate card repaint failed: ${err}`));
  }

  private parseValue(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    try {
      const v = JSON.parse(raw) as { surfaceId?: string };
      return v.surfaceId || undefined;
    } catch {
      return undefined;
    }
  }

  private parseMeta(raw: string | undefined): RotateCardMeta | undefined {
    if (!raw) return undefined;
    try {
      const m = JSON.parse(raw) as Partial<RotateCardMeta>;
      return m.team && m.surfaceId ? (m as RotateCardMeta) : undefined;
    } catch {
      return undefined;
    }
  }
}
