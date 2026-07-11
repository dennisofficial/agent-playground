import { describe, expect, it } from "vitest";
import type { LiveBlock } from "@/lib/api/job-stream";
import { indexLiveSubagents } from "./subagents";

/**
 * The subagent card's live "running vs done" state.
 *
 * A BACKGROUNDED Task subagent returns its `tool_result` immediately — a launch ack, not the real result —
 * so its anchor block flips `done:true` at launch while the subagent is still streaming. The card must NOT
 * read `done` for a background run; it reads `bgSettled` (stamped on the anchor by the `bg_task` settlement
 * frame). A FOREGROUND subagent's `done` IS its real completion, so it keeps the `!done` behavior.
 */

const anchor = (over: Partial<Extract<LiveBlock, { kind: "tool" }>>): LiveBlock => ({
  kind: "tool",
  key: "a1",
  toolId: "tu-bg",
  name: "Task",
  done: false,
  emittedAt: 1,
  ...over,
});

const child = (): LiveBlock => ({
  kind: "text",
  key: "c1",
  text: "working",
  done: false,
  parentToolUseId: "tu-bg",
  emittedAt: 2,
});

describe("indexLiveSubagents — background subagent running state", () => {
  it("a backgrounded subagent stays running after its launch-ack (done=true) until bg_task settles", () => {
    const blocks: LiveBlock[] = [
      anchor({
        input: { subagent_type: "general-purpose", run_in_background: true },
        done: true, // the immediate launch ack — NOT completion
      }),
      child(),
    ];
    const summary = indexLiveSubagents(blocks).summaryById.get("tu-bg")!;
    expect(summary.background).toBe(true);
    expect(summary.running).toBe(true); // still working despite done=true (the bug this fixes)
  });

  it("a backgrounded subagent flips to done once bg_task settlement stamps bgSettled on the anchor", () => {
    const blocks: LiveBlock[] = [
      anchor({
        input: { subagent_type: "general-purpose", run_in_background: true },
        done: true,
        bgSettled: true, // set by the bg_task completed/failed/stopped frame
      }),
      child(),
    ];
    const summary = indexLiveSubagents(blocks).summaryById.get("tu-bg")!;
    expect(summary.running).toBe(false);
  });

  it("a FOREGROUND subagent keeps the unchanged !done behavior (done is its real completion)", () => {
    const running = indexLiveSubagents([
      anchor({ input: { subagent_type: "explore", run_in_background: false }, done: false }),
      child(),
    ]).summaryById.get("tu-bg")!;
    expect(running.background).toBe(false);
    expect(running.running).toBe(true);

    const done = indexLiveSubagents([
      anchor({ input: { subagent_type: "explore", run_in_background: false }, done: true }),
      child(),
    ]).summaryById.get("tu-bg")!;
    // A foreground run's bgSettled is never set; it must NOT keep it running.
    expect(done.running).toBe(false);
  });
});
