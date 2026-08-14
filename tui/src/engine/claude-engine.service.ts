import type {
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Inject, Injectable, Logger } from "@nestjs/common";
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
  RunArgs,
  RunResult,
  RunningTurn,
  TurnState,
} from "./turn-handle.js";
import { TurnWaker, WAIT_ENDED } from "./turn-waker.js";

// Re-exported rather than moved outright: `app/` codes against these and every importer already
// spells them `from './claude-engine.service.js'`.
export type {
  RunArgs,
  RunResult,
  RunningTurn,
} from "./turn-handle.js";

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
    const state: TurnState = { interrupted: false, live: true, holding: false };
    // The one channel by which anything other than a frame ends this turn — see `turn-waker.ts`.
    const waker = new TurnWaker();
    const done = this.drain(handle, input, args, state, waker);

    return {
      steer(text: string, onConsumed?: () => void): boolean {
        // Two questions, and both have to be asked. `state.live` is the turn's own answer and flips
        // before the queue is ever closed; the queue's answer is the structural one, so a steer can
        // never be reported as accepted and then dropped in silence — which loses the text AND leaves
        // its chip queued in the UI forever, because only delivery clears it.
        if (!state.live) return false;
        return input.push(userMessage(text), onConsumed);
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
    state: TurnState,
    waker: TurnWaker,
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
          if (isSessionInUse({ event, delegateFrame })) sessionInUse = true;
          hold.observe(event);
          args.onEvent(event);
        }

        if (message.type !== "result") {
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
        detail: `${detail} · Thread preserved · r to restart`,
        retryable: true,
      });
      ok = false;
    } finally {
      clearCap();
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

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}
