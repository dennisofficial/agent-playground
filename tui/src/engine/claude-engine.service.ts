import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { EngineEvent } from "../domain/message.js";
import type { EngineTool } from "./atlas-tool-server.js";
import { claudeOptions } from "./claude-options.js";
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
  /**
   * Atlas's own tools for this turn, already gated. The engine renders what it is handed and never
   * decides what is in the list — visibility is one function in `app/tools/`, and a transport that
   * second-guessed it would be a second place to get gating wrong.
   */
  tools?: readonly EngineTool[] | undefined;
  onEvent: (event: EngineEvent) => void;
  /**
   * Called after every tool call, and whatever it returns is handed to the model as extra context on
   * that tool's result. It is how Atlas speaks into a turn WITHOUT interrupting a thought: the agent
   * is already waiting on the tool, so a message arriving there costs it nothing.
   *
   * The engine neither knows nor decides what goes in it — returning `undefined` (the common case)
   * adds nothing to the frame at all.
   */
  onToolBoundary?: (() => Promise<string | undefined>) | undefined;
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
      options: claudeOptions(args),
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
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}
