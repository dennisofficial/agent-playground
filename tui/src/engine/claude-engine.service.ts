import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { EngineEvent } from "../domain/message.js";
import type { EngineTool } from "./atlas-tool-server.js";
import {
  BackgroundHold,
  EHoldVerdict,
  SHELL_HOLD_CAP_MS,
  SHELL_HOLD_CAP_STEER,
} from "./background-hold.js";
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

/**
 * A picture on its way to the model, already read off disk.
 *
 * The engine is handed bytes rather than a path on purpose: reading a file is the app layer's job,
 * and an engine that opened one would be a second place that has to know where Atlas keeps things.
 */
export type PromptImage = {
  mediaType: string;
  /** base64, as `ImageBlockParam` wants it. */
  data: string;
};

export type RunArgs = {
  prompt: string;
  /**
   * Images the prompt refers to. Their `[Image #N]` tokens are already in the text, so the model
   * reads the sentence and sees the picture in the same turn.
   */
  images?: readonly PromptImage[] | undefined;
  cwd: string;
  model: string;
  /** The SDK's own session id. Resuming continues the same conversation. */
  resume?: string | undefined;
  systemPrompt?: string | undefined;
  /** Credential injection — the env bag from EngineHomeService. */
  env: Record<string, string>;
  /**
   * Ask for fast mode on this turn. A property of the ACCOUNT paying for it, resolved by the app
   * layer — the engine only forwards it, and the server is still free to refuse (it reports what it
   * did on the result frame, which `normalise` turns into a `fast_mode` event).
   */
  fastMode?: boolean | undefined;
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
  /**
   * The model has stopped but the turn has not, because a backgrounded delegate is still running and
   * the session must stay open to hear it settle. Called with `true` when the hold begins and `false`
   * when it lifts — so the working line can say what is actually happening instead of shimmering over
   * an idle session. See `background-hold.ts`.
   */
  onHold?: ((holding: boolean) => void) | undefined;
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
    input.push(userMessage(args.prompt, args.images));

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

    // What this turn spawned that outlives it, and therefore whether `result` really ends the turn.
    const hold = new BackgroundHold();
    let capTimer: NodeJS.Timeout | undefined;
    let holding = false;
    const setHolding = (next: boolean): void => {
      if (holding === next) return;
      holding = next;
      args.onHold?.(next);
    };
    const clearCap = (): void => {
      if (!capTimer) return;
      clearTimeout(capTimer);
      capTimer = undefined;
    };

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
          hold.observe(event);
          args.onEvent(event);
        }

        // A settling delegate wakes the model, so the hold lifts the moment anything else arrives —
        // the session is being used again, not waited on.
        if (message.type !== "result") {
          clearCap();
          setHolding(false);
          continue;
        }

        const verdict = hold.verdict();
        if (verdict === EHoldVerdict.end) break;

        setHolding(true);
        // A subagent is held with no deadline; a bare background shell gets one, and it is a MESSAGE
        // rather than a kill — see `background-hold.ts` for why the two differ.
        if (verdict === EHoldVerdict.holdCapped && !capTimer) {
          capTimer = setTimeout(() => {
            capTimer = undefined;
            hold.markCapped();
            input.push(userMessage(SHELL_HOLD_CAP_STEER));
          }, SHELL_HOLD_CAP_MS);
          // Nothing else in this process is waiting on this timer, and a held session must not be the
          // reason the process cannot exit.
          capTimer.unref?.();
        }
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
      clearCap();
      setHolding(false);
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

/**
 * A bare string while there are no pictures, and content BLOCKS the moment there are.
 *
 * Both are `MessageParam.content`, and the string form is kept for the overwhelmingly common case
 * because it is what every existing tape, fixture and normaliser test already contains — switching
 * unconditionally to a one-element block array would rewrite the wire format of every turn Atlas has
 * ever sent to buy nothing.
 *
 * Steers stay text-only: a steer is words pushed into a turn already in flight, and there is no
 * gesture for pasting a picture into one.
 */
function userMessage(
  text: string,
  images: readonly PromptImage[] = [],
): SDKUserMessage {
  const content =
    images.length === 0
      ? text
      : [
          { type: "text" as const, text },
          ...images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mediaType,
              data: image.data,
            },
          })),
        ];

  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}
