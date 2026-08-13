import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  atlasToolNames,
  atlasToolServer,
  runEngineTool,
  type EngineTool,
} from '../atlas-tool-server.js';
import { claudeOptions } from '../claude-options.js';
import { NATIVE_TOOLS, NATIVE_TOOLS_OUT } from '../native-tools.js';

function tool(overrides: Partial<EngineTool> = {}): EngineTool {
  return {
    name: 'advance_thread',
    description: 'close me, open the next',
    shape: { role: z.string(), attach: z.array(z.string()) },
    handler: async () => 'opened',
    ...overrides,
  };
}

const RUN = {
  prompt: 'hello',
  cwd: '/repo',
  model: 'claude-opus-5',
  env: {},
  onEvent: (): void => undefined,
};

/**
 * What an MCP client would get back from `tools/list`, reached through the server's own handler
 * table. Private surface, deliberately: the alternative is spawning a client over a transport to
 * assert one payload, and this is the only place a test reaches into it.
 */
async function listTools(instance: unknown): Promise<unknown> {
  const handlers = read(read(instance, 'server'), '_requestHandlers');
  if (!(handlers instanceof Map)) throw new Error('no MCP request handlers on the server');
  const handler: unknown = handlers.get('tools/list');
  if (typeof handler !== 'function') throw new Error('no tools/list handler');
  return handler(
    { method: 'tools/list', params: {} },
    { signal: new AbortController().signal },
  );
}

