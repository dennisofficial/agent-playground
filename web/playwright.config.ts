import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against the REAL running stack (Postgres :5433, Nest backend :4002, Next web :3000, all
 * already up under atlas-svc) — `reuseExistingServer` so this never spawns a second `pnpm dev`.
 * Single worker / no parallelism: every spec shares the one seeded backend + browser login.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  expect: {
    timeout: 10_000,
  },
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
