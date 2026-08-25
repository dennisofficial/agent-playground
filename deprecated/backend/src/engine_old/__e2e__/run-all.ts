import { run as aborting } from './aborting.e2e';
import { run as adversarial } from './adversarial.e2e';
import { run as errorHandling } from './error-handling.e2e';
import { requireSandboxArg, type ScenarioResult } from './lib/harness';
import { run as mcpServers } from './mcp-servers.e2e';
import { run as normalTurn } from './normal-turn.e2e';
import { run as reattach } from './reattach.e2e';
import { run as steering } from './steering.e2e';
import { run as toolBridge } from './tool-bridge.e2e';

interface Entry {
  name: string;
  run: (s: string) => Promise<ScenarioResult>;
  required: boolean;
}

const SCENARIOS: Entry[] = [
  { name: 'normal-turn', run: normalTurn, required: true },
  { name: 'steering', run: steering, required: true },
  { name: 'aborting', run: aborting, required: true },
  { name: 'reattach', run: reattach, required: true },
  { name: 'error-handling', run: errorHandling, required: true },
  { name: 'tool-bridge', run: toolBridge, required: true },
  { name: 'mcp-servers', run: mcpServers, required: true },
  { name: 'adversarial', run: adversarial, required: false }, // exploratory — last, non-gating
];

async function main(): Promise<void> {
  const sandbox = requireSandboxArg('run-all.ts');
  console.log(`\n=== engine e2e: ${SCENARIOS.length} scenarios on ${sandbox} ===\n`);
  const results: Array<{ name: string; required: boolean; result: ScenarioResult }> = [];
  for (const s of SCENARIOS) {
    console.log(`\n───── ${s.name} ─────`);
    try {
      const result = await s.run(sandbox);
      results.push({ name: s.name, required: s.required, result });
      console.log(`${result.pass ? 'PASS' : 'FAIL'} ${s.name}: ${result.detail}`);
    } catch (e) {
      results.push({
        name: s.name,
        required: s.required,
        result: { pass: false, detail: `threw: ${String(e).slice(0, 160)}` },
      });
      console.log(`FAIL ${s.name}: threw ${String(e).slice(0, 160)}`);
    }
  }

  console.log('\n\n════════════════ ENGINE E2E SUMMARY ════════════════');
  for (const r of results) {
    const tag = r.result.pass ? 'PASS' : 'FAIL';
    const req = r.required ? '' : ' (exploratory)';
    console.log(`  ${tag}  ${r.name.padEnd(16)}${req}  ${r.result.detail}`);
  }
  console.log('════════════════════════════════════════════════════\n');

  const requiredFailed = results.filter((r) => r.required && !r.result.pass);
  if (requiredFailed.length > 0) {
    console.log(`REQUIRED FAILURES: ${requiredFailed.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
  console.log('All required scenarios passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error(`run-all fatal: ${String(e)}`);
  process.exit(1);
});