function read(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

describe('the Claude transport', () => {
  it('builds a real in-process SDK MCP server from a registry entry', () => {
    // Constructing it for real is the point: the SDK bundles its own zod, so this is what proves
    // Atlas's separately-installed zod is understood by the server it hands its shapes to.
    const server = atlasToolServer([tool()]);
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('atlas');
  });

  it('names tools the way the model will emit them', () => {
    expect(atlasToolNames([tool()])).toEqual(['mcp__atlas__advance_thread']);
  });

  it('puts the shape on the wire as JSON schema — the enum IS the rail the agent runs on', async () => {
    const server = atlasToolServer([
      tool({ shape: { role: z.enum(['builder']), handoff: z.string() } }),
    ]);

    // Read through the MCP request handler rather than the registry, because the zod → JSON-schema
    // conversion happens HERE. The SDK bundles its own zod; this is the assertion that Atlas's
    // separately-installed one survives the crossing, which is the whole reason a shape is a rail.
    const listed = JSON.stringify(await listTools(server.instance));
    expect(listed).toContain('"enum":["builder"]');
    expect(listed).toContain('"required":["role","handoff"]');
  });

  it('turns a throwing handler into a tool error the agent can read, not a dead turn', async () => {
    const server = atlasToolServer([
      tool({
        handler: async () => {
          throw new Error('the build phase does not host a planner thread');
        },
      }),
    ]);
    // The server object is opaque; what matters is that construction survives a handler that
    // throws — the wrapping itself is asserted through `claudeOptions` and the seam spec.
    expect(server.instance).toBeDefined();
  });
});

describe('what the transport does with a throw', () => {
  it('passes a handler’s answer straight through when nothing goes wrong', async () => {
    const faults: string[] = [];
    const result = await runEngineTool(tool(), { role: 'builder' }, (d) => faults.push(d));

    expect(result).toEqual({ content: [{ type: 'text', text: 'opened' }] });
    expect(faults).toEqual([]);
  });

  it('hands a refusal back as prose and logs NOTHING — it is not a fault', async () => {
    const faults: string[] = [];
    const entry = tool({
      handler: async () => {
        throw new Error('the build phase does not host a planner thread');
      },
    });
    const result = await runEngineTool(entry, {}, (d) => faults.push(d));

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('the build phase does not host a planner thread');
    // A log that filled up with ordinary refusals would be a log nobody reads.
    expect(faults).toEqual([]);
  });

  it('logs a stack for a harness fault and tells the agent not to retry it', async () => {
    const faults: string[] = [];
    const entry = tool({
      handler: async () => {
        throw new ReferenceError('rolesFor is not defined');
      },
    });
    const result = await runEngineTool(entry, {}, (d) => faults.push(d));

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('do not retry it');
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain('advance_thread — ReferenceError: rolesFor is not defined');
    // The stack is the whole point of the log: the message alone is what we already had.
    expect(faults[0]).toContain('atlas-tool-server.spec');
  });

  it('survives a handler that throws something that is not an Error', async () => {
    const faults: string[] = [];
    const entry = tool({
      handler: async () => {
        throw 'kaboom';
      },
    });
    const result = await runEngineTool(entry, {}, (d) => faults.push(d));

    expect(result.isError).toBe(true);
    expect(faults).toHaveLength(1);
  });
});

describe('the session options', () => {
  it('disables SDK auto-compaction outright — rotation owns context', () => {
    const options = claudeOptions(RUN);
    // A JSON string rather than an object: the SDK stringifies this option with `String()`, so an
    // object would reach the CLI as `[object Object]` and compaction would quietly stay ON.
    expect(options.settings).toBe('{"autoCompactEnabled":false}');
  });

  it('asks for NO betas, because an unrecognised one fails the whole request', () => {
    // The 1M window is the one we want and the one deliberately left off. The meter no longer
    // objects — `ctx` draws against the rotation budget now, so a million-token window no longer
    // renders a 200K session as `20%` green. What stops it is the blast radius: the beta is
    // forwarded verbatim as `--betas`, the SDK scopes it to Sonnet 4/4.5, and an unrecognised beta
    // fails the REQUEST — so being wrong kills every turn rather than degrading one feature.
    //
    // This asserts the DECISION, not the absence of a field: enabling it is a deliberate act that
    // costs one live turn to verify, and this test is what makes someone notice they are taking it.
    expect(claudeOptions(RUN).betas).toBeUndefined();
  });

  it('installs the post-tool hook ONLY when the turn has something to say at a boundary', async () => {
    expect(claudeOptions(RUN).hooks).toBeUndefined();

    const hooks = claudeOptions({ ...RUN, onToolBoundary: async () => 'rotate please' }).hooks;
    const [matcher] = hooks?.PostToolUse ?? [];
    // No matcher: what Atlas has to say has nothing to do with WHICH tool ran, and a filter here
    // would be a second place for the decision to live.
    expect(matcher?.matcher).toBeUndefined();

    const output = await matcher?.hooks[0]?.({} as never, undefined, {
      signal: new AbortController().signal,
    });
    expect(output).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'rotate please' },
    });
  });

  it('adds nothing to a tool result when there is nothing to say — the common case', async () => {
    const hooks = claudeOptions({ ...RUN, onToolBoundary: async () => undefined }).hooks;
    const output = await hooks?.PostToolUse?.[0]?.hooks[0]?.({} as never, undefined, {
      signal: new AbortController().signal,
    });
    expect(output).toEqual({ continue: true });
  });

  it('restricts natives with `tools`, which is the lever — `allowedTools` only auto-approves', () => {
    const options = claudeOptions(RUN);
    expect(options.tools).toEqual([...NATIVE_TOOLS]);
  });

  it('keeps the excluded natives out by ABSENCE, with no denylist to maintain', () => {
    const options = claudeOptions(RUN);
    const listed = new Set(Array.isArray(options.tools) ? options.tools : []);
    for (const name of Object.keys(NATIVE_TOOLS_OUT)) {
      expect(listed.has(name)).toBe(false);
    }
    expect(options.disallowedTools).toBeUndefined();
  });

  it('registers the Atlas server only when the turn actually has tools', () => {
    expect(claudeOptions(RUN).mcpServers).toBeUndefined();
    expect(claudeOptions({ ...RUN, tools: [tool()] }).mcpServers).toBeDefined();
  });

  it('auto-approves Atlas’s own tools rather than leaning on the permission mode', () => {
    const options = claudeOptions({ ...RUN, tools: [tool()] });
    expect(options.allowedTools).toContain('mcp__atlas__advance_thread');
  });
});

describe('the native allowlist', () => {
  it('keeps fan-out and monitoring IN — offloading context is the thesis, not a rival harness', () => {
    for (const name of ['Agent', 'TaskOutput', 'TaskStop', 'Monitor', 'Workflow']) {
      expect(NATIVE_TOOLS).toContain(name);
    }
  });

  it('keeps the tools that manage context, orchestration, scheduling or the human OUT', () => {
    for (const name of [
      'TodoWrite',
      'EnterPlanMode',
      'ExitPlanMode',
      'EnterWorktree',
      'ExitWorktree',
      'CronCreate',
      'AskUserQuestion',
    ]) {
      expect(NATIVE_TOOLS).not.toContain(name);
      expect(NATIVE_TOOLS_OUT[name]).toBeDefined();
    }
  });

  it('never says both — the in list and the recorded exclusions cannot overlap', () => {
    const inList = new Set(NATIVE_TOOLS);
    for (const name of Object.keys(NATIVE_TOOLS_OUT)) {
      expect(inList.has(name)).toBe(false);
    }
  });

  it('is one uniform list — there is no read-only review set to diverge from it', () => {
    // Legacy's review kit had `Bash` in it, so "read-only" was theatre. The honest version is
    // structural: the reviewer reports and the builder fixes.
    expect(NATIVE_TOOLS).toContain('Bash');
  });
});
