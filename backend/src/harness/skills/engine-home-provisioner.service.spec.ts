import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import type { EmployeeDefinition } from '../employees/employee.types';
import { EngineHomeProvisioner } from './engine-home-provisioner.service';
import type { LoadedSkill, McpServerConfig, SkillSource } from './skill.types';

// A claude-plan / codex-execute employee — exercises BOTH per-engine homes from one fixture.
function fakeEmployee(
  id: string,
  skills: SkillSource[],
  mcpServers: McpServerConfig[],
): EmployeeDefinition {
  return {
    id,
    skills,
    mcpServers,
    planEngine: () => ({ engine: EWorkerEngineName.CLAUDE, systemPrompt: '' }),
    executeEngine: () => ({ engine: EWorkerEngineName.CODEX, systemPrompt: '' }),
    capabilities: () => [],
  } as unknown as EmployeeDefinition;
}

describe('EngineHomeProvisioner — exact-mirror reconcile', () => {
  let base: string;
  let skillRepo: string; // a real dir to symlink at (the skill's `dir`)
  let employee: EmployeeDefinition;
  let provisioner: EngineHomeProvisioner;

  // Mutable stubs: each test rewires what the loader resolves + what the employee declares, then
  // reconciles and asserts the home mirrors it.
  let resolved: LoadedSkill[] = [];

  const registry = {
    list: () => [employee],
    provisionable: () => [employee],
    byId: (id: string) => (id === employee.id ? employee : undefined),
    context: () => ({}),
  } as never;
  const loader = { resolve: () => Promise.resolve(resolved) } as never;
  const env = {
    get: (k: string) => (k === 'AGENT_HOME_ROOT' ? base : undefined),
  } as never;
  // No DB grants in these tests — declared-only path. (Grant-union is covered against real Postgres
  // in the integration test.)
  const skillStore = { listForEmployee: () => Promise.resolve([]) } as never;
  const mcpStore = { listForEmployee: () => Promise.resolve([]) } as never;

  const claudeSkillsDir = () => join(base, 'emp', 'claude', 'skills');
  const codexConfig = () => join(base, 'emp', 'codex', 'config.toml');
  const codexAgents = () => join(base, 'emp', 'codex', 'AGENTS.md');

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'agent-home-'));
    skillRepo = mkdtempSync(join(tmpdir(), 'skill-repo-'));
    mkdirSync(skillRepo, { recursive: true });
    resolved = [];
    employee = fakeEmployee('emp', [], []);
    provisioner = new EngineHomeProvisioner(
      registry,
      loader,
      env,
      skillStore,
      mcpStore,
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(skillRepo, { recursive: true, force: true });
  });

  it('materializes a declared skill + MCP, then PRUNES them when removed', async () => {
    // Grant a skill + an MCP server.
    resolved = [
      { name: 'code-review', description: 'd', dir: skillRepo, source: { kind: 'local', path: skillRepo } },
    ];
    employee = fakeEmployee(
      'emp',
      [{ kind: 'local', path: skillRepo }],
      [{ name: 'fs', transport: 'stdio', command: 'mcp-fs' }],
    );
    await provisioner.reconcile('emp');

    expect(existsSync(join(claudeSkillsDir(), 'code-review'))).toBe(true);
    expect(lstatSync(join(claudeSkillsDir(), 'code-review')).isSymbolicLink()).toBe(true);
    expect(existsSync(codexConfig())).toBe(true); // MCP → codex config.toml
    expect(existsSync(codexAgents())).toBe(true); // skills → codex AGENTS.md
    expect(provisioner.forAgent('emp')).toMatchObject({
      skillNames: ['code-review'],
      mcpServers: [{ name: 'fs', transport: 'stdio', command: 'mcp-fs' }],
    });
    expect(provisioner.forAgent('emp').skillsPrompt).toContain('code-review');

    // Now remove EVERYTHING and reconcile — the home must become a clean mirror.
    resolved = [];
    employee = fakeEmployee('emp', [], []);
    await provisioner.reconcile('emp');

    expect(existsSync(join(claudeSkillsDir(), 'code-review'))).toBe(false);
    expect(existsSync(codexConfig())).toBe(false);
    expect(existsSync(codexAgents())).toBe(false);
    expect(provisioner.forAgent('emp')).toEqual({
      skillNames: [],
      skillsPrompt: '',
      mcpServers: [],
    });
  });

  it('dedupes skills by name (declared + granted overlap) without an EEXIST crash', async () => {
    // The loader returns the SAME skill name twice (as if declared AND granted resolve to it).
    resolved = [
      { name: 'code-review', description: 'd', dir: skillRepo, source: { kind: 'local', path: skillRepo } },
      { name: 'code-review', description: 'd', dir: skillRepo, source: { kind: 'local', path: skillRepo } },
    ];
    employee = fakeEmployee('emp', [{ kind: 'local', path: skillRepo }], []);
    await provisioner.reconcile('emp'); // must not throw
    expect(existsSync(join(claudeSkillsDir(), 'code-review'))).toBe(true);
    expect(provisioner.forAgent('emp').skillNames).toEqual(['code-review']); // deduped
  });

  it('forAgent is empty for an un-provisioned employee', () => {
    expect(provisioner.forAgent('nobody')).toEqual({
      skillNames: [],
      skillsPrompt: '',
      mcpServers: [],
    });
  });
});
