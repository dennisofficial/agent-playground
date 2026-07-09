/**
 * The in-sandbox stdio MCP server that gives a CODEX turn a host tool bridge (parity with the Claude
 * in-process bridge in `engine-entrypoint.ts`). Codex spawns THIS as a subprocess (declared in the
 * per-sandbox `config.toml` `[mcp_servers.atlasbridge]` block written by `codex-auth-home.ts`), so unlike
 * the Claude bridge — which runs in the engine process and shares its Redis client — this owns its OWN
 * Redis connections and does the identical `tool_request`/reply round-trip over the turn's streams:
 *
 *   XADD `turn:{T}:tools`  { t:'tool_request', id, name, args }   (engine→host; served by the host's
 *   await reply on `turn:{T}:replies`  { t:'tool_response'|'tool_error', id, … }   `consumeTools` loop)
 *
 * The host side (`redis-engine-runner.ts` `consumeTools` + `tool-bridge-host.ts` `dispatchToolRequest`)
 * is engine-agnostic and reused unchanged — it doesn't care that the frame came from this subprocess
 * rather than the engine. Env is supplied by the config.toml `[mcp_servers.atlasbridge.env]` block:
 * `TURN_ID`, `REDIS_URL`, `BRIDGE_TOOLS` (comma-separated host tool names). A fresh docker exec per Atlas
 * turn → fresh codex → fresh spawn of this server reading the CURRENT turn's `config.toml`, so the turn
 * id is always current (no stale-key risk across a resumed session).
 *
 * NOTE: codex surfaces these tools NAMESPACED to the model (e.g. `atlasbridge__complete_thread`), but the
 * `name` we put in the `tool_request` frame is the BARE tool name, so the host's `dispatchToolRequest`
 * (which matches on the bare name) resolves it exactly like a Claude bridge call.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ToolBridgeReader } from './tool-bridge-reader';

/** JSON-schema descriptions for the host bridge tools a Codex writer thread uses, so the model fills the
 *  right fields. The MCP server forwards the WHOLE arguments object as the `tool_request` `args`, which is
 *  exactly what the host handlers read (`args['summary']`, etc.). Unknown tools get a permissive schema. */
const TOOL_SCHEMAS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  report_verification: {
    description:
      'Report the verification you ran for a DIRECT BUILD before shipping. Pass passed:true only once ' +
      'diagnostics + the repo typecheck are clean AND — if you touched a runtime surface (HTTP endpoint, UI ' +
      'page/component, CLI entry point, or background job) — you have ACTUALLY EXERCISED IT LIVE (booted the ' +
      'process and curled the endpoint / drove the UI / ran the CLI for real). Include that live evidence in ' +
      '`verification` (the real command, its exit code, a tail of its output). finalize_build runs a ' +
      'live-verification judge over this evidence and refuses to ship a runtime change you only typechecked. ' +
      'If you cannot get things clean, pass passed:false with `remaining` listing the specific errors.',
    inputSchema: {
      type: 'object',
      properties: {
        passed: { type: 'boolean', description: 'true only when checks are clean AND live-exercised (if runtime).' },
        remaining: {
          type: 'array',
          items: { type: 'string' },
          description: 'When passed:false — the specific remaining errors (file:line — message).',
        },
        verification: {
          type: 'array',
          description:
            'Live-verification evidence — the real commands you ran and their results (curl / UI drive / CLI ' +
            'run, plus diagnostics/typecheck). Typecheck/build/lint/tests alone are NOT live verification.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              command: { type: 'string' },
              exitCode: { type: 'number' },
              outputTail: { type: 'string' },
            },
          },
        },
      },
      required: ['passed'],
      additionalProperties: true,
    },
  },
  complete_thread: {
    description:
      'Assert this thread is DONE. Call exactly once when the work is complete and verified. Provide a ' +
      'one-line summary plus, ideally, the changes you made and the verification you ran.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line: what this thread built/fixed.' },
        changes: { type: 'array', items: { type: 'string' }, description: 'Notable changes made.' },
        verification: {
          type: 'array',
          description: 'Verification evidence — the real commands you ran and their results.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              command: { type: 'string' },
              exitCode: { type: 'number' },
              outputTail: { type: 'string' },
            },
          },
        },
        deviations: { type: 'array', items: { type: 'string' }, description: 'Off-spec changes, if any.' },
        gaps: { type: 'array', items: { type: 'string' }, description: 'Known gaps / follow-ups.' },
      },
      required: ['summary'],
      additionalProperties: true,
    },
  },
  block_thread: {
    description:
      'Voluntarily HALT this thread — you cannot make progress this turn and there is nothing to poll for. ' +
      'Use complete_thread when done instead.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: ['question', 'needs_env', 'decision'], description: 'Why blocked.' },
        detail: { type: 'string', description: 'Specifically what blocks you and what you need.' },
      },
      required: ['reason', 'detail'],
      additionalProperties: true,
    },
  },
  reset_sandbox: {
    description:
      'Recreate this job’s sandbox so you can PROVE it cold-boots from durable config. Default: recreates the ' +
      'CONTAINER only (worktree + session survive). `hard:true`: recreates the WHOLE sandbox from scratch — ' +
      'fresh worktree AND container, as if the job just started — while keeping your coding session (history ' +
      'resumes) and the /context + /playground mounts. A hard reset is a TWO-CALL CONFIRM: the first call ' +
      'describes what happens / what is lost and does nothing; call it again to actually reset. It REFUSES on ' +
      'a dirty tree or unpushed commits (the host never commits for you — commit + push first). The reset ' +
      'happens on your NEXT turn — call it, then STOP.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why you are resetting (shown to the operator).' },
        hard: {
          type: 'boolean',
          description:
            'true = full from-scratch worktree + container re-provision (two-call confirm; refuses on a dirty/unpushed tree). Omit/false = container-only reset.',
        },
      },
      required: ['reason'],
      additionalProperties: true,
    },
  },
  // Live task list (parity with Claude Code's TaskCreate/TaskUpdate) — surfaces this thread's work as a
  // checklist in the operator console, identical to the build lanes. Create returns an id string ("Task #N
  // created …"); pass that `taskId` back to task_update to advance its status.
  task_create: {
    description:
      'Add ONE item to your live task list (shown to the operator as a checklist for this thread). Call it ' +
      'up front for each concrete step you plan to do, and as new work emerges. Returns the created task id.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Imperative one-line title, e.g. "Review the merged diff".' },
        description: { type: 'string', description: 'Optional longer detail about what this step involves.' },
        activeForm: {
          type: 'string',
          description: 'Present-continuous form shown while in progress, e.g. "Reviewing the merged diff".',
        },
      },
      required: ['subject'],
      additionalProperties: true,
    },
  },
  task_update: {
    description:
      'Update one task in your live task list — mark it in_progress when you start it and completed when it ' +
      'is done (exactly one task should be in_progress at a time). Use status "deleted" to remove a task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The id returned by task_create (e.g. "3").' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'deleted'],
          description: 'The new status.',
        },
        subject: { type: 'string', description: 'Optional revised title.' },
        description: { type: 'string', description: 'Optional revised detail.' },
        activeForm: { type: 'string', description: 'Optional revised present-continuous form.' },
      },
      required: ['taskId'],
      additionalProperties: true,
    },
  },
};

