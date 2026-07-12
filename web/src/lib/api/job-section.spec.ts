import { describe, expect, it } from "vitest";
import { groupThreadsBySection, sectionOf } from "./job-section";
import type { InboxThread } from "./inbox";
import type { JobStatus } from "./types";

function makeThread(overrides: Partial<InboxThread> = {}): InboxThread {
  return {
    id: "t1",
    title: "A thread",
    kind: "feat",
    status: "planning",
    activity: "idle",
    needsYou: false,
    halted: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    pr: null,
    ci: null,
    ciCounts: null,
    halt: null,
    shipping: false,
    createdBy: null,
    blockedBy: [],
    blockedSeedMessage: null,
    org: { id: "org1", slug: "org1", name: "Org One" },
    repo: { id: "repo1", name: "repo-one" },
    ...overrides,
  };
}

describe("sectionOf", () => {
  it("maps planning-family statuses to planning", () => {
    for (const status of ["planning", "triaging"] as JobStatus[]) {
      expect(sectionOf(makeThread({ status }))).toBe("planning");
    }
  });

  it("maps plan_review to its own hands-off reviewing section", () => {
    expect(
      sectionOf(makeThread({ status: "plan_review" as JobStatus })),
    ).toBe("reviewing");
  });

  it("maps awaiting_approval to awaiting and awaiting_ship_review to ready_to_ship", () => {
    expect(
      sectionOf(makeThread({ status: "awaiting_approval" as JobStatus })),
    ).toBe("awaiting");
    expect(
      sectionOf(makeThread({ status: "awaiting_ship_review" as JobStatus })),
    ).toBe("ready_to_ship");
  });

  it("maps amending to its own amending section", () => {
    expect(sectionOf(makeThread({ status: "amending" as JobStatus }))).toBe(
      "amending",
    );
  });

  it("maps blocked to its own blocked section", () => {
    expect(sectionOf(makeThread({ status: "blocked" as JobStatus }))).toBe(
      "blocked",
    );
  });

  it("d1: a running job with pr.state='open' still lands in building, not pr_open", () => {
    const thread = makeThread({
      status: "running",
      pr: {
        state: "open",
        number: 1,
        mergeable: null,
        url: "https://example.com/pr/1",
      },
    });
    expect(sectionOf(thread)).toBe("building");
  });

  it("a shipping job (running + shipping) stays in ready_to_ship, not building", () => {
    expect(sectionOf(makeThread({ status: "running", shipping: true }))).toBe(
      "ready_to_ship",
    );
  });

  it("a normal running job (shipping false) lands in building", () => {
    expect(sectionOf(makeThread({ status: "running", shipping: false }))).toBe(
      "building",
    );
  });

  it("a running job in master_review activity lands in master_review, not building", () => {
    expect(
      sectionOf(
        makeThread({ status: "running", activity: "master_review" }),
      ),
    ).toBe("master_review");
  });

  it("master_review activity takes precedence over the shipping branch", () => {
    expect(
      sectionOf(
        makeThread({
          status: "running",
          activity: "master_review",
          shipping: true,
        }),
      ),
    ).toBe("master_review");
  });

  it("done with no PR lands in done", () => {
    expect(sectionOf(makeThread({ status: "done", pr: null }))).toBe("done");
  });

  it("done with a closed PR lands in done", () => {
    const thread = makeThread({
      status: "done",
      pr: { state: "closed", number: null, mergeable: null, url: null },
    });
    expect(sectionOf(thread)).toBe("done");
  });

  it("done with an open PR lands in pr_open", () => {
    const thread = makeThread({
      status: "done",
      pr: { state: "open", number: 42, mergeable: null, url: null },
    });
    expect(sectionOf(thread)).toBe("pr_open");
  });

  it("done with a merged PR lands in merged", () => {
    const thread = makeThread({
      status: "done",
      pr: { state: "merged", number: null, mergeable: null, url: null },
    });
    expect(sectionOf(thread)).toBe("merged");
  });

  it("cancelled and deleting are hidden", () => {
    expect(sectionOf(makeThread({ status: "cancelled" }))).toBeNull();
    expect(sectionOf(makeThread({ status: "deleting" }))).toBeNull();
  });
});

describe("groupThreadsBySection", () => {
  it("omits empty sections and preserves fixed order", () => {
    const threads = [
      makeThread({
        id: "m1",
        status: "done",
        pr: { state: "merged", number: null, mergeable: null, url: null },
      }),
      makeThread({ id: "p1", status: "planning" }),
      makeThread({ id: "k1", status: "blocked" }),
      makeThread({ id: "b1", status: "running" }),
    ];
    const groups = groupThreadsBySection(threads);
    expect(groups.map((g) => g.section)).toEqual([
      "blocked",
      "planning",
      "building",
      "merged",
    ]);
  });

  it("drops cancelled/deleting threads entirely", () => {
    const threads = [
      makeThread({ id: "c1", status: "cancelled" }),
      makeThread({ id: "x1", status: "deleting" }),
    ];
    expect(groupThreadsBySection(threads)).toEqual([]);
  });

  it("groups multiple threads sharing a section together", () => {
    const threads = [
      makeThread({ id: "p1", status: "planning" }),
      makeThread({ id: "p2", status: "triaging" }),
    ];
    const groups = groupThreadsBySection(threads);
    expect(groups).toEqual([
      { section: "planning", threads: [threads[0], threads[1]] },
    ]);
  });

  it("splits plan_review into its own reviewing section, ordered after planning", () => {
    const threads = [
      makeThread({ id: "r1", status: "plan_review" }),
      makeThread({ id: "p1", status: "planning" }),
    ];
    const groups = groupThreadsBySection(threads);
    expect(groups.map((g) => g.section)).toEqual(["planning", "reviewing"]);
    expect(groups.find((g) => g.section === "reviewing")?.threads).toEqual([
      threads[0],
    ]);
  });

  it("splits the two awaiting gates into separate ordered sections", () => {
    const threads = [
      makeThread({ id: "a2", status: "awaiting_ship_review" }),
      makeThread({ id: "a1", status: "awaiting_approval" }),
    ];
    const groups = groupThreadsBySection(threads);
    expect(groups.map((g) => g.section)).toEqual(["awaiting", "ready_to_ship"]);
  });

  it("orders master_review directly after building", () => {
    const threads = [
      makeThread({ id: "d1", status: "done", pr: null }),
      makeThread({ id: "mr1", status: "running", activity: "master_review" }),
      makeThread({ id: "b1", status: "running" }),
    ];
    const groups = groupThreadsBySection(threads);
    expect(groups.map((g) => g.section)).toEqual([
      "building",
      "master_review",
      "done",
    ]);
  });

  it("orders ready_to_ship between building and done", () => {
    const threads = [
      makeThread({ id: "d1", status: "done", pr: null }),
      makeThread({ id: "s1", status: "awaiting_ship_review" }),
      makeThread({ id: "b1", status: "running" }),
    ];
    const groups = groupThreadsBySection(threads);
    expect(groups.map((g) => g.section)).toEqual([
      "building",
      "ready_to_ship",
      "done",
    ]);
  });
});
