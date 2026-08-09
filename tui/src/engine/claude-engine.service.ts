import type {
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { EngineEvent } from "../domain/message.js";
import {
  CLAUDE_AGENT_SDK,
  type ClaudeAgentSdk,
} from "./claude-sdk.provider.js";
import { MessageQueue } from "./message-queue.js";
import {
  ClaudeNormaliserService,
  createNormaliseContext,
} from "./normalise/claude-normaliser.service.js";
import { RawTapeService } from "./raw-tape.service.js";

export type RunArgs = {
  prompt: string;
  cwd: string;
  model: string;
  /** The SDK's own session id. Resuming continues the same conversation. */
  resume?: string | undefined;
  systemPrompt?: string | undefined;
  /** Credential injection — the env bag from EngineHomeService. */
  env: Record<string, string>;
  onEvent: (event: EngineEvent) => void;
};

export type RunResult = {
  ok: boolean;
  engineSessionId?: string;
  interrupted: boolean;
};

export type RunningTurn = {
  /** Push into the LIVE session. False once the turn has finished and closed its queue. */
  steer(text: string, onConsumed?: () => void): boolean;
  interrupt(): Promise<void>;
  /** Queued but not yet pulled into the session. */
  readonly pendingSteers: number;
  /** Resolves when every frame has been drained. Never rejects — a crash becomes `ok: false`. */
  readonly done: Promise<RunResult>;
};

@Injectable()
export class ClaudeEngineService {
  private readonly logger = new Logger(ClaudeEngineService.name);

  constructor(
    @Inject(CLAUDE_AGENT_SDK) private readonly sdk: ClaudeAgentSdk,
    private readonly claudeNormaliserService: ClaudeNormaliserService,
    private readonly rawTapeService: RawTapeService,
  ) {}

  start(args: RunArgs): RunningTurn {
    const input = new MessageQueue<SDKUserMessage>();
    input.push(userMessage(args.prompt));

    const handle = this.sdk.query({
      prompt: input,
      options: this.options(args),
    });
    const state = { interrupted: false, live: true };
    const done = this.drain(handle, input, args, state);

    return {
      steer(text: string, onConsumed?: () => void): boolean {
        if (!state.live) return false;
        input.push(userMessage(text), onConsumed);
        return true;
      },
      async interrupt(): Promise<void> {
        state.interrupted = true;
        await handle.interrupt().catch(() => {});
      },
      get pendingSteers(): number {
        return input.pending;
      },
      done,
    };
  }

  private async drain(
    handle: Query,
    input: MessageQueue<SDKUserMessage>,
    args: RunArgs,
    state: { interrupted: boolean; live: boolean },
  ): Promise<RunResult> {
    const context = createNormaliseContext(args.cwd);
    // Learned from the first frame; also the key the raw tape is filed under.
    let engineSessionId: string | undefined;
    let ok = true;

    try {
      for await (const message of handle) {
        // Tape EVERYTHING, before normalisation can lose anything.
        engineSessionId ??= (message as { session_id?: string }).session_id;
        if (engineSessionId)
          this.rawTapeService.append(engineSessionId, message);

        for (const event of this.claudeNormaliserService.normalise(
          message,
          context,
        )) {
          if (event.kind === "session") engineSessionId = event.engineSessionId;
          if (event.kind === "result") ok = event.ok;
          args.onEvent(event);
        }
        if (message.type === "result") break;
      }
    } catch (error) {
      // An engine crash is a transcript entry, not a toast — it has to survive scrollback.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`claude sdk failed: ${detail}`);
      args.onEvent({
        kind: "error",
        title: "Engine error: claude agent sdk exited",
        detail: `${detail} · Thread preserved · r to restart`,
        retryable: true,
      });
      ok = false;
    } finally {
      state.live = false;
      input.close();
    }

    return {
      ok,
      ...(engineSessionId === undefined ? {} : { engineSessionId }),
      interrupted: state.interrupted,
    };
  }

  private options(args: RunArgs): Options {
    return {
      ...(args.systemPrompt === undefined
        ? {}
        : { systemPrompt: args.systemPrompt }),
      cwd: args.cwd,
      model: args.model,
      ...(args.resume === undefined ? {} : { resume: args.resume }),
      // The live tail exists because of this flag — without it there are no deltas to render.
      includePartialMessages: true,
      thinking: { type: "adaptive", display: "summarized" },
      // Atlas allows everything. No approval card, no permission mode, no `waiting` run state.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env: { ...process.env, ...args.env },
    };
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}
