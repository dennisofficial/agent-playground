import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  test,
  expect,
  type Page,
  type BrowserContext,
} from "@playwright/test";

/**
 * Live end-to-end proof for the retry-recovery UX (Thread 2): while a retry is in flight the working
 * `LiveIndicator` — normally "Atlas is working… · {elapsed} · {statusWord}…" — instead reads
 * "Reconnecting to Claude — auto-retry n/m · retrying in Xs" with a ticking countdown, and reverts the
 * moment a real turn event resumes.
 *
 * The real overloaded/auth/infra trigger is NOT on-demand inducible (an outage), so — exactly as the plan
 * sanctions — we drive a SCRIPTED frame into the REAL client store + REAL component via the dev-only
 * `window.__atlasLiveStream` hook (stripped from prod bundles). This exercises the true reducer + indicator
 * path end-to-end in the running app; only the frame's origin is synthetic.
 *
 * Data: the seeded rich demo job (`seed:scroll-fixture`).
 */

const DEV_EMAIL = process.env.ADMIN_SEED_EMAIL ?? "admin@atlas.dev";
const DEV_PASSWORD = process.env.ADMIN_SEED_PASSWORD;

const ORG_ID = "e9af869c-309a-466e-ba1b-51b870106b3f";
const REPO_ID = "63ad1635-966a-427f-8e52-9cc8a8ecfc8b";
const RICH_JOB_ID = "da700000-0000-4000-8000-000000000104";
const RICH_PATH = `/workspace/${ORG_ID}~${REPO_ID}~${RICH_JOB_ID}`;

const EVIDENCE_DIR = process.env.ATLAS_EVIDENCE_DIR ?? "/context/evidence";
const AUTH_FILE = path.join(__dirname, ".auth", "retry-user.json");

test.beforeAll(async ({ browser, baseURL }) => {
  if (!DEV_PASSWORD) throw new Error("ADMIN_SEED_PASSWORD is required for auth.");
  const context: BrowserContext = await browser.newContext({
    baseURL,
    storageState: undefined,
  });
  const page: Page = await context.newPage();
  await page.goto("/auth/login");
  await page.getByLabel("Email").fill(DEV_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/login"));
  await mkdir(path.dirname(AUTH_FILE), { recursive: true });
  await context.storageState({ path: AUTH_FILE });
  await context.close();
});

async function shot(page: Page, name: string) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE_DIR}/${name}.png`, fullPage: false });
}

/** Inject a scripted stream frame into the REAL client live-turn store via the dev hook. */
async function injectFrame(
  page: Page,
  jobId: string,
  seq: number,
  event: Record<string, unknown>,
) {
  await page.evaluate(
    ({ jobId, seq, event }) => {
      const hook = (
        window as unknown as {
          __atlasLiveStream?: {
            applyStreamFrame: (
              j: string,
              lane: string,
              s: number,
              e: unknown,
            ) => void;
          };
        }
      ).__atlasLiveStream;
      if (!hook) throw new Error("__atlasLiveStream dev hook not present");
      hook.applyStreamFrame(jobId, "main", seq, event);
    },
    { jobId, seq, event },
  );
}

test.describe("live retry indicator (1440x900)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, storageState: AUTH_FILE });

  test("turn_retry shows 'Reconnecting to Claude' with a ticking countdown, then reverts on a real turn event", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto(RICH_PATH, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000); // let the workspace hydrate + realtime cache warm

    // A high seq base so the injected frames always beat anything already applied for this lane.
    const base = 5_000_000;
    // Open a live turn so the indicator mounts (turnActive = active && !realtimeIdle).
    await injectFrame(page, RICH_JOB_ID, base, {
      kind: "turn_start",
      startedAt: Date.now(),
    });
    await injectFrame(page, RICH_JOB_ID, base + 1, {
      kind: "text_delta",
      text: "working…",
    });

    // Now a host-backstop retry: attempt 3/10, next attempt ~9s out.
    await injectFrame(page, RICH_JOB_ID, base + 2, {
      kind: "turn_retry",
      attempt: 3,
      max: 10,
      nextAttemptAt: Date.now() + 9_000,
      reason: "econnreset",
    });

    const reconnecting = page.getByText(/Reconnecting to Claude — auto-retry 3\/10/);
    await expect(reconnecting).toBeVisible();
    // The countdown clause is present with a whole-second value.
    await expect(page.getByText(/retrying in \d+s/)).toBeVisible();
    await shot(page, "retry-indicator-reconnecting");

    // Countdown ticks DOWN and the indicator stays mounted across the backoff wait.
    const readSecs = async (): Promise<number> => {
      const txt = (await reconnecting.textContent()) ?? "";
      const m = txt.match(/retrying in (\d+)s/);
      return m ? Number(m[1]) : NaN;
    };
    const first = await readSecs();
    await page.waitForTimeout(3200);
    await expect(reconnecting).toBeVisible(); // still mounted mid-backoff
    const later = await readSecs();
    expect(later).toBeLessThan(first);

    // A real turn event (the retry succeeded) clears `retrying` → back to the normal working indicator.
    await injectFrame(page, RICH_JOB_ID, base + 3, {
      kind: "text_delta",
      text: "resumed",
    });
    await expect(
      page.getByText(/Reconnecting to Claude/),
    ).toHaveCount(0);
    await shot(page, "retry-indicator-reverted");
  });
});
