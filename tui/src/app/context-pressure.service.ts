import { Injectable } from '@nestjs/common';
import { canaryHealth, ECanaryHealth } from '../domain/canary.js';
import {
  audienceFor,
  contextBand,
  decideNudge,
  EContextBand,
  ENudgeAudience,
  EContextSignal,
  nudgeNotice,
  nudgeReason,
  pressureBand,
  type ContextReading,
  type NudgeLedger,
} from '../domain/context-nudge.js';
import { handoffAdvisory, rotationRequest } from '../domain/rotation-handoff.js';
import { budgetFor, windowPercent, type Budget } from '../domain/usage.js';
import type { EngineSession } from '../generated/prisma/client.js';
import type { EThreadRole } from '../generated/prisma/enums.js';

/** What Atlas says, and to whom. `null` from `consider` means: nothing to say yet. */
export type ContextNudge = { audience: ENudgeAudience; text: string };

type SessionPressure = {
  /** Increments once per turn. The nudge cadence escalates across turns, never within one. */
  turn: number;
  last: NudgeLedger;
  /** One entry per turn: did that turn's first message open with the canary. */
  canary: boolean[];
  /** The dead-canary warning is worth saying once per session and then never again. */
  deadAnnounced: boolean;
};

/**
 * Sessions kept before the oldest is dropped. Deliberately generous and deliberately finite: a
 * long-lived TUI opens many sessions and this map is the only thing that remembers them.
 */
const MAX_SESSIONS = 64;

/**
 * The two instruments, and the decision they feed: how full a session is against its budget, and
 * whether it is still following a standing instruction.
 *
 * In memory, and that is a decision rather than an omission. Both readings are about the CURRENT
 * conversation — a nudge ledger restored from disk would re-ask a question the agent has already
 * answered, and a canary rate is a claim about the last five turns, which after a restart is a claim
 * about a session nobody is having. A restarted Atlas re-measures from the next turn, which takes
 * one turn and is honest about what it knows.
 *
 * It owns no repository and no engine on purpose: everything here is arithmetic over facts the turn
 * runner already has, which is what makes the escalation testable without a database or a terminal.
 */
@Injectable()
export class ContextPressureService {
  private readonly sessions = new Map<string, SessionPressure>();

  /**
   * The `ctx` meter's reading: the token count it prints, the window fill it draws, and the budget
   * pressure it takes its colour from — see `ContextReading` for why those are three answers.
   *
   * `contextLimit` is the window the engine reported on this frame. It is passed through rather than
   * resolved from the model name because Codex's window moves remotely — legacy pinned a constant
   * and had no way to notice when it changed.
   */
  observe(args: {
    session: EngineSession;
    contextTokens: number;
    contextLimit: number;
  }): ContextReading {
    const percent = windowPercent({ tokens: args.contextTokens, limit: args.contextLimit });
    const band = pressureBand({
      tokens: args.contextTokens,
      budget: this.budget(args.session, args.contextLimit),
    });
    // A dead canary and a full budget are different situations, so the meter says which one it is
    // drawing. `dying` is not yet a verdict and deliberately does not take the label.
    const signal =
      this.health(args.session.id) === ECanaryHealth.dead
        ? EContextSignal.canary
        : EContextSignal.budget;
    return { tokens: args.contextTokens, percent, band, signal };
  }

  /** A new turn on this session. Called at the turn boundary, before anything is asked of it. */
  startTurn(sessionId: string): void {
    this.for(sessionId).turn += 1;
  }

  /**
   * Should Atlas ask for a hand-off right now, and of whom.
   *
   * Called at a TOOL boundary so the agent is never interrupted mid-thought — the answer arrives on
   * the tool result it was already waiting for. Recording the nudge here rather than after delivery
   * keeps the ledger honest under the one failure that matters: a message that fails to persist has
   * still been said to the model.
   */
  consider(args: {
    session: EngineSession;
    role: EThreadRole;
    tokens: number;
    contextLimit: number;
  }): ContextNudge | null {
    const state = this.for(args.session.id);
    const budget = this.budget(args.session, args.contextLimit);
    if (!decideNudge({ tokens: args.tokens, budget, turn: state.turn, last: state.last })) {
      return null;
    }
    state.last = { atTokens: args.tokens, onTurn: state.turn };

    const audience = audienceFor(args.role);
    if (audience === ENudgeAudience.human) {
      return { audience, text: nudgeNotice({ tokens: args.tokens, budget }) };
    }
    // Two speech acts on one threshold ladder, and the band chooses between them. `soft` advises and
    // leaves the timing to the agent: a budget crossing lands wherever it lands, and an agent that
    // stops dead mid-edit hands over a half-applied change. `hard` is the point where that discretion
    // has been exercised for tens of thousands of tokens, so Atlas stops deferring to it and sends
    // the same request `/rotate` does. Both prepend one sentence saying why it is asking now, and
    // neither cuts — the act is always the agent's own tool call.
    const reason = nudgeReason({ tokens: args.tokens, budget });
    const hard = contextBand({ tokens: args.tokens, budget }) === EContextBand.hard;
    return { audience, text: hard ? rotationRequest({ reason }) : handoffAdvisory({ reason }) };
  }

  /**
   * Close the turn's canary sample. `undefined` means the turn produced no prose at all — a pure
   * tool turn, or one that failed before it spoke — and is recorded as NOTHING rather than as a
   * miss: a session cannot fail to follow a formatting rule in a message it never wrote.
   *
   * Returns the health only when it has just crossed into `dead`, because that transition is the one
   * moment worth telling the human about: a session that has stopped obeying standing instructions
   * may also not act on being asked to rotate, and asking louder is not the answer to that.
   */
  endTurn(args: { sessionId: string; canary: boolean | undefined }): ECanaryHealth | null {
    const state = this.for(args.sessionId);
    if (args.canary === undefined) return null;
    state.canary.push(args.canary);
    if (state.deadAnnounced) return null;
    if (canaryHealth(state.canary) !== ECanaryHealth.dead) return null;
    state.deadAnnounced = true;
    return ECanaryHealth.dead;
  }

  health(sessionId: string): ECanaryHealth {
    const state = this.sessions.get(sessionId);
    return state ? canaryHealth(state.canary) : ECanaryHealth.unknown;
  }

  /** The retired leg's readings are not the new one's. Called when a session ends. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private budget(session: EngineSession, contextLimit: number): Budget {
    return budgetFor({
      engine: session.engine,
      model: session.model,
      contextLimit,
    });
  }

  private for(sessionId: string): SessionPressure {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const state: SessionPressure = { turn: 0, last: null, canary: [], deadAnnounced: false };
    this.sessions.set(sessionId, state);
    // Insertion order, so the oldest session is the first key. Bounded rather than cleared: the
    // sessions still running are the recent ones, and dropping them would reset a live cadence.
    if (this.sessions.size > MAX_SESSIONS) {
      const [oldest] = this.sessions.keys();
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    return state;
  }
}
