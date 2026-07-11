import path from "node:path";
import { mkdir } from "node:fs/promises";
import { test, expect, type Page, type BrowserContext, type Locator } from "@playwright/test";
import { encodeJobRef } from "@/lib/routes";

/**
 * Live validation for the three mobile UI fixes. The touch block runs under a REAL touch/mobile
 * emulation (isMobile + hasTouch → Chromium reports `(pointer: coarse)` + `(hover: none)`), so the
 * fixes — which are gated on exactly those media features — actually engage. The desktop block runs a
 * fine-pointer / hover-capable context to prove desktop is unaffected. (The existing responsive.spec.ts
 * uses Desktop Chrome only, so it never exercises the coarse-pointer / hover:none paths.)
 */

const DEV_EMAIL = process.env.ADMIN_SEED_EMAIL ?? "admin@atlas.dev";
const DEV_PASSWORD = process.env.ADMIN_SEED_PASSWORD;

const ORG_ID = "e9af869c-309a-466e-ba1b-51b870106b3f";
const REPO_ID = "63ad1635-966a-427f-8e52-9cc8a8ecfc8b";
const RICH_JOB_ID = "da700000-0000-4000-8000-000000000104";
const WORKSPACE_PATH = `/workspace/${encodeJobRef({ orgId: ORG_ID, repoId: REPO_ID, jobId: RICH_JOB_ID })}`;

const AUTH_FILE = path.join(__dirname, ".auth", "mobile-user.json");

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
const opacity = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).opacity);
const fontSize = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).fontSize);

test.describe("touch / mobile (pointer: coarse, hover: none)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: AUTH_FILE });

  test("device really reports coarse pointer + no hover", async ({ page }) => {
    await page.goto(WORKSPACE_PATH);
    const mq = await page.evaluate(() => ({
      coarse: matchMedia("(pointer: coarse)").matches,
      noHover: matchMedia("(hover: none)").matches,
    }));
    expect(mq).toEqual({ coarse: true, noHover: true });
  });

  test("Bug 3: composer input is floored at 16px (stops iOS zoom-on-focus)", async ({ page }) => {
    await page.goto(WORKSPACE_PATH);
    const ta = page.locator("textarea").first();
    await expect(ta).toBeVisible({ timeout: 20_000 });
    expect(await fontSize(ta)).toBe("16px");
    await shot(page, "mobile-composer-16px");
  });

  test("Bug 1: usage popup stays within the viewport", async ({ page }) => {
    await page.goto(WORKSPACE_PATH);
    const trigger = page.getByRole("button", { name: "Claude subscription usage" });
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await trigger.click();
    const panel = page
      .locator("div.absolute.bottom-full")
      .filter({ hasText: /resets|Updated|usage|Session|no data/i })
      .first();
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    const vw = page.viewportSize()!.width;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 0.5);
    await shot(page, "mobile-usage-popup");
  });

  test("Bug 2: sidebar org action icons are visible without hover", async ({ page }) => {
    await page.goto(WORKSPACE_PATH);
    const hamburger = page.getByRole("button", { name: "Open navigation" });
    await expect(hamburger).toBeVisible({ timeout: 20_000 });
    await hamburger.click();
    const nav = page.getByRole("dialog", { name: "Navigation" });
    await expect(nav).toBeVisible();
    const orgNew = nav.getByRole("link", { name: /^New job in / }).first();
    const orgSettings = nav.getByRole("link", { name: / settings$/ }).first();
    await expect(orgNew).toBeVisible();
    expect(Number(await opacity(orgNew))).toBeGreaterThan(0.5);
    expect(Number(await opacity(orgSettings))).toBeGreaterThan(0.5);
    await shot(page, "mobile-sidebar-icons");
  });
});

test.describe("desktop / fine pointer (unaffected)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false, storageState: AUTH_FILE });

  test("Bug 3: coarse-pointer floor does NOT apply — composer stays 13.5px", async ({ page }) => {
    await page.goto(WORKSPACE_PATH);
    const mq = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    expect(mq).toBe(false);
    const ta = page.locator("textarea").first();
    await expect(ta).toBeVisible({ timeout: 20_000 });
    expect(await fontSize(ta)).toBe("13.5px");
  });
});
