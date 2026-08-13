import { describe, expect, it } from "bun:test";
import type { AccountVaultService } from "../../auth/account-vault.service.js";
import type { EngineHomeService } from "../../auth/engine-home.service.js";
import type { AskArgs, ClaudeOneShotService } from "../../engine/one-shot.service.js";
import type { JobRepository } from "../../store/job.repository.js";
import { JobTitleService } from "../job-title.service.js";

/**
 * Naming a job after it exists, and renaming one by hand.
 *
 * The two writers race by construction — the titler runs beside the job's first turn — so most of
 * what is pinned here is who wins: the human, always, and never by a read the service does itself.
 */

const ENV = { CLAUDE_CONFIG_DIR: "/tmp/claude", CLAUDE_CODE_OAUTH_TOKEN: "tok" };

function build(answer: string | undefined) {
  const asked: AskArgs[] = [];
  const retitles: { jobId: string; title: string; ifTitle: string }[] = [];
  const renames: { jobId: string; title: string }[] = [];
  /** Whose credential the ask ran under — a title is billed where the work is. */
  const claimed: string[] = [];
  let applies = true;

  const jobRepository = {
    async retitle(args: {
      jobId: string;
      title: string;
      ifTitle: string;
    }): Promise<boolean> {
      retitles.push(args);
      return applies;
    },
    async setTitle(args: { jobId: string; title: string }): Promise<void> {
      renames.push(args);
    },
  } as unknown as JobRepository;

  const accountVaultService = {
    async freshCredential(accountId: string): Promise<{ id: string }> {
      return { id: accountId };
    },
  } as unknown as AccountVaultService;

  const engineHomeService = {
    async claim<T>(
      args: { accountId: string },
      start: (env: Record<string, string>) => T,
    ): Promise<T> {
      claimed.push(args.accountId);
      return start(ENV);
    },
  } as unknown as EngineHomeService;

  const claudeOneShotService = {
    ask(args: AskArgs): Promise<string | undefined> {
      asked.push(args);
      return Promise.resolve(answer);
    },
  } as unknown as ClaudeOneShotService;

  const service = new JobTitleService(
    jobRepository,
    accountVaultService,
    engineHomeService,
    claudeOneShotService,
  );

  return {
    service,
    asked,
    retitles,
    renames,
    claimed,
    /** The next `retitle` reports that somebody else had already named the job. */
    loseTheRace: (): void => {
      applies = false;
    },
  };
}

/** `name` is fire-and-forget by design, so a test has to wait for the microtasks behind it. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("naming a job from its first message", () => {
  it("writes the model's title over the derived one, guarded by the derived one", async () => {
    const t = build("Avatar Upload Resizing");
    t.service.name({
      jobId: "job-1",
      accountId: "account-1",
      cwd: "/repo",
      firstMessage: "add avatar upload, it should resize to 512px",
      derived: "add avatar upload",
    });
    await settle();

    expect(t.retitles).toEqual([
      { jobId: "job-1", title: "Avatar Upload Resizing", ifTitle: "add avatar upload" },
    ]);
    expect(t.claimed).toEqual(["account-1"]);
    expect(t.asked[0]?.prompt).toContain("add avatar upload, it should resize to 512px");
    expect(t.asked[0]?.env).toEqual(ENV);
  });

  it("publishes the new title, so a header already on screen moves with it", async () => {
    const t = build("Avatar Upload Resizing");
    let notified = 0;
    t.service.subscribe(() => {
      notified += 1;
    });

    t.service.name({
      jobId: "job-1",
      accountId: "account-1",
      cwd: "/repo",
      firstMessage: "add avatar upload",
      derived: "add avatar upload",
    });
    await settle();

    expect(t.service.titleOf("job-1")).toBe("Avatar Upload Resizing");
    expect(notified).toBe(1);
  });

  it("says nothing about a job it did not rename — a miss means the row on hand is right", () => {
    const t = build(undefined);
    expect(t.service.titleOf("job-1")).toBeUndefined();
  });

  it("keeps the derived title when the model refuses", async () => {
    const t = build("I'm sorry, I can't help with that");
    t.service.name({
      jobId: "job-1",
      accountId: "account-1",
      cwd: "/repo",
      firstMessage: "rm -rf everything",
      derived: "rm -rf everything",
    });
    await settle();

    expect(t.retitles).toEqual([]);
    expect(t.service.titleOf("job-1")).toBeUndefined();
  });

  it("keeps the derived title when the ask fails outright", async () => {
    const t = build(undefined);
    t.service.name({
      jobId: "job-1",
      accountId: "account-1",
      cwd: "/repo",
      firstMessage: "why is the build red",
      derived: "why is the build red",
    });
    await settle();

    expect(t.retitles).toEqual([]);
  });

  it("does not write a title identical to the one the job already wears", async () => {
    const t = build("add avatar upload");
    t.service.name({
      jobId: "job-1",
      accountId: "account-1",
      cwd: "/repo",
      firstMessage: "add avatar upload",
      derived: "add avatar upload",
    });
    await settle();

    expect(t.retitles).toEqual([]);
  });

  it("shows nothing when the write was refused — a rename got there first", async () => {
    const t = build("Avatar Upload Resizing");
    t.loseTheRace();

    t.service.name({
      jobId: "job-1",
      accountId: "account-1",
      cwd: "/repo",
      firstMessage: "add avatar upload",
      derived: "add avatar upload",
    });
    await settle();

    // The database kept the human's name, so the screen must not show the model's.
    expect(t.retitles).toHaveLength(1);
    expect(t.service.titleOf("job-1")).toBeUndefined();
  });
});

describe("renaming a job by hand", () => {
  it("writes unconditionally — the human's name is the last word", async () => {
    const t = build(undefined);

    const title = await t.service.rename({ jobId: "job-1", title: "  avatar   upload  " });

    expect(title).toBe("avatar upload");
    expect(t.renames).toEqual([{ jobId: "job-1", title: "avatar upload" }]);
    expect(t.service.titleOf("job-1")).toBe("avatar upload");
  });

  it("refuses a blank name rather than leaving a row nothing to draw", async () => {
    const t = build(undefined);

    expect(t.service.rename({ jobId: "job-1", title: "   " })).rejects.toThrow(/needs a name/);
    expect(t.renames).toEqual([]);
  });
});
