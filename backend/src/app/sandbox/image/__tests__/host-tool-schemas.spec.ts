/**
 * Guard tests for the canonical host-bridge tool schemas. The Claude SDK wraps each `TOOL_SHAPES[name]`
 * in a STRICT zod object that STRIPS unknown top-level keys and REJECTS wrong types before a handler ever
 * sees the call — so a field a handler reads but this file forgot to declare is silently dropped, and a
 * bad enum/string pin here silently rejects input a handler would otherwise have accepted. These tests
 * drive every shape through the SAME in-memory MCP roundtrip the real bridge uses (`tool()` +
 * `createSdkMcpServer()` + an MCP `Client`), not just direct zod parsing, so they catch exactly what the
 * SDK actually does at the wire.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  TOOL_SHAPES,
  TOOL_DESCRIPTIONS,
  toolJsonSchema,
} from '../host-tool-schemas';
import { WORKSPACE_PROFILE_TOOL_NAMES } from '@shared/bridge-names/workspace-profile-bridge-options';

// A single decision, fully populated, reused by every plan-shaped tool.
const decisionItemPayload = {
  decisionClass: 'data_model',
  title: 'Use Postgres for the ledger',
  ruling: 'Use Postgres for the ledger.',
  id: 'd1',
  question: 'Which datastore backs the ledger?',
  answer: 'Postgres',
  confirmedByOperator: true,
};

// A single thread (with a step), fully populated, reused by every plan-shaped tool.
const threadItemPayload = {
  title: 'Backend',
  brief: 'Wire the ledger service.',
  type: 'feature',
  steps: [{ title: 'Add migration', brief: 'Create the ledger table.' }],
};

// One structured verification record, fully populated — the array branch of `verificationField`.
const verificationPayload = [
  { kind: 'test', command: 'npm test', exitCode: 0, outputTail: 'PASS' },
];

/**
 * One FULL, type-valid payload per `TOOL_SHAPES` entry — every declared field populated, so the
 * roundtrip test proves nothing a handler could read is silently stripped. Every key here must match
 * `TOOL_SHAPES` exactly (see the completeness assertion below) — an unknown key would itself be
 * stripped by the strict wrapper and fail the deep-equal, which is the point.
 */
