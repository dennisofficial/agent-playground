import path from "node:path";
import { mkdir } from "node:fs/promises";
import { test, expect, type Page, type BrowserContext, type Locator, type ElementHandle } from "@playwright/test";

/**
 * Regression for the job-workspace transcript fighting the user's scroll (Thread 1).
 *
 * Two independent root causes live in the shared scroll machinery under
 * `web/src/features/job-workspace/`:
 *   - Cause B (@tanstack/virtual-core skips scroll compensation when a row ABOVE the viewport
 *     re-measures while scrolling up) — a mounted row's VIEWPORT position lurches down.
 *   - Cause A (useTailFollow auto-pins to the bottom mid-stream while its "stuck" ref is stale) —
 *     an upward scroll is yanked back to the tail.
 *
 * Test 1 is the Cause-B discriminator: it asserts a still-mounted anchor's viewport position moves
 * ONLY by the user's commanded scroll (re-measures above are compensated into scrollTop), NOT by the
 * hundreds-of-px residual the broken code lets leak through. It runs at desktop (wheel) and mobile
 * (native touch-drag). Test 2 is the Cause-A park/jump guard.
 *
 * Data: the curated real-transcript fixture in the rich job (loaded by `seed:scroll-fixture`).
 */

const DEV_EMAIL = process.env.ADMIN_SEED_EMAIL ?? "admin@atlas.dev";
const DEV_PASSWORD = process.env.ADMIN_SEED_PASSWORD;

const ORG_ID = "e9af869c-309a-466e-ba1b-51b870106b3f";
const REPO_ID = "63ad1635-966a-427f-8e52-9cc8a8ecfc8b";
const RICH_JOB_ID = "da700000-0000-4000-8000-000000000104";
const RICH_PATH = `/workspace/${ORG_ID}~${REPO_ID}~${RICH_JOB_ID}`;

const AUTH_FILE = path.join(__dirname, ".auth", "scroll-user.json");

// Cause-B tolerance. During slow continuous scroll the anchor's per-frame `rect.top` change is a
// handful of px (the scroll rate). On broken code an uncompensated above-viewport re-measure makes it
// jump by 100-366px (desktop) / hundreds-to-thousands (baseline) in a single frame. 90px sits well
// above the steady scroll rate and well below the broken spike, separating the regimes cleanly.
const MAX_JUMP_PX = 90;

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

type Box = { top: number; left: number; width: number; height: number };

/** Tag the tallest scroll container on the page and return a handle + its box. */
async function findScrollContainer(page: Page): Promise<{ handle: Locator; box: Box }> {
  await page.evaluate(() => {
    let best: Element | null = null;
    let bestDelta = 0;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const cs = getComputedStyle(el);
      if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
        const delta = el.scrollHeight - el.clientHeight;
        if (delta > bestDelta) {
          bestDelta = delta;
          best = el;
        }
      }
    }
    if (best) best.setAttribute("data-scroll-container", "1");
  });
  const handle = page.locator('[data-scroll-container="1"]').first();
  await expect(handle).toHaveCount(1);
  const box = await handle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  });
  return { handle, box };
}

/**
 * The long transcript hydrates progressively — its scrollHeight keeps growing for a while after load.
 * Wait until it settles so the re-measure dynamics match a real, fully-loaded transcript (a partially
 * hydrated container reproduces the bug unreliably). Returns the settled scrollHeight.
 */
async function waitForStableScrollHeight(container: Locator, page: Page): Promise<number> {
  let last = -1;
  let stableReads = 0;
  for (let i = 0; i < 30 && stableReads < 3; i++) {
    const sh = await container.evaluate((el) => el.scrollHeight);
    stableReads = sh === last ? stableReads + 1 : 0;
    last = sh;
    await page.waitForTimeout(300);
  }
  return last;
}

