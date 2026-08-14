import type { EngineEvent } from "../domain/message.js";
import type { EngineTool } from "./atlas-tool-server.js";

/**
 * What a running turn looks like from outside the engine: what it is started with, what it hands
 * back, and what can be done to it while it runs.
 *
 * Beside the service rather than in it because this is the seam `app/` codes against — every caller
 * spells it `from './claude-engine.service.js'` and still can, since that module re-exports the whole
 * of this one. Nothing here is Claude-shaped; when a second engine lands it implements these.
 */

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
  /**
   * The model has stopped but the turn has not, because a backgrounded delegate is still running and
   * the session must stay open to hear it settle. Called with `true` when the hold begins and `false`
   * when it lifts — so the working line can say what is actually happening instead of shimmering over
   * an idle session. See `background-hold.ts`.
   */
  onHold?: ((holding: boolean) => void) | undefined;
  /**
   * May this turn still hold past a `result`? Asked at every result and never cached.
   *
   * Something outside the engine can decide the SESSION is finished long before the model stops
   * talking — a `rotate` hand-over, a context wall — and a turn held open on a session that is
   * already over is holding nothing worth having. Both of those fire mid-stream, while there is no
   * hold in existence to end, so this is asked rather than pushed. Absent, a turn may always hold.
   */
  mayHold?: (() => boolean) | undefined;
};

export type RunResult = {
  ok: boolean;
  engineSessionId?: string;
  interrupted: boolean;
};

/**
 * What the handle and the drain loop both need to see. Shared by reference on purpose: `interrupt()`
 * has to know what the turn is doing RIGHT NOW, and the alternative — the UI telling the engine which
 * stage it thinks it is in — is a decision made from a snapshot that is one frame out of date.
 */
export type TurnState = {
  interrupted: boolean;
  /** The query is open and a steer can still reach it. Flipped before the input is ever closed. */
  live: boolean;
  /** The model has stopped but the turn has not — see `background-hold.ts`. */
  holding: boolean;
};

export type RunningTurn = {
  /** Push into the LIVE session. False once the turn has finished and closed its queue. */
  steer(text: string, onConsumed?: () => void): boolean;
  /**
   * Esc. Two stages, chosen by what the turn is doing: stop the model, or abandon a hold.
   * Resolves when the request has been made, NOT when the turn is over — `done` is that.
   */
  interrupt(): Promise<void>;
  /** Queued but not yet pulled into the session. */
  readonly pendingSteers: number;
  /** Resolves when every frame has been drained. Never rejects — a crash becomes `ok: false`. */
  readonly done: Promise<RunResult>;
};
