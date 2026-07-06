import { describe, expect, it } from 'vitest';
import { buildCodeIndexBridgeOptions } from './code-index-bridge-options';
import {
  COCOINDEX_EXCLUDED_PATTERNS,
  qualifyCocoindexToolNames,
  qualifyGraphifyToolNames,
} from '../../engine/code-index-tools';

const WORKSPACE = '/workspace';

describe('buildCodeIndexBridgeOptions', () => {
  it('returns undefined for non-execute modes (no index tools on read-only turns)', () => {
    for (const mode of ['plan', 'review'] as const) {
      expect(buildCodeIndexBridgeOptions(mode, WORKSPACE, 'sk-openai')).toBeUndefined();
    }
  });

  it('registers BOTH cocoindex + graphify when the embedding key is present', () => {
    const opts = buildCodeIndexBridgeOptions('execute', WORKSPACE, 'sk-openai');
    expect(opts).toBeDefined();
    const servers = opts!.extraClaudeOptions.mcpServers;
    expect(Object.keys(servers).sort()).toEqual(['cocoindex', 'graphify']);

    // Tool names are the qualified mcp__<server>__<tool> forms for both servers.
    expect(opts!.codeIndexToolNames).toEqual([
      ...qualifyGraphifyToolNames(),
      ...qualifyCocoindexToolNames(),
    ]);
    expect(opts!.codeIndexToolNames).toContain('mcp__cocoindex__search');
    expect(opts!.codeIndexToolNames).toContain('mcp__graphify__get_neighbors');
  });

  it('wires ccc with the embedding key + config env (index redirected out of the worktree, exclusions set)', () => {
    const opts = buildCodeIndexBridgeOptions('execute', WORKSPACE, 'sk-openai')!;
    const ccc = opts.extraClaudeOptions.mcpServers.cocoindex as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    // `ccc mcp` is wrapped in a bootstrap that AUTHORS the project settings.yml (not `ccc init`) then exec's.
    expect(ccc.command).toBe('sh');
    expect(ccc.args[0]).toBe('-c');
    expect(ccc.args[1]).not.toContain('ccc init');
    expect(ccc.args[1]).toContain('.cocoindex_code/settings.yml');
    expect(ccc.args[1]).toContain('exec ccc mcp');
    expect(ccc.env.OPENAI_API_KEY).toBe('sk-openai');
    expect(ccc.env.COCOINDEX_CODE_ROOT_PATH).toBe(WORKSPACE);
    // Discovery env: the CLI chdirs to HOST_CWD and reads global settings from HOME.
    expect(ccc.env.COCOINDEX_CODE_HOST_CWD).toBe(WORKSPACE);
    expect(ccc.env.HOME).toBe('/home/atlas');
    // DB redirected OUT of /workspace into the per-job index root (/.atlas) — mapping SOURCE is the project
    // root itself (`/workspace`), NOT the `.cocoindex_code` subdir (which resolve_db_dir never matches).
    expect(ccc.env.COCOINDEX_CODE_DB_PATH_MAPPING).toBe(`${WORKSPACE}=/.atlas/code-index/cocoindex`);
    // Lockfile/build exclusions are applied (env backstop; the authoritative excludes are in settings.yml).
    expect(ccc.env.COCOINDEX_CODE_EXCLUDED_PATTERNS).toBe(JSON.stringify(COCOINDEX_EXCLUDED_PATTERNS));
    expect(ccc.env.COCOINDEX_CODE_EXCLUDED_PATTERNS).toContain('pnpm-lock.yaml');
  });

  it('authors a curated settings.yml (code+docs include, json/yaml/lock excluded) in the bootstrap', () => {
    const opts = buildCodeIndexBridgeOptions('execute', WORKSPACE, 'sk-openai')!;
    const ccc = opts.extraClaudeOptions.mcpServers.cocoindex as { args: string[] };
    const script = ccc.args[1];
    // include has code + docs but NOT the structured-data formats that bloated the live index.
    expect(script).toContain('"**/*.ts"');
    expect(script).toContain('"**/*.md"');
    // exclude drops json/yaml + lockfiles + deps/build output.
    expect(script).toContain('"**/*.json"');
    expect(script).toContain('"**/pnpm-lock.yaml"');
    expect(script).toContain('"**/node_modules"');
    // written under exclude_patterns:/include_patterns: keys.
    expect(script).toContain('exclude_patterns:');
    expect(script).toContain('include_patterns:');
  });

  it('omits cocoindex but KEEPS graphify when no embedding key (cloud embeddings need a key; the graph does not)', () => {
    const opts = buildCodeIndexBridgeOptions('execute', WORKSPACE, undefined)!;
    expect(opts).toBeDefined();
    expect(Object.keys(opts.extraClaudeOptions.mcpServers)).toEqual(['graphify']);
    expect(opts.codeIndexToolNames).toEqual(qualifyGraphifyToolNames());
    expect(opts.codeIndexToolNames).not.toContain('mcp__cocoindex__search');
  });

  it('points the graphify MCP server at the graph.json under the per-job index root (/.atlas)', () => {
    const opts = buildCodeIndexBridgeOptions('execute', WORKSPACE, undefined)!;
    const gf = opts.extraClaudeOptions.mcpServers.graphify as { command: string; args: string[] };
    expect(gf.command).toBe('graphify-mcp');
    // GRAPHIFY_OUT (set on the `graphify watch` daemon) writes graph.json directly into the graphify dir.
    expect(gf.args).toContain('/.atlas/code-index/graphify/graph.json');
    expect(gf.args).toContain('--transport');
    expect(gf.args).toContain('stdio');
  });
});
