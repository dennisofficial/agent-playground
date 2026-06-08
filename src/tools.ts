import { tool } from '@langchain/core/tools';
import { exec, execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { bashDenyReason, resolveInCwd, ROOT } from './engines/guard.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.turbo']);

export const bash = tool(
  async ({ command }) => {
    const reason = bashDenyReason(command);
    if (reason) {
      return `Refused: ${reason}. Stay within the project directory and avoid system-level operations.`;
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
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
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
      path: z
        .string()
        .optional()
        .describe('Directory relative to the project root. Defaults to the root.'),
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
        [
          '-rInE',
          '--exclude-dir=node_modules',
          '--exclude-dir=.git',
          '--exclude-dir=dist',
          '-e',
          pattern,
          target,
        ],
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
    description:
      'Search file contents for a regex pattern across the project (read-only). Returns file:line:match.',
    schema: z.object({
      pattern: z.string().describe('Extended-regex pattern to search for.'),
      path: z
        .string()
        .optional()
        .describe('Directory or file to search, relative to the root. Defaults to the root.'),
    }),
  },
);

// Translate a glob (*, **, ?) into an anchored RegExp. `**/` matches zero or more path
// segments (so `**/*.ts` also matches a root-level file); `*`/`?` stay within one segment.
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

async function walkFiles(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      await walkFiles(resolve(dir, e.name), out);
    } else if (e.isFile()) out.push(resolve(dir, e.name));
  }
}

export const glob = tool(
  async ({ pattern, path }) => {
    try {
      const base = resolveInCwd(path ?? '.');
      const files: string[] = [];
      await walkFiles(base, files);
      const re = globToRegExp(pattern);
      const matches = files
        .filter((f) => re.test(relative(base, f)))
        .map((f) => relative(ROOT, f))
        .sort();
      return matches.length ? matches.join('\n') : 'no matches';
    } catch (err) {
      return `glob failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'glob',
    description:
      'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.py"), skipping node_modules/.git/dist. Returns paths relative to the project root, one per line. "**/*.ts" also matches root-level files, and dotfiles are included. Prefer this over shelling out to find/ls.',
    schema: z.object({
      pattern: z
        .string()
        .describe(
          'Glob pattern: * (within a path segment), ** (across segments), ? (single char).',
        ),
      path: z
        .string()
        .optional()
        .describe('Directory to anchor the search in, relative to the root. Defaults to the root.'),
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
    description:
      'Write (or overwrite) a UTF-8 text file by path, relative to the project directory.',
    schema: z.object({
      path: z.string().describe('File path relative to the project root.'),
      content: z.string().describe('Full file contents to write.'),
    }),
  },
);

export const str_replace = tool(
  async ({ path, old_str, new_str }) => {
    try {
      if (old_str === '') return `str_replace failed: old_str must not be empty.`;
      const target = resolveInCwd(path);
      const content = await readFile(target, 'utf8');
      // split/join does exact-string (not regex) matching and avoids String.replace's
      // $&/$1/$$ interpretation inside new_str. The count enforces the "exactly one" rule.
      const count = content.split(old_str).length - 1;
      if (count === 0)
        return `str_replace failed: old_str not found in ${relative(ROOT, target)}. The match must be exact (whitespace and indentation included).`;
      if (count > 1)
        return `str_replace failed: old_str matches ${count} times in ${relative(ROOT, target)} — ambiguous. Add surrounding context to make it unique.`;
      await writeFile(target, content.split(old_str).join(new_str), 'utf8');
      return `Replaced 1 occurrence in ${relative(ROOT, target)}.`;
    } catch (err) {
      return `str_replace failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'str_replace',
    description:
      'Surgically replace an exact string in an existing file. old_str must appear exactly once (matched verbatim, including whitespace and indentation). Prefer this over write_file when editing — send only the lines that change.',
    schema: z.object({
      path: z.string().describe('File path relative to the project root.'),
      old_str: z.string().describe('Exact text to find. Must match exactly once, verbatim.'),
      new_str: z.string().describe('Replacement text.'),
    }),
  },
);

// Best-effort HTML → readable text: drop script/style/comments, strip tags, decode a few
// common entities (&amp; last, so &amp;lt; doesn't double-decode), collapse whitespace.
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export const web_fetch = tool(
  async ({ url }) => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'user-agent': 'agent-playground/0.1' },
      });
      if (!res.ok) return `web_fetch failed: HTTP ${res.status} ${res.statusText} for ${url}`;
      const contentType = res.headers.get('content-type') ?? '';
      const body = await res.text();
      const text = contentType.includes('html') ? htmlToText(body) : body.trim();
      const MAX = 20_000;
      if (text.length > MAX)
        return `${text.slice(0, MAX)}\n…[truncated ${text.length - MAX} more chars]`;
      return text || '(empty response)';
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError')
        return `web_fetch failed: "${url}" timed out after 10s.`;
      return `web_fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its readable text content (HTML is stripped to plain text; other content types are returned as-is). Use to pull external documentation or resources. 10s timeout.',
    schema: z.object({ url: z.string().describe('The http/https URL to fetch.') }),
  },
);

/** Read-only tools — safe for the chat layer (Zero answers questions directly, no mutations). */
export const readOnlyTools = [read_file, list_dir, grep];

/** Worker tools — read-only set plus the mutating/extra tools (write, edit, glob, fetch, shell). */
export const workerTools = [...readOnlyTools, write_file, str_replace, glob, web_fetch, bash];
