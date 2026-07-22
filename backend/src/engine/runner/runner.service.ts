import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ATLAS_STATE_MOUNT } from '@shared/engine/paths.constants';
import type { TurnSpec } from '@shared/engine/turn-spec';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineTransportService } from '../engine-transport/engine-transport.service';
import { MessageQueue } from './message-queue';

const CLAUDE_CONFIG_DIR = join(ATLAS_STATE_MOUNT, 'claude');
const CODEX_CONFIG_DIR = join(ATLAS_STATE_MOUNT, 'codex');

@Injectable()
export class RunnerService {
  private readonly logger = new Logger(RunnerService.name);
  private input?: MessageQueue<SDKUserMessage>;
  private handle?: Query;

  constructor(private readonly transport: EngineTransportService) {}

  async run(turnId: string, spec: TurnSpec): Promise<void> {
    this.input = new MessageQueue<SDKUserMessage>();
    this.input.push(this.userMessage(spec.prompt));
    this.logger.log(`turn ${turnId}: starting Claude SDK query (model=${spec.model ?? 'default'})`);
    this.handle = query({
      prompt: this.input,
      options: this.buildClaudeOptions(spec),
    });

    let events = 0;
    try {
      for await (const msg of this.handle) {
        events++;
        // First event confirms the SDK subprocess actually spawned — the usual silent-hang boundary.
        if (events === 1) this.logger.log(`turn ${turnId}: SDK stream open, first event received`);
        await this.transport.emitEvent(turnId, msg);
        if (msg.type === 'result') break;
      }
      this.logger.log(`turn ${turnId}: SDK query loop ended after ${events} event(s)`);
    } finally {
      this.input?.close();
      this.input = undefined;
      this.handle = undefined;
    }
  }

  async interrupt(): Promise<void> {
    await this.handle?.interrupt();
  }

  enqueue(text: string): void {
    this.input?.push(this.userMessage(text));
  }

  private userMessage(text: string): SDKUserMessage {
    return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
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
