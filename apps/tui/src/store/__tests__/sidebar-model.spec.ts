import {
  EClassifierMode,
  EDecision,
  EGrantScope,
  EJudgment,
  ERiskDimension,
  ETriage,
  toCallId,
  toRunId,
  toThreadId,
} from "@dltech/atlas-core";
import {
  ETurnStatus,
  NOTHING_SPENT,
  type TurnSpend,
} from "@dltech/atlas-harness";
import { describe, expect, it } from "bun:test";

import { IDLE_TURN } from "../../ui/components/transcript";
import { SIDEBAR_WIDTH } from "../../ui/theme";
import { ESidebarPlace } from "../../ui/sidebar-section";
import { deriveSidebar, IDLE_SIDEBAR, withSections } from "../sidebar-model";
import { log } from "./fixture";

const CALL_ONE = toCallId("call-1");

const turnOf = (clock: Partial<typeof IDLE_TURN>): typeof IDLE_TURN => ({
  ...IDLE_TURN,
  ...clock,
});

const spent = (over: Partial<TurnSpend> = {}): TurnSpend => ({
  runId: toRunId("run-1"),
  threadId: toThreadId("thread-1"),
  status: ETurnStatus.Completed,
  providerId: "anthropic",
  modelId: "claude-sonnet-5",
  steps: 3,
  inputTokens: 100_000,
  outputTokens: 4_000,
  cacheReadTokens: 80_000,
  cacheWriteTokens: 10_000,
  startedAt: "2026-08-28T18:31:06.000Z",
  endedAt: "2026-08-28T18:32:00.000Z",
  durationMs: 54_000,
  ...over,
});

describe("an empty thread", () => {
  it("derives an idle sidebar with nothing to show", () => {
    const model = deriveSidebar({ events: [], turn: IDLE_TURN });

    expect(model.approvals).toEqual([]);
    expect(model.lastActivity).toBeNull();
    expect(model.spend.totals).toEqual(NOTHING_SPENT);
    expect(model.spend.costUsd).toBeNull();
  });
});

describe("approvals", () => {
  it("shows an outstanding approval", () => {
    const events = log([
      {
        type: "tool-called",
        callId: CALL_ONE,
        name: "bash",
        input: {},
        ordinal: 0,
      },
      {
        type: "approval-requested",
        callId: CALL_ONE,
        reason: "runs a shell command",
      },
    ]);

    const model = deriveSidebar({ events, turn: IDLE_TURN });

    expect(model.approvals).toEqual([
      { callId: CALL_ONE, reason: "runs a shell command" },
    ]);
  });

  it("clears the approval once it is answered", () => {
    const events = log([
      {
        type: "tool-called",
        callId: CALL_ONE,
        name: "bash",
        input: {},
        ordinal: 0,
      },
      {
        type: "approval-requested",
        callId: CALL_ONE,
        reason: "runs a shell command",
      },
      {
        type: "approval-answered",
        callId: CALL_ONE,
        decision: EDecision.Allow,
      },
    ]);

    const model = deriveSidebar({ events, turn: IDLE_TURN });

    expect(model.approvals).toEqual([]);
  });
});