const PAYLOADS: Record<string, Record<string, unknown>> = {
  // ── Driver tools ──────────────────────────────────────────────────────────────────────────────
  complete_thread: {
    summary: 'Done.',
    changes: ['Added the endpoint.'],
    verification: verificationPayload,
    deviations: ['Renamed a var for clarity.'],
    gaps: ['No pagination yet.'],
  },
  request_operator_input: { question: 'Which environment should this target?' },
  record_leg_handoff: {
    handoff: 'Finished the migration; next leg wires the API.',
  },
  record_deviation: { note: 'Renamed a var for clarity.' },
  task_create: {
    subject: 'Wire the endpoint',
    description: 'Add the route and controller.',
    activeForm: 'Wiring the endpoint',
    blockedBy: ['0'],
    addBlockedBy: ['1'],
    removeBlockedBy: ['2'],
    addBlocks: ['3'],
    removeBlocks: ['4'],
  },
  task_update: {
    taskId: '1',
    status: 'in_progress',
    subject: 'Wire the endpoint',
    description: 'Add the route and controller.',
    activeForm: 'Wiring the endpoint',
    blockedBy: ['0'],
    addBlockedBy: ['1'],
    removeBlockedBy: ['2'],
    addBlocks: ['3'],
    removeBlocks: ['4'],
  },
  task_list: {},
  task_get: { taskId: 't1' },
  report_verification: {
    passed: true,
    verification: verificationPayload,
    remaining: ['Flaky test'],
  },

  // ── Brain tools ───────────────────────────────────────────────────────────────────────────────
  get_pipeline_state: {},
  get_decision_record: {},
  dispatch_build: {},
  hold_build: { reason: 'plan is now redundant' },
  finalize_build: {},
  list_mcp_servers: {},
  list_skills: {},
  list_convention_profiles: {},
  recall: { query: 'ledger schema' },
  remember: { fact: 'The ledger uses Postgres.', scope: 'repo' },
  forget: { id: 'm1' },
  update_memory: { id: 'm1', fact: 'The ledger uses Postgres 16.' },
  ask_question: {
    question: 'Which option should we go with?',
    options: [
      'SQLite',
      {
        label: 'Postgres',
        id: 'pg',
        description: 'Use Postgres for the ledger.',
      },
    ],
    decisionClass: 'data_model',
    header: 'Datastore choice',
    allowOther: true,
  },
  withdraw_question: { questionId: 'q1', reason: 'No longer relevant.' },
  withdraw_plan: { reason: 'Scope changed.' },
  withdraw_ship: { reason: 'More changes needed.' },
  set_job_kind: { kind: 'feature' },
  create_decision: {
    decisionClass: 'data_model',
    ruling: 'Use Postgres for the ledger.',
    questionId: 'q1',
    confirmedByOperator: true,
    title: 'Datastore',
  },
  update_decision: {
    id: 'd1',
    confirmedByOperator: true,
    questionId: 'q1',
    decisionClass: 'data_model',
    ruling: 'Use Postgres for the ledger.',
    title: 'Datastore',
  },
  delete_decision: { id: 'd1' },
  review_plan: {
    overview: 'Wire the ledger service.',
    goal: 'Ship the ledger endpoint.',
    note: 'Looks solid.',
    decisions: [decisionItemPayload],
    threads: [threadItemPayload],
  },
  propose_plan: {
    overview: 'Wire the ledger service.',
    goal: 'Ship the ledger endpoint.',
    kind: 'feature',
    decisions: [decisionItemPayload],
    threads: [threadItemPayload],
  },
  start_direct_build: {
    summary: 'Fix the typo in the README.',
    changeOutline: ['Fix typo'],
    kind: 'bugfix',
    decisions: [decisionItemPayload],
  },
  create_job: {
    firstMessage: 'Please fix the flaky test.',
    title: 'Fix flaky test',
    dependsOn: ['j1', 'j2'],
    autoMode: { approveMode: 'ship', merge: true },
  },
  list_jobs: { status: 'all', query: 'auth', limit: 10 },
  link_job_dependency: { jobId: 'j1', dependsOnJobId: 'j2' },
  propose_convention_profile_change: {
    slug: 'backend-style',
    body: '# House style\n...',
    rationale: 'Codify the existing convention.',
    name: 'Backend style',
    detectHint: 'has a nest.cli.json',
  },

  // ── Workspace-profile tools ───────────────────────────────────────────────────────────────────
  request_secret: {
    name: 'STRIPE_API_KEY',
    path: '.stripe/api.key',
    description: 'API key for Stripe.',
    url: 'https://dashboard.stripe.com/apikeys',
    ephemeral: true,
    deliver_to: 'env',
    mcp: { server: 'stripe', slot: 'header', key: 'Authorization' },
  },
  request_file: {
    path: 'config/local.json',
    description: 'Local override config.',
  },
  withdraw_file_request: { requestId: 'r1', reason: 'No longer needed.' },
  withdraw_secret_request: { requestId: 's1', reason: 'No longer needed.' },
  write_workspace_config: {
    mounts: [{ path: '/x', mode: 'cache' }],
    secrets: { name: 'X' },
  },
  write_setup_script: { script: '#!/bin/sh\nnpm ci' },
  read_setup_script: {},
  write_preview_instructions: {
    instructions: 'docker compose up -d && pnpm migrate && pnpm seed',
  },
  read_preview_instructions: {},
  derive_secret: {
    name: 'DERIVED_KEY',
    path: '.derived/key',
    value: 'computed-value',
    description: 'Derived from the root key.',
    overwrite: true,
  },
  reset_sandbox: { reason: 'Env drifted.', hard: true },
  propose_skill: {
    name: 'deploy-helper',
    description: 'Automates deploys.',
    rationale: 'Repeated manual steps.',
    scope: 'repo',
  },
  propose_skill_install: {
    sourceUrl: 'https://github.com/example/skill',
    ref: 'main',
    subpath: 'skills/deploy',
    rationale: 'Reuse the shared skill.',
    scope: 'org',
  },
  request_skill_edit_access: {
    skill: 'deploy-helper',
    rationale: 'Need to fix a bug in it.',
  },
  propose_skill_removal: {
    name: 'deploy-helper',
    rationale: 'No longer used.',
    scope: 'repo',
  },
  propose_mcp_servers: {
    servers: [
      {
        name: 'stripe',
        transport: 'http',
        url: 'https://mcp.stripe.com',
        command: 'stripe-mcp',
        args: ['--flag'],
        headers: [{ name: 'Authorization', secret: true, value: 'Bearer x' }],
        env: [{ name: 'STRIPE_TOKEN', secret: true, value: 'x' }],
        surfaces: ['brain', 'experimental'],
        reason: 'Needed for billing tasks.',
        authKind: 'oauth',
        oauth: { scope: 'read write', tokenAuthMethod: 'none' },
      },
    ],
    scope: 'org',
  },
  propose_mcp_removal: {
    name: 'stripe',
    rationale: 'No longer used.',
    scope: 'org',
  },
  propose_convention_profile: {
    slug: 'backend-style',
    rationale: 'Codify the existing convention.',
  },
  finish_onboarding: {
    summary: 'Boots green.',
    verified: 'Brought up the API and worker; both healthy.',
  },

  // ── atlas-prod tools ──────────────────────────────────────────────────────────────────────────
  atlas_query: {
    sql: 'SELECT id FROM jobs WHERE id = $1',
    params: ['j1'],
    format: 'jsonl',
    limit: 100,
  },
  atlas_schema: {},
  atlas_job_overview: { jobId: 'j1' },
  atlas_session_raw: {
    jobId: 'j1',
    sessionId: 's1',
    raw: false,
    role: 'assistant',
    thinking: true,
    text: true,
    tools: true,
    errors: true,
    tail: 80,
    since: '2026-07-01T00:00:00.000Z',
    grep: 'error',
  },
  atlas_context_read: { jobId: 'j1', path: 'specs/02-atlas-prod-mcp.md' },
  atlas_worktree_tree: { jobId: 'j1', subpath: 'src' },
  atlas_worktree_file: { jobId: 'j1', path: 'src/index.ts' },
  propose_prod_write: {
    sql: "UPDATE threads SET ordinal = 0 WHERE id = 't1'",
  },
};