/**
 * Cause-B core measurement. Scroll UP slowly and CONTINUOUSLY through a re-measurement-heavy region
 * (thousands of variable-height rows + the async mermaid SVG landing) while an in-page requestAnimation-
 * Frame loop samples a still-mounted anchor's `rect.top` every frame. Continuous scrolling keeps
 * `scrollDirection === 'backward'` alive the whole time, so an above-viewport re-measure is NOT
 * self-corrected before it's observed. During steady slow scroll the anchor's `rect.top` changes by
 * only the small per-frame scroll amount; an UNCOMPENSATED re-measure (the bug) makes it JUMP by
 * hundreds of px in a single frame. We report the max single-frame `|Δrect.top|` — the discriminator —
 * plus a churn witness (scrollHeight change) to guard against a vacuous pass. (Node-side per-sample
 * reads are too slow: the jump is a sub-40ms transient that native scroll-anchoring pulls back, so
 * sampling must run in the page.)
 */
async function measureAnchorDrift(
  page: Page,
  containerEl: ElementHandle<Element>,
  anchorEl: ElementHandle<Element>,
  wheelUp: () => Promise<void>,
  wheels: number,
): Promise<{ maxJump: number; scrollHeightDelta: number }> {
  const shBefore = await containerEl.evaluate((el) => el.scrollHeight);
  // Kick off the in-page sampler; it runs independently while we fire wheels below.
  const samplerPromise: Promise<number[]> = anchorEl.evaluate(
    (el, ms) =>
      new Promise<number[]>((resolve) => {
        const tops: number[] = [];
        const t0 = performance.now();
        const tick = () => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width || r.height) tops.push(r.top);
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve(tops);
        };
        requestAnimationFrame(tick);
      }),
    wheels * 30 + 500,
  );
  for (let i = 0; i < wheels; i++) {
    await wheelUp();
    await page.waitForTimeout(15);
  }
  const tops = await samplerPromise;
  let maxJump = 0;
  for (let i = 1; i < tops.length; i++) {
    const jump = Math.abs(tops[i] - tops[i - 1]);
    if (jump > maxJump) maxJump = jump;
  }
  const shAfter = await containerEl.evaluate((el) => el.scrollHeight);
  console.log(`[drift] samples=${tops.length} maxJump=${Math.round(maxJump)}`);
  return { maxJump, scrollHeightDelta: Math.abs(shAfter - shBefore) };
}

/** Pick a stable, text-bearing element at the middle of the scroll container's viewport. */
async function anchorAtMidViewport(page: Page, box: Box): Promise<Locator> {
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      let node: Element | null = el;
      while (node && (!node.textContent || node.textContent.trim().length < 3)) {
        node = node.parentElement;
      }
      (node ?? el)?.setAttribute("data-anchor", "1");
    },
    { x, y },
  );
  return page.locator('[data-anchor="1"]').first();
}

test.describe("desktop transcript scroll (1440x900, wheel)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false, storageState: AUTH_FILE });

  test("Cause B: a mounted anchor's viewport position stays stable through above-viewport re-measures", async ({
    page,
  }) => {
    test.setTimeout(150_000); // dense high-frequency sampling over many increments is slow
    await page.goto(RICH_PATH, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000); // let the long transcript hydrate

    const { handle: container, box } = await findScrollContainer(page);
    const sh = await waitForStableScrollHeight(container, page);
    expect(sh).toBeGreaterThan(box.height * 5); // genuinely long / virtualized

    // Settle into a re-measurement-heavy region ABOVE the async mermaid diagram, then let it measure.
    await container.evaluate((el, t) => (el.scrollTop = t), Math.floor(sh * 0.32));
    await page.waitForTimeout(1500);

    const anchor = await anchorAtMidViewport(page, box);
    await expect(anchor).toHaveCount(1);
    console.log(`[anchor] sh=${sh} ${JSON.stringify((await anchor.textContent())?.slice(0, 40))}`);

    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    await page.mouse.move(cx, cy);

    const containerEl = (await container.elementHandle())!;
    const anchorEl = (await anchor.elementHandle())!;
    const { maxJump, scrollHeightDelta } = await measureAnchorDrift(
      page,
      containerEl,
      anchorEl,
      // Real wheel-driven backward scroll — leaves the browser's own scroll behavior intact (a
      // programmatic scrollTop set triggers native scroll-anchoring that masks the bug).
      async () => {
        await page.mouse.wheel(0, -18);
      },
      90,
    );

    await shot(page, "fixed-desktop-anchor-stable");
    console.log(`[cause-b desktop] maxJump=${Math.round(maxJump)} scrollHeightDelta=${scrollHeightDelta}`);
    // Vacuous-pass guard: the region actually churned (rows re-measured) during the scroll.
    expect(scrollHeightDelta).toBeGreaterThan(0);
    expect(maxJump, `anchor single-frame rect.top jump ${Math.round(maxJump)}px (broken: hundreds)`).toBeLessThan(
      MAX_JUMP_PX,
    );
  });
});

