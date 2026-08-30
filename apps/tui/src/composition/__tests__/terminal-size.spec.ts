import { describe, expect, it } from "bun:test";

import {
  readTerminalSize,
  settleTerminalSize,
  type TerminalSize,
} from "../terminal-size";

type Scheduled = {
  readonly delayMs: number;
  readonly run: () => void;
  cancelled: boolean;
};

const harness = (args: { winsize: TerminalSize; sampled: TerminalSize }) => {
  const scheduled: Scheduled[] = [];
  const applied: TerminalSize[] = [];
  let winsize: TerminalSize | null = args.winsize;
  let current = args.sampled;

  const stop = settleTerminalSize({
    read: () => winsize,
    current: () => current,
    apply: (size) => {
      applied.push(size);
      current = size;
    },
    schedule: (run, delayMs) => {
      const entry: Scheduled = { delayMs, run, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    delaysMs: [0, 100],
  });

  return {
    applied,
    scheduled,
    stop,
    setWinsize: (next: TerminalSize | null) => {
      winsize = next;
    },
    fire: () => {
      for (const entry of scheduled) if (!entry.cancelled) entry.run();
    },
  };
};

describe("a renderer that sampled the terminal before the window settled", () => {
  it("resizes to the live winsize when the sampled width fell short", () => {
    const run = harness({
      winsize: { width: 173, height: 40 },
      sampled: { width: 168, height: 40 },
    });

    run.fire();

    expect(run.applied[0]).toEqual({ width: 173, height: 40 });
  });

  it("leaves a renderer alone once its size already agrees with the winsize", () => {
    const run = harness({
      winsize: { width: 173, height: 40 },
      sampled: { width: 173, height: 40 },
    });

    run.fire();

    expect(run.applied).toEqual([]);
  });

  it("applies once and then holds, rather than resizing on every check", () => {
    const run = harness({
      winsize: { width: 173, height: 40 },
      sampled: { width: 80, height: 24 },
    });

    run.fire();

    expect(run.applied).toHaveLength(1);
  });

  it("ignores a winsize the tty cannot yet report", () => {
    const run = harness({
      winsize: { width: 173, height: 40 },
      sampled: { width: 80, height: 24 },
    });
    run.setWinsize(null);

    run.fire();

    expect(run.applied).toEqual([]);
  });

  it("cancels its outstanding checks when the renderer goes down", () => {
    const run = harness({
      winsize: { width: 173, height: 40 },
      sampled: { width: 80, height: 24 },
    });

    run.stop();
    run.fire();

    expect(run.applied).toEqual([]);
  });
});

describe("reading the live winsize", () => {
  it("reports the columns and rows the tty currently holds", () => {
    expect(readTerminalSize({ columns: 173, rows: 40 })).toEqual({
      width: 173,
      height: 40,
    });
  });

  it("reports nothing for a stdout that is not a terminal", () => {
    expect(
      readTerminalSize({ columns: undefined, rows: undefined }),
    ).toBeNull();
  });

  it("reports nothing while the tty still answers zero", () => {
    expect(readTerminalSize({ columns: 0, rows: 0 })).toBeNull();
  });
});
