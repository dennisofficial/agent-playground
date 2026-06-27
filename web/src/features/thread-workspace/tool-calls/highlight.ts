/**
 * Per-line syntax highlighting for the dark code/diff frames, reusing highlight.js — the same engine
 * rehype-highlight uses for markdown fences, so the `.hljs-*` token classes themed in `globals.css`
 * apply uniformly. We register only a curated language set off `lib/core` to keep the client bundle
 * small, and highlight line-by-line (a diff interleaves old/new lines, so there's no whole-block to
 * feed); cross-line constructs like block comments degrade to plain text, which is acceptable here.
 */

import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import ini from 'highlight.js/lib/languages/ini';

let registered = false;
function ensureRegistered() {
  if (registered) return;
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('yaml', yaml);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('go', go);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('dockerfile', dockerfile);
  hljs.registerLanguage('ini', ini);
  registered = true;
}

/** Map a file extension (or basename, for e.g. Dockerfile) to a registered highlight.js language id. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', scss: 'css', less: 'css',
  html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  py: 'python',
  yml: 'yaml', yaml: 'yaml',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  toml: 'ini', ini: 'ini', env: 'ini',
};

/** The highlight.js language for a path, or `null` when unknown (caller renders plain escaped text). */
export function langFromPath(path: string): string | null {
  if (!path) return null;
  const base = path.split('/').pop() ?? path;
  if (/^dockerfile/i.test(base)) return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return EXT_LANG[ext] ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Highlight one line into an HTML string of `.hljs-*` spans (safe — highlight.js escapes its input).
 * Returns escaped plain text for unknown languages or on any failure, and `&nbsp;` for a blank line so
 * the row keeps its height.
 */
export function highlightLine(code: string, lang: string | null): string {
  if (!code) return '&nbsp;';
  ensureRegistered();
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
