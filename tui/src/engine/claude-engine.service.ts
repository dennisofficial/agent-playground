import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { UUID } from "node:crypto";
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
  /**
   * Push into the LIVE session. False once the turn has finished and closed its queue.
   *
   * The `id` is stamped onto the message as its SDK uuid and comes back verbatim on the replay frame
   * the CLI emits when the MODEL takes it — an `input_ack` event carrying the same id. That round
   * trip is the entire point of taking an id here: without it the caller would have to match on text,
   * and two identical steers are not a hypothetical.
   */
  steer(args: { id: UUID; text: string }): boolean;
  interrupt(): Promise<void>;
  /** Resolves when every frame has been drained. Never rejects — a crash becomes `ok: false`. */
  readonly done: Promise<RunResult>;
};

/**
 * How long the turn stays open, after the model has stopped, for the CLI to take up a steer that
 * arrived too late for this turn's last boundary.
 *
 * The CLI drains one of its own accord as a follow-on turn on the same query — MEASURED at ~2s from
 * `result` to the fresh `init`. This is the backstop for a CLI that does not, and it is deliberately
 * short: nothing is running, so the only thing being spent is the human's patience.
 */
const STEER_DRAIN_CAP_MS = 15_000;

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
    // The opening prompt is stamped with no id, so its replay — the CLI echoes THAT back too — is an
    // ack nobody is holding and falls through the match upstairs. It is already in the transcript:
    // Atlas writes the prompt when the turn starts, because a human's own words appearing only once
    // the model got round to them would be a worse lie than the one this whole change is fixing.
    input.push(userMessage(args.prompt, args.images));
    // Steers pushed into the session that the model has not confirmed reading yet. See `drain`: a
    // non-empty set is what keeps the turn open past `result`.
    const outstanding = new Set<string>();

    const handle = this.sdk.query({
      prompt: input,
      options: claudeOptions(args),
    });
    const state = { interrupted: false, live: true };
    const done = this.drain(handle, input, args, state, outstanding);

    return {
      steer({ id, text }: { id: UUID; text: string }): boolean {
        if (!state.live) return false;
        outstanding.add(id);
        input.push(userMessage(text, [], id));
        return true;
      },
      async interrupt(): Promise<void> {
        state.interrupted = true;
        await handle.interrupt().catch(() => {});
      },
      done,
    };
  }

  private async drain(
    handle: Query,
    input: MessageQueue<SDKUserMessage>,
    args: RunArgs,
    state: { interrupted: boolean; live: boolean },
    outstanding: Set<string>,
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

    // Armed when `result` lands with a steer the model has not taken yet, and disarmed by the next
    // frame — which is the CLI getting on with it. Closing the input is how the wait is abandoned:
    // the loop is parked on the output stream, so nothing here can break it, but stdin ending makes
    // the CLI exit and the iterator finish. See `STEER_DRAIN_CAP_MS`.
    let drainTimer: NodeJS.Timeout | undefined;
    const clearDrain = (): void => {
      if (!drainTimer) return;
      clearTimeout(drainTimer);
      drainTimer = undefined;
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
          // The model has it. Only ids Atlas stamped are in the set, so the prompt's own replay and
          // the CLI's synthetic ones fall straight through.
          if (event.kind === "input_ack") outstanding.delete(event.id);
          hold.observe(event);
          args.onEvent(event);
        }

        // A settling delegate wakes the model, so the hold lifts the moment anything else arrives —
        // the session is being used again, not waited on.
        if (message.type !== "result") {
          clearCap();
          clearDrain();
          setHolding(false);
          continue;
        }

        // A steer that missed this turn's last boundary is not lost — the CLI drains it as a
        // follow-on turn on the SAME query, fresh `init` and all, and acks it there. Ending here
        // would kill that turn in its first second and throw away words the human has already been
        // shown as queued. So the turn is not over while one is outstanding: keep reading.
        //
        // Deliberately before the background-hold verdict. Both say "this result does not end the
        // turn", and the next `result` asks the hold again anyway.
        if (outstanding.size > 0) {
          if (!drainTimer) {
            drainTimer = setTimeout(() => {
              drainTimer = undefined;
              this.logger.warn(
                `steer not taken within ${STEER_DRAIN_CAP_MS}ms; ending the turn`,
              );
              input.close();
            }, STEER_DRAIN_CAP_MS);
            drainTimer.unref?.();
          }
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
        // No "r to restart" any more: `retryable` is what offers the way back, and the block draws
        // it as a button — see `ErrorBlock`. A detail line advertising a keypress the composer eats
        // was telling the user to do something that has never worked.
        detail: `${detail} · Thread preserved`,
        retryable: true,
      });
      ok = false;
    } finally {
      clearCap();
      clearDrain();
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
 *
 * `id` becomes the message's SDK uuid, which the CLI hands back on the replay frame when the model
 * takes it — MEASURED to round-trip unchanged, including for a steer the CLI deferred to a follow-on
 * turn. Omitted for anything Atlas is not waiting on: the opening prompt and the engine's own
 * background-hold nudge, whose replays are then indistinguishable from noise, which is what they are.
 */
function userMessage(
  text: string,
  images: readonly PromptImage[] = [],
  id?: UUID,
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
    ...(id === undefined ? {} : { uuid: id }),
  } as SDKUserMessage;
}
