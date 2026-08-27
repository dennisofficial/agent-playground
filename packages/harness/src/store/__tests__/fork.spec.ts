import { afterEach, describe, expect, it } from "bun:test";

import {
  EForkMode,
  toBranchId,
  toRunId,
  type BranchId,
  type EventDraft,
} from "@dltech/atlas-core";

import { ForkSeqOutOfRange, ForkSourceMissing } from "../fork";
import { rewindBranch } from "../rewind";
import { openStoreFixture, type StoreFixture } from "./harness";

let fixture: StoreFixture;

const runId = toRunId("run-1");
const said = (text: string): EventDraft => ({ type: "user-said", text });
const replied = (text: string): EventDraft => ({
  type: "assistant-said",
  parts: [{ type: "text", text }],
});

const openParent = async (): Promise<{
  store: StoreFixture;
  parentId: BranchId;
}> => {
  fixture = await openStoreFixture();
  const branch = await fixture.branches.create({ title: "work" });
  await fixture.log.append({
    branchId: branch.id,
    runId,
    drafts: [
      said("one"),
      replied("two"),
      said("three"),
      replied("four"),
      said("five"),
    ],
  });
  return { store: fixture, parentId: branch.id };
};

const rowsUnder = (store: StoreFixture, branchId: BranchId): Promise<number> =>
  store.prisma.event.count({ where: { branchId } });

const shapeOf = (
  events: readonly { seq: number; type: string }[],
): [number, string][] => events.map((event) => [event.seq, event.type]);

afterEach(async () => {
  await fixture.close();
});

describe("a copy fork", () => {
  it("lands its own rows under the new branch and leaves the parent untouched", async () => {
    const { store, parentId } = await openParent();

    const child = await store.branches.fork({
      from: parentId,
      seq: 3,
      mode: EForkMode.Copy,
    });

    expect(child.head).toBe(3);
    expect(child.parent).toEqual({ branchId: parentId, forkSeq: 3 });
    expect(await rowsUnder(store, child.id)).toBe(3);
    expect(await rowsUnder(store, parentId)).toBe(5);
    expect(await store.log.head({ branchId: parentId })).toBe(5);
    expect(shapeOf(await store.log.read({ branchId: parentId }))).toHaveLength(
      5,
    );
  });

  it("reads back the parent prefix verbatim under fresh event ids", async () => {
    const { store, parentId } = await openParent();

    const child = await store.branches.fork({
      from: parentId,
      seq: 3,
      mode: EForkMode.Copy,
    });

    const prefix = await store.log.read({ branchId: parentId, upTo: 3 });
    const copied = await store.log.read({ branchId: child.id });

    expect(shapeOf(copied)).toEqual(shapeOf(prefix));
    expect(copied.map((event) => event.id)).not.toEqual(
      prefix.map((event) => event.id),
    );
    expect(new Set(copied.map((event) => event.id)).size).toBe(3);
  });

  it("carries the bodies across, not just the shape", async () => {
    const { store, parentId } = await openParent();

    const child = await store.branches.fork({
      from: parentId,
      seq: 2,
      mode: EForkMode.Copy,
    });
    const copied = await store.log.read({ branchId: child.id });

    expect(copied[0]).toMatchObject({ type: "user-said", text: "one" });
    expect(copied[1]).toMatchObject({
      type: "assistant-said",
      parts: [{ type: "text", text: "two" }],
    });
  });

  it("carries a row the current schema can no longer read, because a copy is a row copy", async () => {
    const { store, parentId } = await openParent();

    const stale = {
      id: "stale-row",
      branchId: parentId,
      seq: 6,
      runId,
      parentRunId: null,
      depth: 0,
      at: "2026-01-01T00:00:06.000Z",
      type: "user-said",
      body: '{"type":"user-said"}',
      contextSlot: null,
      contextKey: null,
      contextDigest: null,
    };
    await store.prisma.event.create({ data: stale });
    await store.prisma.branch.update({
      where: { id: parentId },
      data: { head: 6 },
    });

    const child = await store.branches.fork({
      from: parentId,
      seq: 6,
      mode: EForkMode.Copy,
    });

    const copied = await store.prisma.event.findMany({
      where: { branchId: child.id },
      orderBy: { seq: "asc" },
    });
    expect(copied).toHaveLength(6);
    expect(copied[5]).toMatchObject({
      seq: 6,
      type: "user-said",
      body: '{"type":"user-said"}',
    });
    expect(copied[5]?.id).not.toBe("stale-row");
  });

  it("continues the sequence above the fork point when the branch is used", async () => {
    const { store, parentId } = await openParent();

    const child = await store.branches.fork({
      from: parentId,
      seq: 3,
      mode: EForkMode.Copy,
    });
    const appended = await store.log.append({
      branchId: child.id,
      runId,
      drafts: [said("elsewhere")],
    });

    expect(appended.map((event) => event.seq)).toEqual([4]);
    expect(shapeOf(await store.log.read({ branchId: child.id }))).toEqual([
      [1, "user-said"],
      [2, "assistant-said"],
      [3, "user-said"],
      [4, "user-said"],
    ]);
    expect(await rowsUnder(store, parentId)).toBe(5);
  });
});

