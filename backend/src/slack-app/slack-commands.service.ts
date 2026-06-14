import { EnvService } from '@core/config/env/env.service';
import { ConductorMetricsService } from '@harness/conductor/conductor-metrics.service';
import { MemoryMetricsService } from '@harness/memory/memory-metrics.service';
import { Injectable, Logger } from '@nestjs/common';
import type {
  SlackCommandPayload,
  SlackInbound,
  SlackInboundInterceptor,
} from './slack-inbound.types';
import { TenantStore } from './tenant.store';

/**
 * Slash-command handler — the Slack home for harness control commands. Today: `/metrics`, a
 * boss-gated, ephemeral read of this-session memory health (recall hit-rate + write counts), the
 * Slack replacement for the old TUI `/metrics`. Wired as the router's COMMAND_INTERCEPTOR, so it
 * runs in the same in-process Slack server that composes the harness — `MemoryMetricsService` is the
 * live counter, not a cross-process copy.
 *
 * Replies via the transport's `respond` (HTTP 200 JSON over the Events API, the socket ack in dev) —
 * no Slack client needed; an `ephemeral` response is visible only to the invoker.
 */
@Injectable()
export class SlackCommandService implements SlackInboundInterceptor {
  private readonly logger = new Logger(SlackCommandService.name);

  constructor(
    private readonly metrics: MemoryMetricsService,
    private readonly conductorMetrics: ConductorMetricsService,
    private readonly tenants: TenantStore,
    private readonly env: EnvService,
  ) {}

  async maybeHandle(item: SlackInbound): Promise<boolean> {
    if (item.kind !== 'command') return false;
    const cmd = item.command;
    // Normalize ("/Metrics" → "/metrics"); Slack always sends the leading slash.
    if (cmd.command.trim().toLowerCase() !== '/metrics') return false;

    if (!(await this.isBoss(cmd))) {
      await item.respond(ephemeral('Sorry — `/metrics` is boss-only.'));
      return true;
    }
    await item.respond(ephemeral(this.formatMetrics()));
    return true;
  }

  /** Boss check, mirroring ApprovalCardsService: the OAuth installer, or the dev env fallback. */
  private async isBoss(cmd: SlackCommandPayload): Promise<boolean> {
    if (!cmd.user_id) return false;
    const tenant = cmd.team_id
      ? await this.tenants.get(cmd.team_id).catch(() => undefined)
      : undefined;
    const boss = tenant?.installedBy ?? this.env.get('APPROVAL_BOSS_USER_ID');
    return !!boss && boss === cmd.user_id;
  }

  /** One-screen memory-health summary from the live session counters. */
  private formatMetrics(): string {
    const m = this.metrics.snapshot();
    const pct = (n: number, d: number) =>
      d ? `${((n / d) * 100).toFixed(0)}%` : '—';
    const sumAttempts = (t: Record<string, { attempts: number }>) =>
      Object.values(t).reduce((a, p) => a + p.attempts, 0);
    const r = m.recall;
    const c = this.conductorMetrics.snapshot();
    return [
      '*Memory health* (this session)',
      `• recall: ${r.attempts} attempts · ${pct(r.hits, r.attempts)} surfaced ≥1 fact · ` +
        `${r.attempts ? (r.factsInjected / r.attempts).toFixed(1) : '0'} facts/pass avg`,
      `• writes: ${m.insertCount} new · ${m.dedupCount} merged · ${m.judgeCallCount} judge calls`,
      `• reconcile passes: ${sumAttempts(m.memByPath)} memory · ${sumAttempts(m.taskByPath)} task`,
      `• under-response: ${c.humanBurstDropped} dropped (no one responded)`,
    ].join('\n');
  }
}

/** A Slack slash-command reply visible only to the invoker. */
function ephemeral(text: string): { response_type: 'ephemeral'; text: string } {
  return { response_type: 'ephemeral', text };
}