describe('host-tool-schemas — in-memory MCP roundtrip guard', () => {
  it('PAYLOADS covers every TOOL_SHAPES entry (so no tool silently skips the roundtrip guard)', () => {
    expect(Object.keys(PAYLOADS).sort()).toEqual(
      Object.keys(TOOL_SHAPES).sort(),
    );
  });

  const names = Object.keys(TOOL_SHAPES);
  const captured: Record<string, unknown> = {};
  let client: Client;

  beforeAll(async () => {
    const tools = names.map((name) =>
      tool(
        name,
        TOOL_DESCRIPTIONS[name] ?? name,
        TOOL_SHAPES[name],
        async (args) => {
          captured[name] = args;
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      ),
    );
    const { instance } = createSdkMcpServer({
      name: 'host-tool-schemas-spec',
      version: '1.0.0',
      tools,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await instance.connect(serverTransport);
    client = new Client({
      name: 'host-tool-schemas-spec-client',
      version: '1.0.0',
    });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
  });

  it.each(names)(
    '%s: the FULL declared payload roundtrips untouched (nothing stripped)',
    async (name) => {
      const payload = PAYLOADS[name];
      captured[name] = '(not called)';
      const res = await client.callTool({ name, arguments: payload });
      expect(res.isError, `${name} call must not error`).toBeFalsy();
      expect(captured[name]).toEqual(payload);
    },
  );

  it('rejects a wrong-typed REQUIRED field before the handler ever sees it', async () => {
    captured['complete_thread'] = '(not called)';
    let res: Awaited<ReturnType<typeof client.callTool>> | undefined;
    let thrown: unknown;
    try {
      res = await client.callTool({
        name: 'complete_thread',
        arguments: { summary: 123 },
      });
    } catch (err) {
      thrown = err;
    }
    // The SDK either throws before dispatch or returns an error result — accept either, but the
    // handler must never have been invoked with the bad payload either way.
    expect(thrown != null || res?.isError === true).toBe(true);
    expect(captured['complete_thread']).toBe('(not called)');
  });

  it("rejects create_job autoMode.approveMode='both' before the handler ever sees it", async () => {
    captured['create_job'] = '(not called)';
    let res: Awaited<ReturnType<typeof client.callTool>> | undefined;
    let thrown: unknown;
    try {
      res = await client.callTool({
        name: 'create_job',
        arguments: {
          firstMessage: 'Please fix the flaky test.',
          autoMode: { approveMode: 'both' },
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown != null || res?.isError === true).toBe(true);
    expect(captured['create_job']).toBe('(not called)');
  });
});

describe('host-tool-schemas — toolJsonSchema', () => {
  for (const name of Object.keys(TOOL_SHAPES)) {
    it(`${name}: produces a representable object JSON Schema`, () => {
      const schema = toolJsonSchema(name);
      expect(schema).toMatchObject({ type: 'object' });
    });
  }

  it('falls back to a permissive object schema for an unknown tool name', () => {
    expect(toolJsonSchema('__nonexistent__')).toEqual({
      type: 'object',
      additionalProperties: true,
    });
  });
});

describe('host-tool-schemas — TOOL_DESCRIPTIONS parity', () => {
  it('every TOOL_SHAPES entry has a matching TOOL_DESCRIPTIONS entry', () => {
    for (const name of Object.keys(TOOL_SHAPES)) {
      expect(
        typeof TOOL_DESCRIPTIONS[name],
        `"${name}" is missing a TOOL_DESCRIPTIONS entry`,
      ).toBe('string');
      expect(
        TOOL_DESCRIPTIONS[name].length,
        `"${name}" has an empty TOOL_DESCRIPTIONS entry`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('host-tool-schemas — WORKSPACE_PROFILE_TOOL_NAMES completeness', () => {
  it('every workspace-profile tool name is a real TOOL_SHAPES entry', () => {
    for (const name of WORKSPACE_PROFILE_TOOL_NAMES) {
      expect(
        TOOL_SHAPES,
        `workspace-profile tool "${name}" must have a TOOL_SHAPES entry`,
      ).toHaveProperty(name);
    }
  });
});
