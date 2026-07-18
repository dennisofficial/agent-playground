import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const DEV_EMAIL = process.env.ADMIN_SEED_EMAIL ?? 'admin@atlas.dev';
const DEV_PASSWORD = process.env.ADMIN_SEED_PASSWORD ?? 'devpass1234';
const ORG_ID = 'e9af869c-309a-466e-ba1b-51b870106b3f';
const REPO_ID = '63ad1635-966a-427f-8e52-9cc8a8ecfc8b';
const JOB_ID = 'da700000-0000-4000-8000-000000000104';
const WORKSPACE_PATH = `/workspace/${ORG_ID}~${REPO_ID}~${JOB_ID}`;
const EVIDENCE_DIR = process.env.ATLAS_EVIDENCE_DIR ?? '/context/evidence';
const AUTH_FILE = path.join(__dirname, '.auth', 'working-indicator-user.json');

test.beforeAll(async ({ browser, baseURL }) => {
  const context: BrowserContext = await browser.newContext({
    baseURL,
    storageState: undefined,
  });
  const page: Page = await context.newPage();
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(DEV_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/login'));
  await mkdir(path.dirname(AUTH_FILE), { recursive: true });
  await context.storageState({ path: AUTH_FILE });
  await context.close();
});

async function shot(page: Page, name: string) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: `${EVIDENCE_DIR}/${name}.png`,
    fullPage: false,
  });
}

/** Force pipeline status=running (arms the Main `live` fallback) and pin the inbox row `activity`. */
async function installRoutes(page: Page, activity: 'idle' | 'build') {
  // Abort the realtime SSE so it can't overwrite the patched activity in the query cache.
  await page.route(
    (u) => u.pathname.endsWith('/web/jobs/realtime'),
    (route) => route.abort(),
  );
  // Patch the inbox list: set the target job row's activity.
  await page.route(
    (u) => u.pathname.endsWith('/web/jobs'),
    async (route) => {
      const resp = await route.fetch();
      const rows = (await resp.json()) as Array<Record<string, unknown>>;
      for (const r of rows) if (r.jobId === JOB_ID) r.activity = activity;
      await route.fulfill({ response: resp, json: rows });
    },
  );
  // Patch the pipeline: force status running so `live` is armed.
  await page.route(
    (u) => u.pathname.endsWith('/pipeline'),
    async (route) => {
      const resp = await route.fetch();
      const body = (await resp.json()) as Record<string, unknown>;
      if (body && body.status && body.status !== 'no_job') body.status = 'running';
      await route.fulfill({ response: resp, json: body });
    },
  );
}

test.describe('Main working indicator vs build-lane activity (1440x900)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, storageState: AUTH_FILE });

  test("CONTROL: activity=idle + running phase → footer shows 'Atlas is working…'", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await installRoutes(page, 'idle');
    await page.goto(WORKSPACE_PATH, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000); // hydrate + realtime cache warm
    await expect(page.getByText('Atlas is working…')).toBeVisible();
    await shot(page, 'working-indicator-control-idle-shows');
  });

  test("FIXED: activity=build → footer does NOT show 'Atlas is working…'", async ({ page }) => {
    test.setTimeout(90_000);
    await installRoutes(page, 'build');
    await page.goto(WORKSPACE_PATH, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await expect(page.getByText('Atlas is working…')).toHaveCount(0);
    await shot(page, 'working-indicator-fixed-build-hidden');
  });
});
