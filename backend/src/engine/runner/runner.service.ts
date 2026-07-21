import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Injectable } from '@nestjs/common';
import { ATLAS_STATE_MOUNT } from '@shared/engine/paths.constants';
import type { TurnSpec } from '@shared/engine/turn-spec';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineTransportService } from '../engine-transport/engine-transport.service';
import { MessageQueue } from './message-queue';

// Durable, out-of-worktree engine config home (credentials, session transcripts, future skills) on the pod's
// durable state mount — survives reaps, so a resumed turn finds its transcript. Never a per-turn temp dir.
const CLAUDE_CONFIG_DIR = join(ATLAS_STATE_MOUNT, 'claude');

@Injectable()
export class RunnerService {
  private input?: MessageQueue<SDKUserMessage>;
  private handle?: Query;

  constructor(private readonly transport: EngineTransportService) {}

  async run(turnId: string, spec: TurnSpec): Promise<void> {
    this.input = new MessageQueue<SDKUserMessage>();
    this.input.push(this.userMessage(spec.prompt));
    this.handle = query({
      prompt: this.input,
      options: this.buildClaudeOptions(spec),
    });

    try {
      for await (const msg of this.handle) {
        await this.transport.emitEvent(turnId, msg);
        if (msg.type === 'result') break;
      }
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
