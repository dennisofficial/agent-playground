import { describe, expect, it } from "vitest";
import { applyStreamFrame, peekLiveTurn, MAIN_LANE } from "./job-stream";

// The store is module-global, so each test uses a unique jobId to stay isolated.
describe("job-stream turn_start clears stale blocks", () => {
  it("drops a leftover open block when a fresh turn_start arrives, then rebuilds from the replay", () => {
    const jobId = "job-turnstart-clear";

    // A stale open text block survives from a prior/orphaned subscription.
    applyStreamFrame(jobId, MAIN_LANE, 1, { kind: "text_delta", text: "stale" });
    expect(peekLiveTurn(jobId)?.blocks).toHaveLength(1);

    // The reattach's fresh turn_start (higher seq) must clear the lane, not preserve the stale block.
    applyStreamFrame(jobId, MAIN_LANE, 2, {
      kind: "turn_start",
      startedAt: 123,
    });
    const afterStart = peekLiveTurn(jobId);
    expect(afterStart?.blocks).toHaveLength(0);
    expect(afterStart?.active).toBe(true);
    expect(afterStart?.startedAt).toBe(123);

    // The replay then rebuilds cleanly — exactly one open block, no stale leftover.
    applyStreamFrame(jobId, MAIN_LANE, 3, { kind: "text_delta", text: "fresh" });
    const rebuilt = peekLiveTurn(jobId);
    expect(rebuilt?.blocks).toHaveLength(1);
    expect(rebuilt?.blocks[0]).toMatchObject({
      kind: "text",
      text: "fresh",
      done: false,
    });
  });

  it("a turn_start on a genuinely new (empty) lane simply opens an active turn", () => {
    const jobId = "job-turnstart-new";
    applyStreamFrame(jobId, MAIN_LANE, 1, {
      kind: "turn_start",
      startedAt: 456,
    });
    const turn = peekLiveTurn(jobId);
    expect(turn?.blocks).toHaveLength(0);
    expect(turn?.active).toBe(true);
    expect(turn?.startedAt).toBe(456);
  });
});

describe("job-stream jit_injection joins by tool_use_id", () => {
  it("attaches the injection to the matching open tool block, appending across multiple hooks", () => {
    const jobId = "job-jit-injection";

    applyStreamFrame(jobId, MAIN_LANE, 1, {
      kind: "tool_use",
      id: "tool-1",
      name: "Bash",
      input: { command: "npm install left-pad" },
    });
    let turn = peekLiveTurn(jobId);
    expect(turn?.blocks[0]).toMatchObject({ kind: "tool", toolId: "tool-1" });
    expect((turn?.blocks[0] as { jitContext?: unknown }).jitContext).toBeUndefined();

    // A single Bash call can trigger more than one hook (e.g. install-awareness's async
    // profile-fetch resolving after svc-nudge's synchronous check) — both must accumulate.
    applyStreamFrame(jobId, MAIN_LANE, 2, {
      kind: "jit_injection",
      id: "tool-1",
      rule: "svc-nudge",
      text: "A service is already running on this port.",
    });
    applyStreamFrame(jobId, MAIN_LANE, 3, {
      kind: "jit_injection",
      id: "tool-1",
      rule: "install-awareness",
      text: "left-pad is already a project dependency.",
    });

    turn = peekLiveTurn(jobId);
    expect(turn?.blocks).toHaveLength(1);
    expect(turn?.blocks[0]).toMatchObject({
      kind: "tool",
      toolId: "tool-1",
      jitContext: [
        { rule: "svc-nudge", text: "A service is already running on this port." },
        {
          rule: "install-awareness",
          text: "left-pad is already a project dependency.",
        },
      ],
    });

    // A jit_injection for an id with no matching block is a no-op (never throws).
    applyStreamFrame(jobId, MAIN_LANE, 4, {
      kind: "jit_injection",
      id: "no-such-tool",
      rule: "github-fetch-guard",
      text: "ignored",
    });
    expect(peekLiveTurn(jobId)?.blocks).toHaveLength(1);
  });
});

describe("job-stream user_text — parent→sub-agent SendMessage injection", () => {
  it("pushes a standalone done:true 'user' block carrying the injection's parentToolUseId", () => {
    const jobId = "job-user-text";

    applyStreamFrame(jobId, MAIN_LANE, 1, {
      kind: "user_text",
      text: "keep going on the auth module",
      parentToolUseId: "tu-sub-1",
    });

    const turn = peekLiveTurn(jobId);
    expect(turn?.blocks).toHaveLength(1);
    expect(turn?.blocks[0]).toMatchObject({
      kind: "user",
      text: "keep going on the auth module",
      done: true,
      parentToolUseId: "tu-sub-1",
    });
  });

  it("never coalesces consecutive injections into one block (each is a discrete turn)", () => {
    const jobId = "job-user-text-discrete";

    applyStreamFrame(jobId, MAIN_LANE, 1, {
      kind: "user_text",
      text: "first nudge",
      parentToolUseId: "tu-sub-2",
    });
    applyStreamFrame(jobId, MAIN_LANE, 2, {
      kind: "user_text",
      text: "second nudge",
      parentToolUseId: "tu-sub-2",
    });

    const turn = peekLiveTurn(jobId);
    expect(turn?.blocks).toHaveLength(2);
    expect(turn?.blocks.map((b) => (b as { text: string }).text)).toEqual([
      "first nudge",
      "second nudge",
    ]);
  });
});
