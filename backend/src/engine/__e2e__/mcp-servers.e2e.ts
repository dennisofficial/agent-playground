// MCP SERVERS — exercise a real external stdio MCP server, spawned by the SDK live inside a turn, and
// assert the MCP round-trip actually happened.
//
// PATH CHOSEN (and why): the `atlas-lsp-ts` LSP bridge. Per ADR-0004 it is an EXTERNAL stdio MCP server
// (`atlas-lsp-server.mjs`, baked into the sandbox image) that the Claude SDK spawns as a child process for
// the turn — driving `typescript-language-server` over LSP. `turn-runner.service.ts` wires it via
// `buildLspBridgeOptions`, registered ONLY for `mode:'execute'` turns and merged into the same
// `mcpServers`/`allowedTools` as the host bridge. This is the MOST DIRECT, reliably-triggerable MCP path
// (no operator-defined server / secrets needed, no host round-trip), and it proves the SDK's MCP-subprocess
// wiring end to end. We run an execute turn that calls `mcp__atlas-lsp-ts__diagnostics` on a real worktree
// file and assert BOTH a tool_use for that qualified MCP name AND a returned tool_result — i.e. the MCP
// subprocess was spawned, spoke MCP to the SDK, and answered (the round-trip), not merely "the turn didn't crash".
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

    const { frames, final, error } = await tailEvents(redis, turnId, {
      timeoutMs: 180_000,
    });
    console.log(`[mcp] frames: ${frameKinds(frames)}`);
    if (error)
      return {
        pass: false,
        detail: `error frame: ${String(error.message).slice(0, 200)}`,
      };

    const evs = events(frames);
    // tool_use (rich) or coarse tool event naming the qualified LSP MCP tool.
    const lspUses = evs.filter(
      (e) =>
        (e.kind === 'tool_use' || e.kind === 'tool') &&
        String(e.name ?? '').includes('atlas-lsp-ts'),
    );
    const lspUseIds = new Set(lspUses.map((e) => e.id).filter(Boolean));
    // A tool_result correlated to one of those calls = the MCP subprocess answered (the round-trip).
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
