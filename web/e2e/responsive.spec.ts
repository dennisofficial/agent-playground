import { BREAKPOINTS } from '@/hooks/use-breakpoint';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const DEV_EMAIL = process.env.ADMIN_SEED_EMAIL ?? 'admin@atlas.dev';
const DEV_PASSWORD = process.env.ADMIN_SEED_PASSWORD;

const ORG_ID = 'e9af869c-309a-466e-ba1b-51b870106b3f';
const REPO_ID = '63ad1635-966a-427f-8e52-9cc8a8ecfc8b';
const RICH_JOB_ID = 'da700000-0000-4000-8000-000000000104';

const WORKSPACE_PATH = `/jobs/${RICH_JOB_ID}`;
const SETTINGS_PATH = `/orgs/${ORG_ID}/settings?section=general`;

const VIEWPORTS = {
  desktop: { width: BREAKPOINTS.xl + 160, height: 900 }, // 1440 — ≥xl
  laptop: { width: BREAKPOINTS.lg + 96, height: 860 }, // 1120 — lg..xl-1
  tablet: { width: BREAKPOINTS.md + 52, height: 860 }, // 820 — md..lg-1
  mobile: { width: 375, height: 812 }, // <md
} as const;

const AUTH_FILE = path.join(__dirname, '.auth', 'user.json');

test.use({ storageState: AUTH_FILE });

test.beforeAll(async ({ browser, baseURL }) => {
  if (!DEV_PASSWORD) {
    throw new Error(
      'ADMIN_SEED_PASSWORD is required for responsive e2e auth. Run via `pnpm test:e2e` so the backend seed env is injected.',
    );
  }
  const context: BrowserContext = await browser.newContext({
    baseURL,
    storageState: undefined,
  });
  const page: Page = await context.newPage();
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(DEV_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // A successful sign-in redirects off /auth/login onto the app (dashboard by default).
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/login'));
  await mkdir(path.dirname(AUTH_FILE), { recursive: true });
  await context.storageState({ path: AUTH_FILE });
  await context.close();
});

/** No horizontal scrollbar at this viewport — checked on every route/tier combination below. */
async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
}

async function screenshot(page: Page, name: string) {
  await mkdir('/context/artifacts', { recursive: true });
  await page.screenshot({
    path: `/context/artifacts/${name}.png`,
    fullPage: true,
  });
}

