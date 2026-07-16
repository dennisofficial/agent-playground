import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerStore, type StagedAnswer } from "./composer-store";
import { getDraft, putDraft, type JobMessage, type JobRef } from "./job-api";

// The store now hydrates + autosaves through `job-api`'s `getDraft`/`putDraft` — mock both so these unit
// tests never make a real network call, and so autosave/hydrate behavior is assertable.
vi.mock("./job-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./job-api")>();
  return {
    ...actual,
    getDraft: vi.fn(() =>
      Promise.resolve({
        payload: { text: "", stagedAnswers: [], comments: [] },
        attachments: [],
      }),
    ),
    putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  };
});

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
  vi.mocked(getDraft).mockClear();
  vi.mocked(putDraft).mockClear();
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

  it("flushDraft writes immediately inside the debounce window", () => {
    const ref = refFor("job-flush");
    composerStore.setText(ref, "save before switch");
    expect(storage.getItem(KEY_PREFIX + ref.jobId)).toBeNull();

    composerStore.flushDraft(ref.jobId);

    const raw = storage.getItem(KEY_PREFIX + ref.jobId);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({
      text: "save before switch",
    });
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

  describe("offline-send outbox", () => {
    it("enqueue then getOutbox returns the item; isolated per jobId", () => {
      const a = refFor("job-outbox-a");
      const b = refFor("job-outbox-b");
      composerStore.enqueue(a, {
        id: "q1",
        createdAt: 1,
        text: "hello",
        comments: [],
        hasAttachments: false,
      });
      expect(composerStore.getOutbox(a.jobId)).toEqual([
        { id: "q1", createdAt: 1, text: "hello", comments: [], hasAttachments: false },
      ]);
      // Job B was never enqueued into — its outbox stays empty.
      expect(composerStore.getOutbox(b.jobId)).toEqual([]);
    });

    it("allQueued() returns every Job's items sorted by createdAt (global FIFO)", () => {
      const a = refFor("job-fifo-a");
      const b = refFor("job-fifo-b");
      composerStore.enqueue(a, {
        id: "later",
        createdAt: 1000,
        text: "from A",
        comments: [],
        hasAttachments: false,
      });
      composerStore.enqueue(b, {
        id: "earlier",
        createdAt: 500,
        text: "from B",
        comments: [],
        hasAttachments: false,
      });
      const all = composerStore
        .allQueued()
        .filter((q) => q.ref.jobId === a.jobId || q.ref.jobId === b.jobId);
      expect(all.map((q) => q.msg.id)).toEqual(["earlier", "later"]);
    });

    it("removeQueued drops the item and persists the removal immediately", () => {
      const ref = refFor("job-remove");
      composerStore.enqueue(ref, {
        id: "q1",
        createdAt: 1,
        text: "keep me queued briefly",
        comments: [],
        hasAttachments: false,
      });
      vi.advanceTimersByTime(300);
      expect(storage.getItem(KEY_PREFIX + ref.jobId)).not.toBeNull();

      composerStore.removeQueued(ref.jobId, "q1");
      expect(composerStore.getOutbox(ref.jobId)).toEqual([]);
      // Nothing left in the draft (no text/comments/outbox) — the persisted blob is removed.
      expect(storage.getItem(KEY_PREFIX + ref.jobId)).toBeNull();
    });

    it("persists a queued message's serializable metadata including the hasAttachments flag", () => {
      const ref = refFor("job-persist-outbox");
      composerStore.enqueue(ref, {
        id: "q1",
        createdAt: 42,
        text: "queued while offline",
        comments: [],
        hasAttachments: true,
      });
      vi.advanceTimersByTime(300);
      const raw = storage.getItem(KEY_PREFIX + ref.jobId);
      expect(raw).not.toBeNull();
      const persisted = JSON.parse(raw as string);
      expect(persisted.outbox).toEqual([
        {
          id: "q1",
          createdAt: 42,
          text: "queued while offline",
          comments: [],
          hasAttachments: true,
        },
      ]);
    });

    it("drops an empty queued item on hydrate; keeps a text survivor", () => {
      const ref = refFor("job-hydrate-outbox");
      storage.setItem(
        KEY_PREFIX + ref.jobId,
        JSON.stringify({
          ref,
          text: "",
          comments: [],
          outbox: [
            { id: "empty-item", createdAt: 1, text: "", comments: [] },
            { id: "text-survivor", createdAt: 2, text: "keep me", comments: [] },
          ],
        }),
      );

      composerStore.ensure(ref);
      const outbox = composerStore.getOutbox(ref.jobId);
      expect(outbox.map((q) => q.id)).toEqual(["text-survivor"]);
      expect(outbox[0]).toMatchObject({ text: "keep me", hasAttachments: false });
    });

    it("clearDraft preserves the outbox (text clears, queued item stays)", () => {
      const ref = refFor("job-clear-preserves-outbox");
      composerStore.setText(ref, "draft text");
      composerStore.enqueue(ref, {
        id: "q1",
        createdAt: 1,
        text: "queued msg",
        comments: [],
        hasAttachments: false,
      });

      composerStore.clearDraft(ref.jobId);
      expect(composerStore.getDraft(ref.jobId).text).toBe("");
      expect(composerStore.getOutbox(ref.jobId)).toEqual([
        { id: "q1", createdAt: 1, text: "queued msg", comments: [], hasAttachments: false },
      ]);

      const raw = storage.getItem(KEY_PREFIX + ref.jobId);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string).outbox).toEqual([
        { id: "q1", createdAt: 1, text: "queued msg", comments: [], hasAttachments: false },
      ]);
    });
  });

  describe("stagedAnswers", () => {
    const questionAnswer: StagedAnswer = {
      kind: "question",
      cardId: "q1",
      label: "Pick a color",
      answer: "blue",
    };
    const fileAnswer: StagedAnswer = {
      kind: "file",
      cardId: "f1",
      label: "config/key.json",
      filename: "key.json",
      content: '{"k":"v"}',
    };
    const secretAnswer: StagedAnswer = {
      kind: "secret",
      cardId: "s1",
      label: "API_KEY",
      value: "sekret",
    };

    function messageFor(card: JobMessage["card"]): JobMessage {
      return {
        ts: "ts1",
        threadId: "t1",
        subagentId: null,
        author: "atlas",
        authorId: "atlas",
        authorName: "Atlas",
        text: "",
        kind: "card",
        source: "atlas",
        card,
        postedAt: new Date().toISOString(),
      };
    }

    it("stageAnswer upserts by cardId (re-staging replaces, not duplicates)", () => {
      const ref = refFor("job-stage-upsert");
      composerStore.stageAnswer(ref, questionAnswer);
      composerStore.stageAnswer(ref, { ...questionAnswer, answer: "red" });
      expect(composerStore.getDraft(ref.jobId).stagedAnswers).toEqual([
        { ...questionAnswer, answer: "red" },
      ]);
    });

    it("stageAnswer never persists to sessionStorage", () => {
      const ref = refFor("job-stage-no-persist");
      composerStore.stageAnswer(ref, fileAnswer);
      vi.advanceTimersByTime(300);
      expect(storage.getItem(KEY_PREFIX + ref.jobId)).toBeNull();
    });

    it("removeStagedAnswer drops just the matching cardId", () => {
      const ref = refFor("job-stage-remove");
      composerStore.stageAnswer(ref, questionAnswer);
      composerStore.stageAnswer(ref, fileAnswer);
      composerStore.removeStagedAnswer(ref, questionAnswer.cardId);
      expect(composerStore.getDraft(ref.jobId).stagedAnswers).toEqual([
        fileAnswer,
      ]);
    });

    it("setStagedAnswers(() => []) clears the tray (Clear all)", () => {
      const ref = refFor("job-stage-clear-all");
      composerStore.stageAnswer(ref, questionAnswer);
      composerStore.stageAnswer(ref, secretAnswer);
      composerStore.setStagedAnswers(ref, () => []);
      expect(composerStore.getDraft(ref.jobId).stagedAnswers).toEqual([]);
    });

    it("pruneStagedAnswers drops a question staged answer once its card is withdrawn", () => {
      const ref = refFor("job-prune-question-withdrawn");
      composerStore.stageAnswer(ref, questionAnswer);
      const messages = [
        messageFor({
          type: "question_card",
          jobId: ref.jobId,
          questionId: "q1",
          question: "Pick a color",
          options: [],
          allowOther: false,
          withdrawnAt: new Date().toISOString(),
        }),
      ];
      composerStore.pruneStagedAnswers(ref, messages);
      expect(composerStore.getDraft(ref.jobId).stagedAnswers).toEqual([]);
    });

    it("pruneStagedAnswers drops a file staged answer once its card is provided", () => {
      const ref = refFor("job-prune-file-provided");
      composerStore.stageAnswer(ref, fileAnswer);
      const messages = [
        messageFor({
          type: "file_request_card",
          jobId: ref.jobId,
          requestId: "f1",
          path: "config/key.json",
          description: "",
          provided_at: new Date().toISOString(),
        }),
      ];
      composerStore.pruneStagedAnswers(ref, messages);
      expect(composerStore.getDraft(ref.jobId).stagedAnswers).toEqual([]);
    });

    it("pruneStagedAnswers drops a secret staged answer once its card is provided", () => {
      const ref = refFor("job-prune-secret-provided");
      composerStore.stageAnswer(ref, secretAnswer);
      const messages = [
        messageFor({
          type: "secret_input_card",
          jobId: ref.jobId,
          requestId: "s1",
          name: "API_KEY",
          description: "",
          provided_at: new Date().toISOString(),
        }),
      ];
      composerStore.pruneStagedAnswers(ref, messages);
      expect(composerStore.getDraft(ref.jobId).stagedAnswers).toEqual([]);
    });

    it("pruneStagedAnswers keeps a staged answer whose card has no match in messages", () => {
      const ref = refFor("job-prune-no-match");
      composerStore.stageAnswer(ref, questionAnswer);
      composerStore.pruneStagedAnswers(ref, []);
      expect(composerStore.getDraft(ref.jobId).stagedAnswers).toEqual([
        questionAnswer,
      ]);
    });

    it("pruneStagedAnswers keeps a staged answer whose card is still open", () => {
      const ref = refFor("job-prune-still-open");
      composerStore.stageAnswer(ref, questionAnswer);
      const messages = [
        messageFor({
          type: "question_card",
          jobId: ref.jobId,
          questionId: "q1",
          question: "Pick a color",
          options: [],
          allowOther: false,
        }),
      ];
      composerStore.pruneStagedAnswers(ref, messages);
      expect(composerStore.getDraft(ref.jobId).stagedAnswers).toEqual([
        questionAnswer,
      ]);
    });
  });

  describe("server sync", () => {
    it("hydrateFromServer folds the GET /draft payload in, overriding the sessionStorage paint", async () => {
      const ref = refFor("job-hydrate-server");
      storage.setItem(
        KEY_PREFIX + ref.jobId,
        JSON.stringify({ ref, text: "stale local", comments: [], outbox: [] }),
      );
      vi.mocked(getDraft).mockResolvedValueOnce({
        payload: { text: "from server", stagedAnswers: [], comments: [] },
        attachments: [{ id: "a1", name: "f.txt", kind: "file", size: 10 }],
      });

      composerStore.ensure(ref);
      // Instant paint is the sessionStorage fallback, read before the GET resolves.
      expect(composerStore.getDraft(ref.jobId).text).toBe("stale local");

      await vi.advanceTimersByTimeAsync(0); // drain the GET's microtask chain
      expect(getDraft).toHaveBeenCalledWith(ref);
      expect(composerStore.getDraft(ref.jobId).text).toBe("from server");
      expect(composerStore.getDraft(ref.jobId).attachments).toEqual([
        { id: "a1", name: "f.txt", kind: "file", size: 10 },
      ]);
    });

    it("debounces a server autosave PUT after setText, sending the current draft body", async () => {
      const ref = refFor("job-autosave");
      composerStore.setText(ref, "autosave me");
      expect(putDraft).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(putDraft).toHaveBeenCalledWith(ref, {
        text: "autosave me",
        stagedAnswers: [],
        comments: [],
      });
    });

    it("applyServerPayload discards a delta older than an in-flight local edit (last-write-wins)", () => {
      const ref = refFor("job-lww-local-wins");
      composerStore.ensure(ref);
      const beforeEdit = Date.now();
      composerStore.setText(ref, "local edit");

      composerStore.applyServerPayload(
        ref.jobId,
        { text: "stale server", stagedAnswers: [], comments: [] },
        [],
        beforeEdit - 1,
      );
      expect(composerStore.getDraft(ref.jobId).text).toBe("local edit");
    });

    it("applyServerPayload accepts a delta newer than the last local edit", () => {
      const ref = refFor("job-lww-server-wins");
      composerStore.ensure(ref);

      composerStore.applyServerPayload(
        ref.jobId,
        { text: "from another device", stagedAnswers: [], comments: [] },
        [],
        Date.now() + 1000,
      );
      expect(composerStore.getDraft(ref.jobId).text).toBe("from another device");
    });
  });
});
