import { Logger } from '@nestjs/common';
import { E2eHarness, type E2eConfig, type E2eResult } from './e2e-harness.service';

/**
 * The W9 end-to-end verification runner (`pnpm atlas:e2e`). DEFAULTS TO OFFLINE/DETERMINISTIC — it boots
 * the REAL `AtlasModule` in `ATLAS_SURFACE=agent` mode (HTTP listening) against live Postgres, but swaps
 * in FAKE LLM ports + a fake engine/git/PR, so it exercises the full wiring + control flow of all three
 * scenarios IN-PROCESS with NO real LLM call and NO outward action (no real PR / Slack). Pass `--live`
 * to run the REAL ports against a `--repo` (clones like `atlas:gate`, opens real draft PRs). The
 * orchestrator runs `--live`; the harness boots and closes the app itself.
 *
 * Flags (env vars also accepted):
 *   --live              use real LLM + real git/PR (otherwise offline/deterministic). Default: offline.
 *   --repo <https-url>  the GitHub repo for live (env: ATLAS_E2E_REPO). Required with --live.
 *   --base <branch>     PR base branch override.
 *
 * Run (offline):  pnpm atlas:e2e
 * Run (live):     pnpm atlas:e2e -- --live --repo https://github.com/<owner>/<repo>
 *   (live env: ANTHROPIC_API_KEY, ATLAS_GITHUB_TOKEN, ATLAS_GITHUB_WEBHOOK_SECRET — see the report.)
 */
function parseArgs(argv: string[]): E2eConfig {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  return {
    live: has('--live'),
    ...(get('--repo') ?? process.env.ATLAS_E2E_REPO
      ? { gitUrl: get('--repo') ?? process.env.ATLAS_E2E_REPO }
      : {}),
    ...(get('--base') ? { baseBranch: get('--base') } : {}),
  };
}

function printResult(result: E2eResult): void {
  // Plain stdout so the summary is unconditional (independent of the Nest Logger's level filtering).
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out('══ Atlas v2 e2e result ══');
  for (const scenario of result.scenarios) {
    out(`── ${scenario.name} ── ${scenario.ok ? 'PASS' : 'FAIL'}`);
    for (const s of scenario.steps) out(`   ${s.ok ? '✓' : '✗'} ${s.name}: ${s.detail}`);
  }
  out(`e2e ${result.ok ? 'PASSED' : 'FAILED'}.`);
}

async function main(): Promise<void> {
  const log = new Logger('AtlasE2e');
  const config = parseArgs(process.argv.slice(2));

  if (config.live && !config.gitUrl) {
    log.error('--live requires --repo https://github.com/<owner>/<repo> (or ATLAS_E2E_REPO).');
    process.exit(2);
  }

  log.log(`Running Atlas v2 e2e (${config.live ? 'LIVE' : 'OFFLINE'})${config.gitUrl ? ` repo=${config.gitUrl}` : ''}`);

  const harness = new E2eHarness(config);
  try {
    await harness.boot();
    const result = await harness.run();
    printResult(result);
    await harness.close();
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    log.error(`e2e crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    await harness.close().catch(() => undefined);
    process.exit(1);
  }
}

void main();