async function waitForAnimations(locator: Locator) {
  await locator.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

test.describe('workspace route — responsive tiers', () => {
  test('desktop (≥xl): sidebar + navigator + detail pane all inline, resize handle present', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto(WORKSPACE_PATH);

    await expect(page.getByTestId('app-sidebar')).toBeVisible();
    await expect(page.getByTestId('job-navigator')).toBeVisible();
    await expect(page.getByTestId('detail-pane')).toBeVisible();
    await expect(page.getByTestId('pane-resize-handle')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'bp-workspace-1440');
  });

  test('laptop (lg): detail pane becomes a right drawer, opened via the Detail toggle', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.laptop);
    await page.goto(WORKSPACE_PATH);

    await expect(page.getByTestId('app-sidebar')).toBeVisible();
    await expect(page.getByTestId('job-navigator')).toBeVisible();
    await expect(page.getByTestId('detail-pane')).not.toBeVisible();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'bp-workspace-1120');

    const detailToggle = page.getByRole('button', { name: 'Detail' });
    await expect(detailToggle).toBeVisible();
    await detailToggle.click();

    const detailDialog = page.getByRole('dialog', { name: 'Detail' });
    await expect(detailDialog).toBeVisible();
    await waitForAnimations(detailDialog);
    await expect(detailDialog.getByTestId('detail-pane')).toBeVisible();
    await screenshot(page, 'bp-workspace-1120-detail-drawer');
  });

  test('tablet (md): navigator becomes a left drawer, opened via Panels and auto-closes on selection', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.tablet);
    await page.goto(WORKSPACE_PATH);

    await expect(page.getByTestId('app-sidebar')).toBeVisible();
    await expect(page.getByTestId('job-navigator')).not.toBeVisible();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'bp-workspace-820');

    const panelsToggle = page.getByRole('button', { name: 'Panels' });
    await expect(panelsToggle).toBeVisible();
    await panelsToggle.click();

    const navDialog = page.getByRole('dialog', { name: 'Navigator' });
    await expect(navDialog).toBeVisible();
    await waitForAnimations(navDialog);
    await screenshot(page, 'bp-workspace-820-nav-drawer');

    // Selecting the always-present "Changes" row (a detail node) closes the Navigator drawer —
    // any lane/detail selection made from the open drawer does, per the workspace's close-on-select effect.
    await navDialog.getByRole('button', { name: /Changes/ }).click();
    await expect(navDialog).toBeHidden();
  });

  test('mobile (<md): app sidebar is a full drawer via the hamburger; Panels sheet opens', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto(WORKSPACE_PATH);

    await expect(page.getByTestId('app-sidebar')).not.toBeVisible();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'bp-workspace-375');

    const hamburger = page.getByRole('button', { name: 'Open navigation' });
    await expect(hamburger).toBeVisible();
    await hamburger.click();

    const navigationDialog = page.getByRole('dialog', { name: 'Navigation' });
    await expect(navigationDialog).toBeVisible();
    await waitForAnimations(navigationDialog);
    await expect(navigationDialog.getByTestId('app-sidebar')).toBeVisible();
    await screenshot(page, 'bp-workspace-375-nav-drawer');
    await page.keyboard.press('Escape');
    await expect(navigationDialog).toBeHidden();

    const panelsToggle = page.getByRole('button', { name: 'Panels' });
    await expect(panelsToggle).toBeVisible();
    await panelsToggle.click();
    const navigatorSheet = page.getByRole('dialog', { name: 'Navigator' });
    await expect(navigatorSheet).toBeVisible();
    await waitForAnimations(navigatorSheet);
    await screenshot(page, 'bp-workspace-375-navigator-sheet');

    // Opening an output from the Navigator sheet opens the full-screen Detail view with a visible Back
    // affordance in the detail top bar.
    await navigatorSheet.getByRole('button', { name: /Changes/ }).click();
    const detailDialog = page.getByRole('dialog', { name: 'Detail' });
    await expect(detailDialog).toBeVisible();
    await waitForAnimations(detailDialog);
    await expect(detailDialog.getByTestId('detail-pane')).toBeVisible();
    const detailBox = await detailDialog.boundingBox();
    expect(detailBox?.x).toBeLessThanOrEqual(1);
    expect(detailBox?.width).toBeGreaterThanOrEqual(VIEWPORTS.mobile.width - 1);
    await screenshot(page, 'bp-workspace-375-detail-fullscreen');

    await page.keyboard.press('Escape');
    await expect(detailDialog).toBeHidden();
  });
});

test.describe('org settings route — responsive tiers', () => {
  for (const [tier, viewport] of Object.entries(VIEWPORTS)) {
    test(`${tier}: settings render with no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(SETTINGS_PATH);
      await expect(page.getByRole('heading', { name: /general/i })).toBeVisible();

      await expectNoHorizontalOverflow(page);
      await screenshot(page, `bp-settings-${viewport.width}`);
    });
  }

  test('mobile: settings nav collapses to a drawer opened via its hamburger', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto(SETTINGS_PATH);

    await expect(page.getByText('ORGANIZATION', { exact: true })).not.toBeVisible();

    const hamburger = page.getByRole('button', {
      name: 'Open settings navigation',
    });
    await expect(hamburger).toBeVisible();
    await hamburger.click();

    const settingsNavDialog = page.getByRole('dialog', {
      name: 'Settings navigation',
    });
    await expect(settingsNavDialog).toBeVisible();
    await waitForAnimations(settingsNavDialog);
    await expect(settingsNavDialog.getByText('ORGANIZATION', { exact: true })).toBeVisible();
    await screenshot(page, 'bp-settings-375-nav-drawer');
  });

  test("tablet (md, above the settings' own mobile-only breakpoint): nav renders inline", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.tablet);
    await page.goto(SETTINGS_PATH);

    // The settings nav only drawer-izes below `md` (isMobile), unlike the job workspace's `lg`/`xl`
    // tiers — at 820px it stays inline.
    await expect(page.getByText('ORGANIZATION', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open settings navigation' })).not.toBeVisible();
  });
});
