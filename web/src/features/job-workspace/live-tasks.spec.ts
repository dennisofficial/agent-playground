import { describe, expect, it } from "vitest";
import type { LiveTurn } from "@/lib/api/job-stream";
import { overlayLiveTasks } from "./live-tasks";

function liveTurn(blocks: LiveTurn["blocks"]): LiveTurn {
  return { blocks, active: true, lastSeq: blocks.length };
}

describe("overlayLiveTasks — unified bridge task tools", () => {
  it("folds a bridged mcp__atlas-host-bridge__task_create call onto the durable list", () => {
    const live = liveTurn([
      {
        kind: "tool",
        key: "t1",
        name: "mcp__atlas-host-bridge__task_create",
        input: { subject: "Wire up the bridge" },
        result: "Task #7 created: Wire up the bridge",
        done: true,
        emittedAt: 1,
      },
    ]);
    const result = overlayLiveTasks([], live);
    expect(result).toEqual([
      { id: "7", subject: "Wire up the bridge", status: "pending" },
    ]);
  });

  it("folds a bridged mcp__atlas-host-bridge__task_update call onto the durable list", () => {
    const durable = [{ id: "7", subject: "Wire up the bridge", status: "pending" as const }];
    const live = liveTurn([
      {
        kind: "tool",
        key: "t2",
        name: "mcp__atlas-host-bridge__task_update",
        input: { taskId: "7", status: "in_progress" },
        result: "ok",
        done: true,
        emittedAt: 2,
      },
    ]);
    const result = overlayLiveTasks(durable, live);
    expect(result).toEqual([
      { id: "7", subject: "Wire up the bridge", status: "in_progress" },
    ]);
  });

  it("ignores unrelated bridge tool calls (e.g. task_list)", () => {
    const durable = [{ id: "7", subject: "Wire up the bridge", status: "pending" as const }];
    const live = liveTurn([
      {
        kind: "tool",
        key: "t3",
        name: "mcp__atlas-host-bridge__task_list",
        input: {},
        result: "…",
        done: true,
        emittedAt: 3,
      },
    ]);
    expect(overlayLiveTasks(durable, live)).toEqual(durable);
  });
});