test.describe("mobile transcript scroll (390x844, touch)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: AUTH_FILE });

  test("Cause B: a mounted anchor's viewport position stays stable during touch-drag up", async ({ page, context }) => {
    test.setTimeout(150_000); // native touch-drag + dense sampling over many increments is slow
    await page.goto(RICH_PATH, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    const { handle: container, box } = await findScrollContainer(page);
    const sh = await waitForStableScrollHeight(container, page);
    expect(sh).toBeGreaterThan(box.height * 5);

    await container.evaluate((el, t) => (el.scrollTop = t), Math.floor(sh * 0.32));
    await page.waitForTimeout(1500);

    const anchor = await anchorAtMidViewport(page, box);
    await expect(anchor).toHaveCount(1);

    // Native touch-drag via CDP: dragging the finger DOWN scrolls content UP (scrollTop decreases).
    // Each call is a short drag; fired back-to-back they keep the backward scroll continuous.
    const cdp = await context.newCDPSession(page);
    const cx = box.left + box.width / 2;
    const dragStartY = box.top + box.height * 0.3;

    const containerEl = (await container.elementHandle())!;
    const anchorEl = (await anchor.elementHandle())!;
    const { maxJump, scrollHeightDelta } = await measureAnchorDrift(
      page,
      containerEl,
      anchorEl,
      async () => {
        const dist = 18;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: dragStartY }] });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: cx, y: dragStartY + dist }],
        });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      },
      90,
    );

    await shot(page, "fixed-mobile-anchor-stable");
    expect(scrollHeightDelta).toBeGreaterThan(0);
    expect(maxJump, `anchor single-frame rect.top jump ${Math.round(maxJump)}px (broken: hundreds)`).toBeLessThan(
      MAX_JUMP_PX,
    );
  });

  test("Cause A guard: scrolling up parks and surfaces Jump to latest, then the pill returns to tail", async ({
    page,
    context,
  }) => {
    await page.goto(RICH_PATH, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const { handle: container, box } = await findScrollContainer(page);
    // Pin to the bottom (tail).
    await container.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(500);

    const cdp = await context.newCDPSession(page);
    const cx = box.left + box.width / 2;
    const startY = box.top + box.height * 0.35;
    // Touch-drag DOWN => scroll content UP off the tail.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: startY }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: cx, y: startY + (300 * i) / 12 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    const pill = page.getByRole("button", { name: /Jump to latest/i });
    await expect(pill).toBeVisible();

    // The view must NOT auto-return to the bottom while parked.
    const parkedTop = await container.evaluate((el) => el.scrollTop);
    await page.waitForTimeout(700);
    const stillParkedTop = await container.evaluate((el) => el.scrollTop);
    const atBottom = await container.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    expect(atBottom).toBe(false);
    expect(Math.abs(stillParkedTop - parkedTop)).toBeLessThan(50);
    await shot(page, "fixed-mobile-parked-jump-pill");

    // Clicking the pill returns to the tail and hides the pill.
    await pill.click();
    await page.waitForTimeout(800);
    const backAtBottom = await container.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    expect(backAtBottom).toBe(true);
    await expect(pill).toBeHidden();
  });
});
