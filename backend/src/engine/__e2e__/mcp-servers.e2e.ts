import {
  cleanup,
  events,
  frameKinds,
  kickEngine,
  makeSpec,
  newRedis,
  newTurnId,
  report,
  requireSandboxArg,
  tailEvents,
  turnKeys,
  xadd,
  type ScenarioResult,
} from './lib/harness';

const LSP_TOOL = 'mcp__atlas-lsp-ts__diagnostics';

export async function run(sandbox: string): Promise<ScenarioResult> {
  const redis = newRedis();
  const turnId = newTurnId();
  const k = turnKeys(turnId);
  try {
    const spec = makeSpec(turnId, {
      homeType: 'build',
      mode: 'execute',
      richStream: true,
      task:
        `Use the ${LSP_TOOL} tool to check the TypeScript file /workspace/src/math.ts for diagnostics ` +
        `(pass filePath "/workspace/src/math.ts"). Report how many diagnostics it returned. ` +
        `Do NOT edit any files, do NOT run git, and do NOT call any other tools.`,
      systemPrompt:
        'You are a terse test assistant. Use ONLY the one tool named in the task, then report its result.',
    });
    console.log(`[mcp] turn ${turnId} on ${sandbox} (execute mode; LSP stdio MCP server)`);
    await xadd(redis, k.spec, spec);
    kickEngine(sandbox, turnId, { detached: true, quiet: true });

    const { frames, final, error } = await tailEvents(redis, turnId, { timeoutMs: 180_000 });
    console.log(`[mcp] frames: ${frameKinds(frames)}`);
    if (error)
      return { pass: false, detail: `error frame: ${String(error.message).slice(0, 200)}` };

    const evs = events(frames);
    const lspUses = evs.filter(
      (e) =>
        (e.kind === 'tool_use' || e.kind === 'tool') &&
        String(e.name ?? '').includes('atlas-lsp-ts'),
    );
    const lspUseIds = new Set(lspUses.map((e) => e.id).filter(Boolean));
    const lspResults = evs.filter((e) => e.kind === 'tool_result' && lspUseIds.has(e.id));
    const anyResult = lspResults.find((e) => e.isError !== true);
    console.log(
      `[mcp] atlas-lsp-ts tool_use=${lspUses.length} tool_result=${lspResults.length} (non-error result present=${!!anyResult}); final=${!!final}`,
    );
    if (lspUses.length === 0) {
      return {
        pass: false,
        detail: 'engine never invoked mcp__atlas-lsp-ts__* — MCP server not registered/called',
      };
    }
    const roundTripped = lspResults.length > 0;
    return {
      pass: roundTripped && !!final,
      detail: roundTripped
        ? `LSP MCP round-trip observed (${lspUses.length} call(s), ${lspResults.length} result(s))${anyResult ? '' : ' — result was an error'}`
        : 'LSP tool was called but no correlated tool_result came back (no MCP round-trip)',
    };
  } finally {
    await cleanup(redis, turnId);
    redis.disconnect();
  }
}

if (require.main === module) {
  const sandbox = requireSandboxArg('mcp-servers.e2e.ts');
  run(sandbox)
    .then((r) => report('mcp', r.pass, r.detail))
    .catch((e) => report('mcp', false, String(e)));
}
