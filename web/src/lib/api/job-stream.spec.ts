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
