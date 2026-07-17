import { Logger } from '@nestjs/common';
import { E2eHarness, type E2eConfig, type E2eResult } from './e2e-harness.service';

function parseArgs(argv: string[]): E2eConfig {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  return {
    live: has('--live'),
    ...((get('--repo') ?? process.env.E2E_REPO)
      ? { gitUrl: get('--repo') ?? process.env.E2E_REPO }
      : {}),
    ...(get('--base') ? { baseBranch: get('--base') } : {}),
  };
}

function printResult(result: E2eResult): void {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out('══ Atlas v2 e2e result ══');
  for (const scenario of result.scenarios) {
    out(`── ${scenario.name} ── ${scenario.ok ? 'PASS' : 'FAIL'}`);
    for (const s of scenario.steps) out(`   ${s.ok ? '✓' : '✗'} ${s.name}: ${s.detail}`);
  }
  out(`e2e ${result.ok ? 'PASSED' : 'FAILED'}.`);
}

async function main(): Promise<void> {
  const log = new Logger('E2e');
  const config = parseArgs(process.argv.slice(2));

  if (config.live && !config.gitUrl) {
    log.error('--live requires --repo https://github.com/<owner>/<repo> (or E2E_REPO).');
    process.exit(2);
  }

  log.log(
    `Running Atlas v2 e2e (${config.live ? 'LIVE' : 'OFFLINE'})${config.gitUrl ? ` repo=${config.gitUrl}` : ''}`,
  );

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