describe("what the conversation has spent", () => {
  it("totals every turn the ledger has recorded", () => {
    const model = deriveSidebar({
      events: [],
      turn: IDLE_TURN,
      turns: [spent(), spent()],
    });

    expect(model.spend.totals.inputTokens).toBe(200_000);
    expect(model.spend.totals.outputTokens).toBe(8_000);
    expect(model.spend.totals.cacheReadTokens).toBe(160_000);
  });

  /**
   * A turn only reaches the ledger once it has ended, so the clock is the only reading of the turn
   * in flight — and it counts output alone, which is why nothing else moves while one runs.
   */
  it("adds what the running turn has streamed to the recorded output", () => {
    const model = deriveSidebar({
      events: [],
      turn: turnOf({ startedAt: 1000, outputTokens: 120 }),
      turns: [spent()],
    });

    expect(model.spend.totals.outputTokens).toBe(4_120);
    expect(model.spend.totals.inputTokens).toBe(100_000);
  });

  it("drops the live count once the turn has settled into a ledger row", () => {
    const model = deriveSidebar({
      events: [],
      turn: turnOf({ completed: { durationMs: 4000, outputTokens: 300 } }),
      turns: [spent()],
    });

    expect(model.spend.totals.outputTokens).toBe(4_000);
  });

  it("prices what was spent, billing a cache read at a tenth and a write at a quarter over", () => {
    const model = deriveSidebar({
      events: [],
      turn: IDLE_TURN,
      turns: [spent()],
      priceOf: () => ({ inputPerMillion: 3, outputPerMillion: 15 }),
    });

    expect(model.spend.costUsd).toBeCloseTo(0.1515, 6);
  });

  it("refuses a figure when nothing could be priced, rather than claiming it was free", () => {
    const model = deriveSidebar({
      events: [],
      turn: IDLE_TURN,
      turns: [spent()],
      priceOf: () => undefined,
    });

    expect(model.spend.costUsd).toBeNull();
  });
});

describe("the session head", () => {
  it("counts a turn for every thing the operator said", () => {
    const events = log([
      { type: "user-said", text: "rotate the refresh tokens" },
      { type: "assistant-said", parts: [] },
      { type: "user-said", text: "and cover reuse" },
    ]);

    expect(deriveSidebar({ events, turn: IDLE_TURN }).turnCount).toBe(2);
  });

  it("titles the session with the first thing the operator said, on one line", () => {
    const events = log([
      { type: "user-said", text: "  Refresh-token\n  rotation  " },
    ]);

    expect(deriveSidebar({ events, turn: IDLE_TURN }).title).toBe(
      "Refresh-token rotation",
    );
  });

  it("truncates a title that would not fit the sidebar", () => {
    const events = log([{ type: "user-said", text: "R".repeat(200) }]);

    const title = deriveSidebar({ events, turn: IDLE_TURN }).title ?? "";

    expect([...title].length).toBeLessThanOrEqual(SIDEBAR_WIDTH);
    expect(title.endsWith("…")).toBe(true);
  });

  it("prefers the name the session was given over the first thing said", () => {
    const events = log([
      { type: "user-said", text: "the refresh token never rotates" },
    ]);

    expect(
      deriveSidebar({ events, turn: IDLE_TURN, name: "Refresh-token rotation" })
        .title,
    ).toBe("Refresh-token rotation");
  });

  it("falls back to the opening message while the session is still unnamed", () => {
    const events = log([
      { type: "user-said", text: "the refresh token never rotates" },
    ]);

    expect(deriveSidebar({ events, turn: IDLE_TURN, name: null }).title).toBe(
      "the refresh token never rotates",
    );
  });

  it("ignores a name that is blank rather than showing an empty heading", () => {
    const events = log([{ type: "user-said", text: "rotate the tokens" }]);

    expect(deriveSidebar({ events, turn: IDLE_TURN, name: "   " }).title).toBe(
      "rotate the tokens",
    );
  });

  it("truncates a name too long for the sidebar", () => {
    const title =
      deriveSidebar({ events: [], turn: IDLE_TURN, name: "R".repeat(200) })
        .title ?? "";

    expect([...title].length).toBeLessThanOrEqual(SIDEBAR_WIDTH);
    expect(title.endsWith("…")).toBe(true);
  });

  it("leaves the title unset on an empty thread, and on one that says nothing", () => {
    expect(deriveSidebar({ events: [], turn: IDLE_TURN }).title).toBeNull();

    const blank = log([{ type: "user-said", text: "   \n  " }]);
    expect(deriveSidebar({ events: blank, turn: IDLE_TURN }).title).toBeNull();
  });
});

