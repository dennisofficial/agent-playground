import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable, Logger } from '@nestjs/common';
import { EAgentProvider } from '@workspace/shared';
import { randomUUID } from 'node:crypto';
import type { InboundMessageModel } from '../../generated/prisma/models';
import { AgentCredentialService } from '../agent-credentials/agent-credential.service';
import {
  AgentUsageService,
  type HarvestInfo,
} from '../agent-credentials/usage/agent-usage.service';
import {
  HostTransportService,
  type LivePointer,
  TurnStalledError,
} from '../host-transport/host-transport.service';
import { InboundMessageService } from '../inbound-message/inbound-message.service';
import { SandboxService } from '../sandbox/sandbox.service';
import { TurnSpecBuilderService } from './turn-spec-builder.service';
import { TurnTranscriptService } from './turn-transcript.service';

const FORWARD_POLL_MS = 750;

interface SentMessage {
  row: InboundMessageModel;
  orderAt: Date | null;
  messagesAtHandoff: number;
  trigger: boolean;
}

@Injectable()
export class TurnDispatcherService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly specBuilder: TurnSpecBuilderService,
    private readonly transport: HostTransportService,
    private readonly sandbox: SandboxService,
    private readonly inbound: InboundMessageService,
    private readonly transcript: TurnTranscriptService,
    private readonly prismaService: PrismaService,
    private readonly agentCredentialService: AgentCredentialService,
    private readonly agentUsageService: AgentUsageService,
  ) {}

  async run(jobId: string, messages: InboundMessageModel[]): Promise<void> {
    const { threadId, orgId } = messages[0];
    const dispatchedAt = new Date();
    const spec = await this.specBuilder.build(jobId, messages);

    const harvestCredentialId =
      (await this.agentCredentialService.getSelected(orgId, EAgentProvider.CLAUDE))?.id ?? null;

    const turnId = randomUUID();
    this.logger.log(`turn ${turnId} (job ${jobId}): spec built, launching engine`);
    await this.transport.writeSpec(turnId, spec);
    await this.sandbox.launchEngineTurn(jobId, turnId);
    const live: LivePointer = { turnId, threadId, startedAt: Date.now() };
    await this.transport.markTurnLive(jobId, live);
    this.logger.log(`turn ${turnId}: engine launched, awaiting events`);

    const pendingConsumption: SentMessage[] = messages.map((row) => ({
      row,
      orderAt: dispatchedAt,
      messagesAtHandoff: 0,
      trigger: true,
    }));

    let messagesOpened = 0;

    const steered = new Set(messages.map((m) => m.id));
    const forwardAbort = new AbortController();
    const forwarding = this.forwardMidTurn(
      jobId,
      turnId,
      steered,
      (row) =>
        pendingConsumption.push({
          row,
          orderAt: null,
          messagesAtHandoff: messagesOpened,
          trigger: false,
        }),
      forwardAbort.signal,
    );

    const flushRead = async (boundaryAt: Date): Promise<void> => {
      const read = pendingConsumption.filter((m) => messagesOpened > m.messagesAtHandoff);
      for (const m of read) pendingConsumption.splice(pendingConsumption.indexOf(m), 1);
      // Triggers carry their own dispatch instant; a steer takes the boundary it was picked up at.
      for (const { row, orderAt } of read) await this.inbound.consume(row, orderAt ?? boundaryAt);
    };

    let sessionId: string | undefined;
    let realError: unknown;
    try {
      for await (const { event, emittedAt } of this.transport.readEvents(turnId)) {
        await this.sandbox.touch(jobId); // real engine activity (incl. heartbeat) → keep the sandbox alive
        await this.transport.markTurnLive(jobId, live); // …and keep the live-turn pointer's TTL fresh
        const type = (event as { type?: string })?.type;
        if (type === 'stream_event') {
          const inner = (event as { event?: { type?: string } }).event?.type;
          if (inner === 'message_start') {
            messagesOpened++;
            await flushRead(new Date(emittedAt));
          }
        }
        if (type === 'rate_limit_event') await this.harvestUsage(orgId, harvestCredentialId, event);
        const sid = (event as { session_id?: string })?.session_id;
        if (sid) sessionId = sid;
        await this.transcript.record({ jobId, threadId, orgId }, event); // persist visible output (assistant)
        if (type === 'result') break;
      }
    } catch (err) {
      if (err instanceof TurnStalledError)
        this.logger.warn(`turn ${turnId}: ${err.message} — ending turn`);
      else realError = err;
    } finally {
      forwardAbort.abort();
      await forwarding.catch(() => {});

      for (const { row, orderAt, trigger } of pendingConsumption.splice(0)) {
        if (trigger) await this.inbound.consume(row, orderAt);
        else
          this.logger.log(
            `turn ${turnId}: steer ${row.id} never reached a tool boundary — left pending for the next turn`,
          );
      }
      await this.transport.clearTurnLive(jobId); // presence off (TTL would clear it anyway if we died first)
      await this.transport.disposeTurn(turnId); // drop the finished turn's Redis streams
    }

    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (realError) throw realError;
    if (sessionId && sessionId !== spec.sessionId) {
      await this.prismaService.thread.update({ where: { id: threadId }, data: { sessionId } });
    }
  }

  private async harvestUsage(
    orgId: string,
    credentialId: string | null,
    event: unknown,
  ): Promise<void> {
    if (!credentialId) return;
    const info = (event as { rate_limit_info?: HarvestInfo })?.rate_limit_info;
    if (!info) return;
    try {
      await this.agentUsageService.applyHarvest(orgId, credentialId, info);
    } catch (err) {
      this.logger.warn(`usage harvest failed for credential ${credentialId}: ${String(err)}`);
    }
  }

  private async forwardMidTurn(
    jobId: string,
    turnId: string,
    steered: Set<string>,
    queueForConsumption: (row: InboundMessageModel) => void,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const fresh = await this.inbound.pendingNowExcluding(jobId, steered);
        for (const m of fresh) {
          steered.add(m.id);
          await this.transport.writeInput(turnId, { text: m.text, priority: 'next' });
          queueForConsumption(m);
          this.logger.log(
            `turn ${turnId}: steered mid-turn message ${m.id} into the live engine (SDK priority next)`,
          );
        }
      } catch (err) {
        // Never let the steering sweep sink the turn — the event loop is the source of truth.
        this.logger.warn(`turn ${turnId}: mid-turn forward sweep failed: ${String(err)}`);
      }
      await new Promise((r) => setTimeout(r, FORWARD_POLL_MS));
    }
  }
}
