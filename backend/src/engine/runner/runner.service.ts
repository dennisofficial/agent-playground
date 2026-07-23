import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ANTHROPIC_AGENT_SDK } from '@lib/esm/esm.module';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ATLAS_STATE_MOUNT } from '@shared/engine/paths.constants';
import type { TurnSpec } from '@shared/engine/turn-spec';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineTransportService } from '../engine-transport/engine-transport.service';
import { MessageQueue } from './message-queue';

const CLAUDE_CONFIG_DIR = join(ATLAS_STATE_MOUNT, 'claude');
const CODEX_CONFIG_DIR = join(ATLAS_STATE_MOUNT, 'codex');

const HEARTBEAT_MS = 20_000;

@Injectable()
export class RunnerService {
  private readonly logger = new Logger(RunnerService.name);
  private input?: MessageQueue<SDKUserMessage>;
  private handle?: Query;

  constructor(
    private readonly transport: EngineTransportService,
    @Inject(ANTHROPIC_AGENT_SDK)
    private readonly sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  ) {}

  async run(turnId: string, spec: TurnSpec): Promise<void> {
    this.input = new MessageQueue<SDKUserMessage>();
    this.input.push(this.userMessage(spec.prompt));
    this.logger.log(`starting Claude SDK query (model=${spec.model ?? 'default'})`);
    this.handle = this.sdk.query({
      prompt: this.input,
      options: this.buildClaudeOptions(spec),
    });

    // Pump mid-turn steering messages into the live query. Runs concurrently with the SDK loop; aborted at turn end.
    const steering = new AbortController();
    const pump = this.pumpInput(turnId, steering.signal);
    const heartbeat = setInterval(() => {
      void this.transport.emitEvent(turnId, { type: 'heartbeat' }).catch(() => {});
    }, HEARTBEAT_MS);

    let events = 0;
    try {
      for await (const msg of this.handle) {
        events++;
        // First event confirms the SDK subprocess actually spawned — the usual silent-hang boundary.
        if (events === 1) this.logger.log(`SDK stream open, first event received`);
        await this.transport.emitEvent(turnId, msg);
        if (msg.type === 'result') break;
      }
      this.logger.log(`SDK query loop ended after ${events} event(s)`);
    } finally {
      clearInterval(heartbeat);
      steering.abort();
      await pump; // let the input reader tear its connection down before we close the queue
      this.input?.close();
      this.input = undefined;
      this.handle = undefined;
    }
  }

  /** Forward host-sent steering messages into the live SDK queue until the turn ends (signal aborts). */
  private async pumpInput(turnId: string, signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of this.transport.readInput(turnId, signal)) {
        this.logger.log(
          `steering message received mid-turn (priority=${frame.priority ?? 'default'})`,
        );
        this.enqueue(frame.text, frame.priority);
      }
    } catch (err) {
      // Never let a steering-channel failure sink the turn — the SDK loop is the source of truth.
      this.logger.warn(`input pump stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async interrupt(): Promise<void> {
    await this.handle?.interrupt();
  }

  enqueue(text: string, priority?: SDKUserMessage['priority']): void {
    this.input?.push(this.userMessage(text, priority));
  }

  private userMessage(text: string, priority?: SDKUserMessage['priority']): SDKUserMessage {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
    };
  }

  private buildClaudeOptions(spec: TurnSpec): Options {
    mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
    if (spec.credentialsFile) {
      writeFileSync(join(CLAUDE_CONFIG_DIR, '.credentials.json'), spec.credentialsFile, {
        mode: 0o600,
      });
    }
    return {
      systemPrompt: spec.systemPrompt,
      cwd: spec.cwd,
      model: spec.model,
      resume: spec.sessionId,
      includePartialMessages: true,
      env: { ...process.env, CLAUDE_CONFIG_DIR, ...RunnerService.applyEnv(spec.env) },
    };
  }

  /** Host env bag → SDK env overrides: a `null` value unsets the key (spread after `process.env`). */
  private static applyEnv(env?: Record<string, string | null>): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env ?? {})) out[key] = value ?? undefined;
    return out;
  }
}
