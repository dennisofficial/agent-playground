import path from "node:path";
import { mkdir } from "node:fs/promises";
import { test, expect, type Page, type BrowserContext, type Locator } from "@playwright/test";
import { encodeJobRef } from "@/lib/routes";

/**
 * Live validation for two mobile layout fixes:
 *   1. The blocked-job banner (BlockedOverlay) must SCROLL when its "when this unblocks" seed preview
 *      is taller than the viewport, instead of clipping under the overflow-hidden app <main>.
 *   2. The New-job create modal (Modal shell for the intercepted /new route) must be FULLSCREEN on
 *      mobile with a scrollable body, so the "Create Job" button is always reachable (never clipped).
 *
 * The mobile block runs under real touch/mobile emulation at a 390px phone viewport (matching
 * mobile-touch-fixes.spec.ts). The desktop block proves the fullscreen treatment is mobile-only.
 * Both rely on the standalone `backend/scripts/seed-job-relationships.ts` fixture, whose BLOCKED job
 * carries a deliberately long multi-paragraph seed message so the overlay actually overflows.
 */

const DEV_EMAIL = process.env.ADMIN_SEED_EMAIL ?? "admin@atlas.dev";
const DEV_PASSWORD = process.env.ADMIN_SEED_PASSWORD;

const ORG_ID = "e9af869c-309a-466e-ba1b-51b870106b3f";
const REPO_ID = "63ad1635-966a-427f-8e52-9cc8a8ecfc8b";
// The seeded BLOCKED job from scripts/seed-job-relationships.ts (id('06')).
const BLOCKED_JOB_ID = "bb000000-0000-4000-8000-000000000006";
const BLOCKED_PATH = `/workspace/${encodeJobRef({ orgId: ORG_ID, repoId: REPO_ID, jobId: BLOCKED_JOB_ID })}`;

const AUTH_FILE = path.join(__dirname, ".auth", "scroll-user.json");

test.beforeAll(async ({ browser, baseURL }) => {
  if (!DEV_PASSWORD) throw new Error("ADMIN_SEED_PASSWORD is required for auth.");
  const context: BrowserContext = await browser.newContext({ baseURL, storageState: undefined });
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
  await mkdir("/context/artifacts", { recursive: true });
  await page.screenshot({ path: `/context/artifacts/${name}.png`, fullPage: false });
}

/** Walk up from an element to the nearest ancestor that actually scrolls, and report its metrics. */
const scrollMetrics = (loc: Locator) =>
  loc.evaluate((start) => {
    let el: HTMLElement | null = start as HTMLElement;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
        return {
          overflowY: oy,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          found: true,
        };
      }
      el = el.parentElement;
    }
    return { overflowY: "", scrollHeight: 0, clientHeight: 0, found: false };
  });

test.describe("mobile blocked banner + create modal (390px, touch)", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    storageState: AUTH_FILE,
  });

  test("blocked banner scrolls its long seed preview instead of clipping", async ({ page }) => {
    await page.goto(BLOCKED_PATH);
    const heading = page.getByText("This job is blocked", { exact: true });
    await expect(heading).toBeVisible({ timeout: 20_000 });

    // The overlay must have a real scroll container capped at ~70vh whose content overflows.
    const metrics = await scrollMetrics(heading);
    expect(metrics.found).toBe(true);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.clientHeight).toBeLessThanOrEqual(844 * 0.7 + 2);

    // The "Unblock now" action lives at the bottom of the banner — it must be reachable by scrolling.
    const unblock = page.getByRole("button", { name: /Unblock now/i });
    await unblock.scrollIntoViewIfNeeded();
    await expect(unblock).toBeInViewport();
    await shot(page, "mobile-blocked-banner-scrolled");
  });

  test("new-job create modal is fullscreen with a reachable Create Job button", async ({ page }) => {
    await page.goto(BLOCKED_PATH);
    const hamburger = page.getByRole("button", { name: "Open navigation" });
    await expect(hamburger).toBeVisible({ timeout: 20_000 });
    await hamburger.click();
    const nav = page.getByRole("dialog", { name: "Navigation" });
    await expect(nav).toBeVisible();
    await nav.getByRole("link", { name: /^New job in / }).first().click();

    const dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("heading", { name: "New job" }) });
    await expect(dialog).toBeVisible();
    // The dialog mounts with the house `anim-pop` entrance animation (0.18s scale(0.96) -> scale(1));
    // wait it out so the bounding-box read below isn't taken mid-animation (which would report a
    // scaled-down, slightly offset box and flake this assertion).
    await page.waitForTimeout(300);

    // Fullscreen: the dialog fills the whole viewport (no centered card / top offset on mobile).
    const box = await dialog.boundingBox();
    const vw = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeLessThanOrEqual(1);
    expect(box!.y).toBeLessThanOrEqual(1);
    expect(box!.width).toBeGreaterThanOrEqual(vw.width - 1);
    expect(box!.height).toBeGreaterThanOrEqual(vw.height - 1);

    // The body scrolls, so the submit button is reachable and inside the viewport.
    const createBtn = page.getByRole("button", { name: /Create Job/i });
    await createBtn.scrollIntoViewIfNeeded();
    await expect(createBtn).toBeInViewport();
    await shot(page, "mobile-create-modal-fullscreen");
  });
});

test.describe("desktop (unaffected — modal stays a centered card)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false, storageState: AUTH_FILE });

  test("create modal is a centered card, not fullscreen", async ({ page }) => {
    await page.goto(BLOCKED_PATH);
    // Desktop sidebar exposes the per-org "New job" link directly (no hamburger).
    await page.getByRole("link", { name: /^New job in / }).first().click();
    const dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("heading", { name: "New job" }) });
    await expect(dialog).toBeVisible();
    // Same anim-pop settle as the mobile block above.
    await page.waitForTimeout(300);
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    // A centered card is far narrower than the 1440px viewport (max-w-lg ≈ 512px).
    expect(box!.width).toBeLessThan(700);
    expect(box!.x).toBeGreaterThan(100);
    const createBtn = page.getByRole("button", { name: /Create Job/i });
    await expect(createBtn).toBeVisible();
  });
});
