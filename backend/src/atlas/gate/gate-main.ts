import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AcceptanceGateService, type GateConfig } from './acceptance-gate.service';
import { GateRootModule } from './gate-root.module';

/**
 * The W1 acceptance-gate runner. DEFAULTS TO DRY-RUN (no outward-facing Slack post / PR) — it proves
 * the local engine→git path and reports exactly what the LIVE gate needs. Pass `--live` to actually
 * post to Slack + open a PR (the orchestrator runs this against a Dennis-chosen channel/repo).
 *
 * Flags (env vars also accepted):
 *   --repo <https-url>      the GitHub repo (env: ATLAS_GATE_REPO)
 *   --base <branch>         PR base branch (default: the repo's default)
 *   --channel <C0…>         Slack channel id for the thread (env: ATLAS_GATE_CHANNEL)
 *   --engine <claude|codex> which engine to drive the local turn (default claude)
 *   --live                  fire the outward-facing steps (default: dry-run)
 *
 * Run (dry-run):  pnpm atlas:gate -- --repo https://github.com/<owner>/<repo>
 * Run (live):     pnpm atlas:gate -- --live --repo https://github.com/<owner>/<repo> --channel C0XXXXXXX
 */
function parseArgs(argv: string[]): { config: GateConfig | null; error?: string } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const gitUrl = get('--repo') ?? process.env.ATLAS_GATE_REPO;
  if (!gitUrl) {
    return {
      config: null,
      error:
        'Missing repo. Pass --repo https://github.com/<owner>/<repo> (or set ATLAS_GATE_REPO).',
    };
  }
  const engineArg = get('--engine');
  const engine = engineArg === 'codex' ? 'codex' : engineArg === 'claude' ? 'claude' : undefined;

  const config: GateConfig = {
    gitUrl,
    dryRun: !has('--live'),
    ...(get('--base') ? { baseBranch: get('--base') } : {}),
    ...(get('--channel') ?? process.env.ATLAS_GATE_CHANNEL
      ? { slackChannel: get('--channel') ?? process.env.ATLAS_GATE_CHANNEL }
      : {}),
    ...(engine ? { engine } : {}),
  };
  return { config };
}

async function main(): Promise<void> {
  const log = new Logger('AtlasGate');
  const { config, error } = parseArgs(process.argv.slice(2));
  if (!config) {
    log.error(error ?? 'bad args');
    process.exit(2);
  }

  log.log(
    `Running W1 acceptance gate (${config.dryRun ? 'DRY-RUN' : 'LIVE'}) against ${config.gitUrl}` +
      `${config.slackChannel ? ` channel=${config.slackChannel}` : ''}`,
  );

  const app = await NestFactory.createApplicationContext(GateRootModule, {
    abortOnError: false,
  });
  app.enableShutdownHooks();
  try {
    const gate = app.get(AcceptanceGateService);
    const result = await gate.run(config);
    log.log('── Gate result ──');
    for (const s of result.steps) log.log(`  ${s.ok ? '✓' : '✗'} ${s.name}: ${s.detail}`);
    if (result.prUrl) log.log(`  PR: ${result.prUrl}`);
    if (result.threadTs) log.log(`  Slack thread: ${result.threadTs}`);
    log.log(`Gate ${result.ok ? 'PASSED' : 'FAILED'}.`);
    await app.close();
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    log.error(`Gate crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    await app.close();
    process.exit(1);
  }
}

void main();
