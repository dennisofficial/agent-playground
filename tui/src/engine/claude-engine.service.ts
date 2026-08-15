import type {
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { UUID } from "node:crypto";
import {
  BackgroundHold,
  DRAIN_GRACE_MS,
  EHoldVerdict,
  isSessionInUse,
  SHELL_HOLD_CAP_MS,
  SHELL_HOLD_CAP_STEER,
  WAKE_UP_GRACE_MS,
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
import type {
  PromptImage,
  RunArgs,
  RunResult,
  RunningTurn,
  TurnState,
} from "./turn-handle.js";
import { TurnWaker, WAIT_ENDED } from "./turn-waker.js";

// Re-exported rather than moved outright: `app/` codes against these and every importer already
// spells them `from './claude-engine.service.js'`.
export type {
  PromptImage,
  RunArgs,
  RunResult,
  RunningTurn,
} from "./turn-handle.js";

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
    const state: TurnState = { interrupted: false, live: true, holding: false };
    // The one channel by which anything other than a frame ends this turn — see `turn-waker.ts`.
    const waker = new TurnWaker();
    const done = this.drain(handle, input, args, state, waker, outstanding);

    return {
      steer({ id, text }: { id: UUID; text: string }): boolean {
        // Two questions, and both have to be asked. `state.live` is the turn's own answer and flips
        // before the queue is ever closed; the queue's answer is the structural one, so a steer can
        // never be reported as accepted and then dropped in silence — which loses the text AND leaves
        // its chip queued in the UI forever, because only delivery clears it.
        if (!state.live) return false;
        // Recorded as outstanding only once the queue has actually taken it. An id in the set with no
        // message behind it would hold the turn open past `result` waiting on an ack that can never
        // arrive — the drain cap would eventually end it, fifteen seconds late and for no reason.
        if (!input.push(userMessage(text, [], id))) return false;
        outstanding.add(id);
        return true;
      },
      async interrupt(): Promise<void> {
        state.interrupted = true;
        // While the turn is HELD there is nothing generating to interrupt. The CLI answers the
        // cooperative control request with a `result`, the hold re-evaluates it, the work is still
        // live and it holds again — so esc was a no-op on exactly the turns you most want to end.
        // Held, esc ABANDONS: end the wait, and let the ordinary `break` → `finally` → `input.close()`
        // path reap the CLI and its task groups. A forced close of the iterator would make it THROW,
        // painting a red engine-error block over a turn the user deliberately ended.
        if (state.holding) {
          waker.fire();
          return;
        }
        await handle.interrupt().catch(() => {});
      },
      done,
    };
  }

  private async drain(
    handle: Query,
    input: MessageQueue<SDKUserMessage>,
    args: RunArgs,
    state: TurnState,
    waker: TurnWaker,
    outstanding: Set<string>,
  ): Promise<RunResult> {
    const context = createNormaliseContext(args.cwd);
    // Learned from the first frame; also the key the raw tape is filed under.
    let engineSessionId: string | undefined;
    let ok = true;

    // What this turn spawned that outlives it, and therefore whether `result` really ends the turn.
    const hold = new BackgroundHold();
    let capTimer: NodeJS.Timeout | undefined;
    const setHolding = (next: boolean): void => {
      if (state.holding === next) return;
      state.holding = next;
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

    // Pulled by hand rather than with `for await`, because only an explicit `.next()` can be raced
    // against the waker. `pending` is carried across iterations so a raced-and-lost frame is still the
    // next one read, and never dropped.
    const frames = handle[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<SDKMessage>> | undefined;

    try {
      while (true) {
        // Asked to end while a frame was already in hand — an abandon that arrived in the same tick as
        // one, say. The race below is the fast path; this is the one that cannot be missed.
        if (waker.spent) break;
        pending ??= frames.next();
        const wait = waker.pending;
        const next = wait ? await Promise.race([pending, wait]) : await pending;
        if (next === WAIT_ENDED) {
          // Let go of the frame we will never read — unowned, it would surface a late rejection as an
          // unhandled one.
          pending.catch(() => undefined);
          break;
        }
        pending = undefined;
        if (next.done) break;
        const message = next.value;
        // Read BEFORE the frame is folded in, because the drain backstop below is about a TRANSITION:
        // the moment a held turn's last piece of work settles is the only moment the loop can see that
        // the hold has run out of reasons.
        const heldWithWorkLive = state.holding && !hold.idle;
        // Tape EVERYTHING, before normalisation can lose anything.
        engineSessionId ??= (message as { session_id?: string }).session_id;
        if (engineSessionId)
          this.rawTapeService.append(engineSessionId, message);

        // WHOSE frame is this? A delegate's own output — its tool calls, its prose — arrives on this
        // same stream tagged with the tool call that spawned it, and it is not the model coming back.
        // Read here because this is the last place the tag exists: `text` and `thinking` reach
        // `domain/` with no parent id, so nothing downstream can tell them from the thread's own words.
        const delegateFrame =
          (message as { parent_tool_use_id?: string | null })
            .parent_tool_use_id != null;

        // Whether THIS message's result claimed to be a bare wake-up, and whether the frame was the
        // SESSION being used at all. Both reset per frame: the questions are about the frame in hand.
        let wakeUpOnly = false;
        // Frames that normalise to nothing at all — `system/status`, a `stream_event` bookend — leave
        // this false and so extend a hold rather than ending one. That is the safe direction (a real
        // delta follows within milliseconds) but it is a consequence of emitting no events, not a
        // decision taken about them.
        let sessionInUse = false;
        for (const event of this.claudeNormaliserService.normalise(
          message,
          context,
        )) {
          if (event.kind === "session") engineSessionId = event.engineSessionId;
          if (event.kind === "result") {
            ok = event.ok;
            wakeUpOnly = event.nonTerminal === true;
          }
          // The model has it. Only ids Atlas stamped are in the set, so the prompt's own replay and
          // the CLI's synthetic ones fall straight through.
          if (event.kind === "input_ack") outstanding.delete(event.id);
          if (isSessionInUse({ event, delegateFrame })) sessionInUse = true;
          hold.observe(event);
          args.onEvent(event);
        }

        if (message.type !== "result") {
          // Any frame at all disarms the steer-drain backstop: whatever it is, it is the CLI getting
          // on with the turn, which is the thing the cap existed to wait for. Deliberately ahead of
          // the hold questions below — those are about the MODEL, and this is about the transport.
          clearDrain();
          // The session is in use again — the model is writing, or reading a tool back. The hold lifts
          // here and nowhere else, because it is waiting on the MODEL and this is the model.
          if (sessionInUse) {
            clearCap();
            waker.clear();
            setHolding(false);
            continue;
          }

          // Everything else is the SDK's bookkeeping about work that is already running, and it is not
          // a sign of life from the model at all. Treating it as one was a real bug in both directions:
          // a subagent reporting progress every few seconds cleared `holding` long before it settled,
          // which shimmered the working line over a parked session AND left the backstop below with no
          // state saying a hold was on, so it could never arm — in the commonest shape there is.
          const parked = state.holding || waker.pending !== undefined;
          if (!parked) continue;

          if (hold.idle) {
            // The last thing this hold was waiting for has settled. The verdict is only ever re-read
            // at a `result`, and an uncapped hold arms no timer — so if the model does not wake (a
            // settlement it does not act on, a notification it never reads) nothing will look at this
            // lane again and it holds forever. Narrow tail, total failure. This is its floor.
            if (heldWithWorkLive) {
              clearCap();
              waker.arm(DRAIN_GRACE_MS);
            }
            continue;
          }

          // Work is live and the turn is parked on it: that is a hold, whichever door it came in by —
          // including a bare wake-up's grace, which must not still be counting down under real work.
          setHolding(true);
          waker.open();
          continue;
        }

        // A steer that missed this turn's last boundary is not lost — the CLI drains it as a
        // follow-on turn on the SAME query, fresh `init` and all, and acks it there. Ending here
        // would kill that turn in its first second and throw away words the human has already been
        // shown as queued. So the turn is not over while one is outstanding: keep reading.
        //
        // Deliberately before the background-hold verdict. Both say "this result does not end the
        // turn", and the next `result` asks the hold again anyway.
        //
        // Unless the turn is already OVER by someone's decision rather than the model's. Esc, a
        // `rotate` and a context wall all mean the follow-on turn this wait exists to protect is
        // never going to run — the CLI has been asked to stop, or the session it would run on is
        // finished — so waiting fifteen seconds for an ack that cannot come just leaves the lane
        // busy and the composer routing keystrokes into a dead session. The words are not lost by
        // ending here: an unacked steer is still queued in the UI, which is where it stays.
        const overAlready = state.interrupted || args.mayHold?.() === false;
        if (outstanding.size > 0 && !overAlready) {
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

        // Anything that has already decided this session is over bars the hold outright, whatever is
        // still live: work held on a finished session is holding nothing worth having, and the lane
        // stays busy while it does. Asked here rather than tracked as state, because the two things
        // that turn it — a `rotate` tool call, a context wall — both arrive mid-stream with no hold
        // yet in existence to close. See `stopHolding` in `turn-runner.service.ts`.
        const verdict =
          args.mayHold?.() === false
            ? EHoldVerdict.end
            : hold.verdict({ nonTerminal: wakeUpOnly });
        if (verdict === EHoldVerdict.end) break;

        // A wake-up that did no work is not the session being USED, so it does not light the working
        // line's held state — it just is not the end of the turn yet.
        // Re-armed rather than left running, so the window is "no further sign of life" and not
        // "since the first wake-up".
        if (verdict === EHoldVerdict.holdBriefly) {
          waker.arm(WAKE_UP_GRACE_MS);
          continue;
        }

        // Real work is live now, which is a better reason to stay open than a grace ever was — and
        // `open()` clears that grace, for the same reason `clearCap` is above: a deadline must not
        // outlive what armed it. A hold has no clock of its own, but the loop must still be racing
        // SOMETHING, because that is the only thing an abandon can resolve. See `turn-waker.ts`.
        setHolding(true);
        waker.open();
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
      waker.clear();
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
