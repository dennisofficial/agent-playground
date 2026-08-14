import type { AccountVaultService } from "../auth/account-vault.service.js";
import type { EngineHomeService } from "../auth/engine-home.service.js";
import { promptPayload, renderPrompt } from "../domain/message.js";
import { isContextWall } from "../domain/rotation-handoff.js";
import { buildSystemPrompt } from "../domain/system-prompt.js";
import type { ClaudeEngineService } from "../engine/claude-engine.service.js";
import type { RunningTurn } from "../engine/turn-handle.js";
import type { ContextPressureService } from "./context-pressure.service.js";
import type { ConversationStore } from "./conversation.store.js";
import type { RunningSession } from "./session-rotation.js";
import type { RunTurnArgs } from "./turn-args.js";
import type { TurnEventApplier } from "./turn-events.js";
import type { Lane } from "./turn-lanes.js";
import { nudgeAtToolBoundary } from "./turn-nudge.js";

/**
 * Everything a turn does on its way IN: persist what was said, resolve the credential, open the
 * query and wire the four callbacks the engine reaches back through.
 *
 * The mirror of `turn-completion.ts`, split out for the same two reasons. It is a fixed sequence with
 * no branching left in it — every decision about which session, which account and whether the turn
 * runs at all is settled before it is called — and it is the half of `execute()` that has to know
 * what an engine callback means, which is a different subject from what a lane is.
 *
 * A plain function rather than a provider: it owns no state and has exactly one caller.
 */
export async function startEngineTurn(args: {
  /** The turn as its caller composed it. Its `prompt`, `brief`, `tools` and `cwd` are used verbatim. */
  turn: RunTurnArgs;
  /** The session the turn actually RUNS on — rotation may have moved it since the caller looked. */
  session: RunningSession;
  lane: Lane;
  store: ConversationStore;
  events: TurnEventApplier;
  claudeEngineService: ClaudeEngineService;
  accountVaultService: AccountVaultService;
  engineHomeService: EngineHomeService;
  contextPressureService: ContextPressureService;
  /** Queue a database write behind this lane's chain — `TurnRunnerService.record`. */
  record: (work: () => Promise<void>) => void;
  /**
   * The transcript itself no longer fits. Collected as it streams because the engine reports it as an
   * ordinary error event, and acted on by the caller's `finally`.
   */
  onWall: () => void;
}): Promise<RunningTurn> {
  const { turn, session, lane, store, events } = args;
  const { thread } = turn;

  // The payload is written first and rendered second, so the transcript records WHO spoke and the
  // model receives the envelope that says the same thing. One source, two directions.
  const payload = promptPayload({
    text: turn.prompt,
    harnessVariant: turn.harnessVariant,
    attachments: turn.attachments,
  });
  await events.persist({
    store,
    threadId: thread.id,
    sessionId: session.id,
    payload,
  });

  const blob = await args.accountVaultService.freshCredential(session.accountId);

  // Credential write and spawn happen inside one critical section — see EngineHomeService. The
  // account id travels with the blob so the read-back in `finaliseTurn` knows whose file it is.
  return args.engineHomeService.claim(
    { accountId: session.accountId, blob },
    (env) =>
      args.claudeEngineService.start({
        prompt: renderPrompt(payload),
        systemPrompt: buildSystemPrompt({ brief: turn.brief }),
        cwd: turn.cwd,
        model: session.model,
        resume: session.engineSessionId ?? undefined,
        env,
        tools: turn.tools,
        // Atlas's one way into a running turn that costs the agent nothing: it is already waiting on
        // the tool. Whether anything is said at all is entirely `turn-nudge.ts`'s decision.
        onToolBoundary: () =>
          nudgeAtToolBoundary({
            contextPressureService: args.contextPressureService,
            events,
            store,
            thread,
            session,
            lane,
            record: args.record,
          }),
        // Straight to the store, not through the write chain: nothing is persisted and the working
        // line is the only reader. Queuing it behind the turn's database writes would land the state
        // change after the frames that made it true.
        onHold: (value) => store.setHolding(value),
        // Read off the lane at every `result`, so a `rotate` or a wall arriving mid-stream bars the
        // hold from a place that does not need a handle to exist yet. See `turn-lanes.ts`.
        mayHold: () => !lane.noHold,
        onEvent: (event) => {
          if (event.kind === "error" && isContextWall(event)) args.onWall();
          args.record(() =>
            events.apply({
              event,
              store,
              lane,
              threadId: thread.id,
              session,
            }),
          );
        },
      }),
  );
}
