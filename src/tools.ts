import { tool } from '@langchain/core/tools';
import { exec, execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const ROOT = process.cwd();

/**
 * v0 permission boundary. Resolves a user/agent-supplied path against the project root and
 * rejects anything that escapes it (absolute out-of-tree paths, `..` traversal). The root
 * itself is allowed (rel === ''). This is the prototype-grade sandbox; the real boundary is
 * the v1 approval/interrupt() flow.
 */
function resolveInCwd(p: string): string {
  const resolved = resolve(ROOT, p);
  const rel = relative(ROOT, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${p}" escapes the project directory — refused. Stay within ${ROOT}.`);
  }
  return resolved;
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.turbo']);

// Best-effort guard-rails against obviously destructive shell forms. NOT a real sandbox.
const DENY = [
  /\brm\s+-rf\s+\/(?!\S)/, // rm -rf /
  /\bsudo\b/,
  /:\(\)\s*\{/, // fork bomb :(){
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/(?:etc|usr|bin|sbin|var|dev|sys|proc)\b/, // redirect into system dirs
  /(^|\s)~\//, // home-dir expansion (outside cwd)
];

export const bash = tool(
  async ({ command }) => {
    for (const rule of DENY) {
      if (rule.test(command)) {
        return `Refused: command matches a blocked destructive pattern (${rule}). Stay within the project directory and avoid system-level operations.`;
      }
    }
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: ROOT,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      return out || '(command finished with no output)';
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return `Command failed: ${e.stderr || e.message || String(err)}`;
    }
  },
  {
    name: 'bash',
    description:
      'Run a shell command inside the project directory. Use for builds, tests, git, and inspecting the tree. Cannot escape the project root or run destructive system commands.',
    schema: z.object({ command: z.string().describe('The shell command to run.') }),
  },
);

export const read_file = tool(
  async ({ path }) => {
    try {
      return await readFile(resolveInCwd(path), 'utf8');
    } catch (err) {
      return `Could not read "${path}": ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file by path, relative to the project directory.',
    schema: z.object({ path: z.string().describe('File path relative to the project root.') }),
  },
);

// ---- read-only tools (safe for the chat layer) ----

async function buildTree(dir: string, prefix: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return;
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) {
        out.push(`${prefix}${e.name}/  (skipped)`);
        continue;
      }
      out.push(`${prefix}${e.name}/`);
      await buildTree(resolve(dir, e.name), `${prefix}  `, depth - 1, out);
    } else {
      out.push(`${prefix}${e.name}`);
    }
  }
}

export const list_dir = tool(
  async ({ path, depth }) => {
    try {
      const target = resolveInCwd(path ?? '.');
      const out: string[] = [];
      await buildTree(target, '', depth ?? 2, out);
      return out.join('\n') || '(empty)';
    } catch (err) {
      return `Could not list "${path ?? '.'}": ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'list_dir',
    description:
      'List a directory tree (relative to the project root), skipping node_modules/.git/dist. Use to get an overview of the codebase.',
    schema: z.object({
      path: z.string().optional().describe('Directory relative to the project root. Defaults to the root.'),
      depth: z.number().optional().describe('How many levels deep to recurse. Defaults to 2.'),
    }),
  },
);

export const grep = tool(
  async ({ pattern, path }) => {
    try {
      const target = resolveInCwd(path ?? '.');
      // execFile (no shell) — `pattern` is a plain arg, so no shell-injection surface.
      const { stdout } = await execFileAsync(
        'grep',
        ['-rInE', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '-e', pattern, target],
        { cwd: ROOT, timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      return stdout.trim() || 'no matches';
    } catch (err) {
      const e = err as { code?: number; stderr?: string; message?: string };
      if (e.code === 1) return 'no matches'; // grep exits 1 when nothing matched
      return `grep failed: ${e.stderr || e.message || String(err)}`;
    }
  },
  {
    name: 'grep',
    description: 'Search file contents for a regex pattern across the project (read-only). Returns file:line:match.',
    schema: z.object({
      pattern: z.string().describe('Extended-regex pattern to search for.'),
      path: z.string().optional().describe('Directory or file to search, relative to the root. Defaults to the root.'),
    }),
  },
);

// ---- write tool (worker only) ----

export const write_file = tool(
  async ({ path, content }) => {
    try {
      const target = resolveInCwd(path);
      await writeFile(target, content, 'utf8');
      return `Wrote ${content.length} bytes to ${relative(ROOT, target)}.`;
    } catch (err) {
      return `Could not write "${path}": ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'write_file',
    description: 'Write (or overwrite) a UTF-8 text file by path, relative to the project directory.',
    schema: z.object({
      path: z.string().describe('File path relative to the project root.'),
      content: z.string().describe('Full file contents to write.'),
    }),
  },
);

/** Read-only tools — safe for the chat layer (Zero answers questions directly, no mutations). */
export const readOnlyTools = [read_file, list_dir, grep];

/** Worker tools — read-only set plus the mutating tools (write, shell). */
export const workerTools = [...readOnlyTools, write_file, bash];