const PERMISSIVE_SCHEMA = { type: 'object', additionalProperties: true } as const;

async function main(): Promise<void> {
  const turnId = process.env.TURN_ID;
  if (!turnId) throw new Error('mcp-bridge-server: TURN_ID is required');
  const redisUrl = process.env.REDIS_URL ?? 'redis://redis:6379';
  const toolNames = (process.env.BRIDGE_TOOLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (toolNames.length === 0) throw new Error('mcp-bridge-server: BRIDGE_TOOLS is empty');

  const toolsKey = `turn:${turnId}:tools`;
  const repliesKey = `turn:${turnId}:replies`;

  const pub = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
  await pub.connect();

  // Reply reader: a blocking read on the replies stream (its own connection(s) — a blocking read can't
  // share `pub`), resolving pending calls by id. Reads from '0-0' — the stream is fresh per turn, so
  // there are no stale replies to skip. `makeSub` also assigns the outer `sub` so stdin-close cleanup
  // always disconnects whichever connection is CURRENT (the reader swaps it internally on a stall-reset).
  let sub: Redis | undefined;
  const reader = new ToolBridgeReader({
    repliesKey,
    makeSub: () => {
      sub = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
      return sub;
    },
    log: (m) => process.stderr.write(`[mcp-bridge-server] ${m}\n`),
  });
  reader.start();

  const callHostTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const id = randomUUID();
    const p = reader.register(id);
    try {
      await pub.xadd(toolsKey, '*', 'data', JSON.stringify({ t: 'tool_request', id, name, args }));
    } catch (err) {
      reader.cancel(id);
      throw err;
    }
    return p;
  };

  const server = new Server({ name: 'atlasbridge', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolNames.map((name) => ({
      name,
      description: TOOL_SCHEMAS[name]?.description ?? `Host-side tool '${name}' proxied via the Atlas bridge.`,
      inputSchema: TOOL_SCHEMAS[name]?.inputSchema ?? PERMISSIVE_SCHEMA,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await callHostTool(name, args);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)) || 'host tool error (no message)';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  // Keep the process alive; codex terminates it when the turn ends. Clean up on stdin close.
  process.stdin.on('close', () => {
    reader.stopReader();
    pub.disconnect();
    sub?.disconnect();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[mcp-bridge-server] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