describe("the sections no producer feeds yet", () => {
  it("leaves them absent rather than empty, so no bare header is drawn", () => {
    const events = log([
      { type: "user-said", text: "go" },
      {
        type: "tool-called",
        callId: CALL_ONE,
        name: "bash",
        input: {},
        ordinal: 0,
      },
    ]);

    const model = deriveSidebar({
      events,
      turn: turnOf({ startedAt: 1000, outputTokens: 12 }),
    });

    expect(model.todo).toBeUndefined();
    expect(model.subagents).toBeUndefined();
    expect(model.teammates).toBeUndefined();
  });

  it("keeps the idle sidebar a valid model with nothing fed to it", () => {
    expect(IDLE_SIDEBAR.title).toBeNull();
    expect(IDLE_SIDEBAR.turnCount).toBe(0);
    expect(IDLE_SIDEBAR.spend.totals).toEqual(NOTHING_SPENT);
    expect(IDLE_SIDEBAR.todo).toBeUndefined();
  });
});

describe("withSections", () => {
  const section = (id: string, place: ESidebarPlace) => ({
    id,
    place,
    rows: [{ id: `${id}-row`, spans: [{ text: id }] }],
  });

  it("carries what plugins contributed, facts first", () => {
    const model = withSections({
      model: IDLE_SIDEBAR,
      sections: [
        section("panel", ESidebarPlace.Panels),
        section("repo", ESidebarPlace.Facts),
      ],
    });

    expect(model.sections?.map((found) => found.id)).toEqual(["repo", "panel"]);
  });

  it("leaves the model untouched when no plugin contributed a section", () => {
    expect(withSections({ model: IDLE_SIDEBAR, sections: [] })).toBe(
      IDLE_SIDEBAR,
    );
  });

  it("keeps everything the model already carried", () => {
    const model = withSections({
      model: { ...IDLE_SIDEBAR, title: "a thread" },
      sections: [section("repo", ESidebarPlace.Facts)],
    });

    expect(model.title).toBe("a thread");
  });
});

describe("the nudge figure the operator reads before arming it", () => {
  it("rides on the sidebar beside the outstanding questions", () => {
    const events = log([
      { type: "user-said", text: "clean up the merged worktrees" },
      {
        type: "classifier-judged",
        callId: CALL_ONE,
        mode: EClassifierMode.Shadow,
        triage: ETriage.Consult,
        judgment: EJudgment.Check,
        dimensions: [ERiskDimension.Contention],
        judgedDimension: ERiskDimension.Contention,
        signalIds: ["contention:occupied"],
        details: ["eng-412-sidebar is held by another live session"],
        reason: "contention: eng-412-sidebar is held by another live session",
        consulted: true,
        wouldAsk: true,
        fatigued: false,
        elapsedMs: 610,
      },
    ]);

    const model = deriveSidebar({ events, turn: IDLE_TURN });

    expect(model.classifier).toEqual({
      pauses: 1,
      turns: 1,
      topDimension: ERiskDimension.Contention,
      quietedCalls: 0,
      judgeUnreachable: false,
    });
  });
});

describe("the grants a thread is running under", () => {
  const given = {
    type: "permission-granted" as const,
    grantId: "grant:call-1:worktree:eng-412-sidebar",
    dimensions: [ERiskDimension.Contention],
    scope: EGrantScope.Thread,
    subject: "worktree:eng-412-sidebar",
    reason: "the operator chose to stop being asked about this",
  };

  it("lists what the operator has waived, so no permission is invisible", () => {
    const model = deriveSidebar({ events: log([given]), turn: IDLE_TURN });

    expect(model.grants?.map((grant) => grant.subject)).toEqual([
      "worktree:eng-412-sidebar",
    ]);
    expect(model.grants?.at(0)?.dimensions).toEqual([
      ERiskDimension.Contention,
    ]);
  });

  it("drops a grant the operator took back rather than leaving a dead row", () => {
    const events = log([
      given,
      { type: "permission-revoked", grantId: given.grantId },
    ]);

    expect(deriveSidebar({ events, turn: IDLE_TURN }).grants).toBeUndefined();
  });

  it("shows no section at all on a thread that granted nothing", () => {
    expect(
      deriveSidebar({ events: [], turn: IDLE_TURN }).grants,
    ).toBeUndefined();
  });
});
