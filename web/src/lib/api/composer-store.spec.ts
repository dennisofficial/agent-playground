import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerStore } from "./composer-store";
import type { JobRef } from "./job-api";

// The store is a module-global singleton, so each test uses a unique jobId to stay isolated.
const KEY_PREFIX = "atlas.composer.draft.";
const refFor = (jobId: string): JobRef => ({
  orgId: "org1",
  repoId: "repo1",
  jobId,
});

/** Minimal Map-backed `sessionStorage` — the vitest env is `node`, so there's no real `window`. */
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

let storage: Storage;

beforeEach(() => {
  storage = makeStorage();
  vi.stubGlobal("window", { sessionStorage: storage });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("composerStore", () => {
  it("setText is reflected by getDraft", () => {
    const ref = refFor("job-set-text");
    composerStore.setText(ref, "hello world");
    expect(composerStore.getDraft(ref.jobId).text).toBe("hello world");
  });

  it("isolates drafts per jobId (no bleed between Jobs)", () => {
    const a = refFor("job-iso-a");
    const b = refFor("job-iso-b");
    composerStore.setText(a, "draft for A");
    expect(composerStore.getDraft(a.jobId).text).toBe("draft for A");
    // Job B was never written — its draft stays empty.
    expect(composerStore.getDraft(b.jobId).text).toBe("");
  });

  it("debounces a sessionStorage write after setText", () => {
    const ref = refFor("job-persist");
    composerStore.setText(ref, "persist me");
    // Nothing written yet — the write is debounced.
    expect(storage.getItem(KEY_PREFIX + ref.jobId)).toBeNull();
    vi.advanceTimersByTime(300);
    const raw = storage.getItem(KEY_PREFIX + ref.jobId);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ text: "persist me" });
  });

  it("clearDraft removes the persisted entry and empties the draft", () => {
    const ref = refFor("job-clear");
    composerStore.setText(ref, "to be cleared");
    vi.advanceTimersByTime(300);
    expect(storage.getItem(KEY_PREFIX + ref.jobId)).not.toBeNull();

    composerStore.clearDraft(ref.jobId);
    expect(composerStore.getDraft(ref.jobId).text).toBe("");
    expect(storage.getItem(KEY_PREFIX + ref.jobId)).toBeNull();
  });

  it("hydrates text + comments from a pre-seeded sessionStorage key", () => {
    const ref = refFor("job-hydrate");
    const comment = {
      id: "c1",
      file: { node: "n1", label: "file.ts" },
      quote: "some code",
      note: "fix this",
    };
    storage.setItem(
      KEY_PREFIX + ref.jobId,
      JSON.stringify({
        ref,
        text: "restored draft",
        comments: [comment],
        outbox: [],
      }),
    );

    composerStore.ensure(ref);
    const draft = composerStore.getDraft(ref.jobId);
    expect(draft.text).toBe("restored draft");
    expect(draft.comments).toEqual([comment]);
    // Attachments never persist — they come back empty.
    expect(draft.attachments).toEqual([]);
  });

  it("setComments persists comment metadata (debounced)", () => {
    const ref = refFor("job-comments");
    const comment = {
      id: "c9",
      file: { node: "n9", label: "a.ts" },
      quote: "q",
      note: "",
    };
    composerStore.setComments(ref, () => [comment]);
    expect(composerStore.getDraft(ref.jobId).comments).toEqual([comment]);
    vi.advanceTimersByTime(300);
    const raw = storage.getItem(KEY_PREFIX + ref.jobId);
    expect(JSON.parse(raw as string).comments).toEqual([comment]);
  });
});
