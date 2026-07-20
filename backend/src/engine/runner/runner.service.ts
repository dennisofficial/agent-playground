import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Injectable } from '@nestjs/common';
import { EngineTransportService } from '../engine-transport/engine-transport.service';
import { MessageQueue } from './message-queue';
import type { TurnSpec } from '@shared/engine/turn-spec';

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
      options: this.buildClaudeOptions(spec)
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
    return {
      systemPrompt: spec.systemPrompt,
      cwd: spec.cwd,
      model: spec.model,
      resume: spec.sessionId,
    };
  }
}