describe("a reference fork", () => {
  it("copies no rows yet reads the inherited prefix", async () => {
    const { store, parentId } = await openParent();

    const child = await store.branches.fork({
      from: parentId,
      seq: 3,
      mode: EForkMode.Reference,
    });

    expect(await rowsUnder(store, child.id)).toBe(0);
    expect(shapeOf(await store.log.read({ branchId: child.id }))).toEqual([
      [1, "user-said"],
      [2, "assistant-said"],
      [3, "user-said"],
    ]);
  });

  it("owns nothing of its own until it is written to", async () => {
    const { store, parentId } = await openParent();

    const child = await store.branches.fork({
      from: parentId,
      seq: 3,
      mode: EForkMode.Reference,
    });

    expect(await store.log.readOwn({ branchId: child.id })).toEqual([]);

    await store.log.append({
      branchId: child.id,
      runId,
      drafts: [said("sub-agent turn")],
    });

    expect(shapeOf(await store.log.readOwn({ branchId: child.id }))).toEqual([
      [4, "user-said"],
    ]);
  });

  it("numbers its own rows above the fork point and stays ordered when composed", async () => {
    const { store, parentId } = await openParent();

    const child = await store.branches.fork({
      from: parentId,
      seq: 3,
      mode: EForkMode.Reference,
    });
    const appended = await store.log.append({
      branchId: child.id,
      runId,
      drafts: [said("sub-agent turn"), replied("sub-agent answer")],
    });

    expect(appended.map((event) => event.seq)).toEqual([4, 5]);
    expect(shapeOf(await store.log.read({ branchId: child.id }))).toEqual([
      [1, "user-said"],
      [2, "assistant-said"],
      [3, "user-said"],
      [4, "user-said"],
      [5, "assistant-said"],
    ]);
    expect(await rowsUnder(store, parentId)).toBe(5);
  });

  it("clamps the inherited prefix to the upTo the caller asked for", async () => {
    const { store, parentId } = await openParent();

    const child = await store.branches.fork({
      from: parentId,
      seq: 3,
      mode: EForkMode.Reference,
    });
    await store.log.append({
      branchId: child.id,
      runId,
      drafts: [said("sub-agent turn")],
    });

    expect(
      shapeOf(await store.log.read({ branchId: child.id, upTo: 2 })),
    ).toEqual([
      [1, "user-said"],
      [2, "assistant-said"],
    ]);
  });

  it("composes through a short chain of forks", async () => {
    const { store, parentId } = await openParent();

    const first = await store.branches.fork({
      from: parentId,
      seq: 2,
      mode: EForkMode.Reference,
    });
    await store.log.append({
      branchId: first.id,
      runId,
      drafts: [said("nested once")],
    });
    const second = await store.branches.fork({
      from: first.id,
      seq: 3,
      mode: EForkMode.Reference,
    });
    await store.log.append({
      branchId: second.id,
      runId,
      drafts: [said("nested twice")],
    });

    expect(shapeOf(await store.log.read({ branchId: second.id }))).toEqual([
      [1, "user-said"],
      [2, "assistant-said"],
      [3, "user-said"],
      [4, "user-said"],
    ]);
    expect(shapeOf(await store.log.readOwn({ branchId: second.id }))).toEqual([
      [4, "user-said"],
    ]);
  });

  it("refuses to read a chain deeper than Atlas supports", async () => {
    const { store, parentId } = await openParent();

    let from = parentId;
    for (let depth = 0; depth < 9; depth += 1) {
      const forked = await store.branches.fork({
        from,
        seq: 1,
        mode: EForkMode.Reference,
      });
      from = forked.id;
    }

    await expect(store.log.read({ branchId: from })).rejects.toThrow(
      /reference forks/i,
    );
  });
});

describe("forking refuses what it cannot honour", () => {
  it("rejects a source branch that does not exist", async () => {
    const { store } = await openParent();

    await expect(
      store.branches.fork({
        from: toBranchId("no-such-branch"),
        seq: 0,
        mode: EForkMode.Copy,
      }),
    ).rejects.toBeInstanceOf(ForkSourceMissing);
  });

  it("rejects a sequence the source never reached", async () => {
    const { store, parentId } = await openParent();

    await expect(
      store.branches.fork({
        from: parentId,
        seq: 9,
        mode: EForkMode.Reference,
      }),
    ).rejects.toBeInstanceOf(ForkSeqOutOfRange);
  });
});

describe("rewinding a fork", () => {
  it("truncates the fork and leaves the parent whole", async () => {
    const { store, parentId } = await openParent();

    const child = await store.branches.fork({
      from: parentId,
      seq: 3,
      mode: EForkMode.Copy,
    });
    await store.log.append({
      branchId: child.id,
      runId,
      drafts: [said("elsewhere")],
    });

    const result = await rewindBranch({
      log: store.log,
      branches: store.branches,
      branchId: child.id,
      toSeq: 2,
    });

    expect(result).toEqual({ ok: true, discarded: 2 });
    expect(shapeOf(await store.log.read({ branchId: child.id }))).toEqual([
      [1, "user-said"],
      [2, "assistant-said"],
    ]);
    expect(await rowsUnder(store, parentId)).toBe(5);
    expect(await store.log.head({ branchId: parentId })).toBe(5);
  });

  it("leaves a reference fork holding only the inherited prefix", async () => {
    const { store, parentId } = await openParent();

    const child = await store.branches.fork({
      from: parentId,
      seq: 3,
      mode: EForkMode.Reference,
    });
    await store.log.append({
      branchId: child.id,
      runId,
      drafts: [said("sub-agent turn")],
    });

    await rewindBranch({
      log: store.log,
      branches: store.branches,
      branchId: child.id,
      toSeq: 3,
    });

    expect(await store.log.readOwn({ branchId: child.id })).toEqual([]);
    expect(shapeOf(await store.log.read({ branchId: child.id }))).toHaveLength(
      3,
    );
    expect(await rowsUnder(store, parentId)).toBe(5);
  });
});
