/**
 * Syntax highlighting for the dark code/diff frames, backed by Shiki (VS Code TextMate grammars) via
 * its JavaScript RegExp engine — no Oniguruma WASM. A single long-lived highlighter singleton is built
 * lazily in the browser with a hand-authored `atlas-term` theme that reproduces the current `--term`
 * palette as inline colors (no CSS token classes). Whole-file tokenization (`whole`) preserves context
 * across lines — fixing multi-line template literals, block comments, and JSX — while per-line
 * tokenization serves non-contiguous rows (grep/diff). `useHighlightTokens` bridges the async load into
 * render: it returns `null` until the highlighter + language are ready, so callers paint plain text with
 * zero layout shift and swap in colors once tokens resolve.
 */

"use client";

import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
  type ThemeRegistration,
  type ThemedToken,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type { ThemedToken };
/** One `ThemedToken[]` per source line. */
export type LineTokens = ThemedToken[][];

/**
 * Custom TextMate theme reproducing the current `--term` token palette on the dark `--term` frame. Because
 * the code surface is always `--term` in both app themes, one dark theme suffices. Copied verbatim from
 * the migration spike (`/playground/shiki-spike/spike.mjs`).
 */
const TERM = {
  bg: "#0e1622",
  fg: "#c5cdd9",
  comment: "#6b7686",
  amber: "#e8983f",
  teal: "#6fb3c9",
  tan: "#d89a5c",
  lavender: "#b89cf0",
} as const;

const atlasTerm = {
  name: "atlas-term",
  type: "dark",
  colors: { "editor.background": TERM.bg, "editor.foreground": TERM.fg },
  tokenColors: [
    {
      scope: [
        "comment",
        "punctuation.definition.comment",
        "string.quoted.docstring",
      ],
      settings: { foreground: TERM.comment, fontStyle: "italic" },
    },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "keyword.control",
        "constant.language",
        "variable.language",
        "keyword.operator.new",
        "entity.name.tag",
        "meta.tag",
      ],
      settings: { foreground: TERM.amber },
    },
    {
      scope: [
        "string",
        "string.template",
        "punctuation.definition.string",
        "constant.other.symbol",
        "entity.other.attribute-name",
        "string.regexp",
      ],
      settings: { foreground: TERM.teal },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language.boolean",
        "support.type",
        "support.class",
        "entity.name.type",
        "meta.type",
        "support.function",
        "variable.parameter",
      ],
      settings: { foreground: TERM.tan },
    },
    {
      scope: [
        "entity.name.function",
        "meta.function-call entity.name.function",
        "entity.name.class",
        "support.constant",
        "meta.definition.function entity.name.function",
      ],
      settings: { foreground: TERM.lavender },
    },
  ],
} satisfies ThemeRegistration;

type LanguageModule = { default: LanguageRegistration[] };

/**
 * Lazy per-language loaders, one per id `langFromPath` can return. Each import is a distinct dynamic
 * import so the bundler code-splits every grammar; a language is loaded on first use. Every value that
 * `EXT_LANG` maps to MUST be a key here.
 */
const LANG_LOADERS: Record<string, () => Promise<LanguageModule>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  bash: () => import("@shikijs/langs/bash"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  xml: () => import("@shikijs/langs/xml"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  yaml: () => import("@shikijs/langs/yaml"),
  sql: () => import("@shikijs/langs/sql"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  docker: () => import("@shikijs/langs/docker"),
  diff: () => import("@shikijs/langs/diff"),
  toml: () => import("@shikijs/langs/toml"),
  terraform: () => import("@shikijs/langs/terraform"),
  ini: () => import("@shikijs/langs/ini"),
  vue: () => import("@shikijs/langs/vue"),
};

/**
 * Common markdown fence info strings (```js, ```py, …) that differ from the canonical `LANG_LOADERS`
 * ids. Normalized to their canonical id so fences resolve without duplicating loader entries. Fence ids
 * already matching a `LANG_LOADERS` key (js's `javascript`, `tsx`, …) pass through untouched.
 */
const LANG_ALIAS: Record<string, string> = {
  cjs: "javascript",
  dockerfile: "docker",
  js: "javascript",
  json5: "json",
  jsonc: "json",
  mjs: "javascript",
  ts: "typescript",
  py: "python",
  shell: "bash",
  shellscript: "bash",
  yml: "yaml",
  sh: "bash",
  zsh: "bash",
  md: "markdown",
  rs: "rust",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "terraform",
};

/** Resolve a raw language id (file-derived or a markdown fence info string) to a canonical Shiki id. */
function canonicalLang(lang: string): string {
  const normalized = lang.trim().toLowerCase();
  return LANG_ALIAS[normalized] ?? normalized;
}

/**
 * The highlighter is a module-level singleton built once in the browser (mirrors the repo's lazy
 * mermaid import). `readyHighlighter` is the sync handle the hook reads in-render once the async build
 * resolves.
 */
let highlighterPromise: Promise<HighlighterCore> | null = null;
let readyHighlighter: HighlighterCore | null = null;
let highlighterFailed = false;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [atlasTerm],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
      .then((hi) => (readyHighlighter = hi))
      .catch((err: unknown) => {
        highlighterFailed = true;
        throw err;
      });
  }
  return highlighterPromise;
}

const langPromises = new Map<string, Promise<void>>();
const failedLangs = new Set<string>();

/** Ensure `lang`'s grammar is loaded into `hi`; returns false for an unknown (non-curated) id. */
async function ensureLang(hi: HighlighterCore, lang: string): Promise<boolean> {
  const loader = LANG_LOADERS[lang];
  if (!loader || failedLangs.has(lang)) return false;
  if (hi.getLoadedLanguages().includes(lang)) return true;
  if (!langPromises.has(lang)) {
    langPromises.set(lang, hi.loadLanguage(loader).then(() => {}));
  }
  try {
    await langPromises.get(lang);
    return true;
  } catch {
    failedLangs.add(lang);
    langPromises.delete(lang);
    return false;
  }
}

/** Whole-file tokenization — one pass, cross-line context preserved. Caller guarantees hi + lang ready. */
function tokenizeWhole(
  hi: HighlighterCore,
  code: string,
  lang: string,
): LineTokens {
  return hi.codeToTokens(code, { lang, theme: "atlas-term" }).tokens;
}

/** Per-line tokenization — each line highlighted in isolation, for non-contiguous rows (grep/diff). */
function tokenizeLines(
  hi: HighlighterCore,
  lines: string[],
  lang: string,
): LineTokens {
  return lines.map(
    (l) =>
      hi.codeToTokens(l.length ? l : " ", { lang, theme: "atlas-term" })
        .tokens[0] ?? [],
  );
}

/** Map a file extension (or basename, for e.g. Dockerfile) to a Shiki language id, or `null`. */
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  vue: "vue",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  py: "python",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  go: "go",
  rs: "rust",
  toml: "toml",
  ini: "ini",
  env: "ini",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "terraform",
};

/** The Shiki language id for a path, or `null` when unknown (caller renders plain escaped text). */
export function langFromPath(path: string): string | null {
  if (!path) return null;
  const base = path.split("/").pop() ?? path;
  if (/^dockerfile/i.test(base)) return "docker";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANG[ext] ?? null;
}

/** Skip highlighting inputs large enough that a single synchronous tokenization pass would jank. */
const MAX_HIGHLIGHT_LENGTH = 2_000_000;

/**
 * Bridge Shiki's async load into render. Returns tokens derived from the CURRENT `code` every render
 * (never persisted state), so it can never paint a previous file's tokens against new code. Returns
 * `null` until the highlighter + language are ready → callers render plain text (no layout shift, no
 * stale content). Once loaded, switching to another file of the same loaded lang recomputes
 * synchronously in-render, so tokens appear on the first render with no flash. SSR renders plain text
 * (the highlighter is client-only), then the client hydrates and colorizes — identical DOM.
 */
export function useHighlightTokens(
  code: string,
  lang: string | null,
  whole: boolean,
): LineTokens | null {
  // Bumped by the effect once an async highlighter/lang load finishes, so the memo re-runs.
  const [ready, setReady] = useState(0);
  const canonical = lang ? canonicalLang(lang) : null;

  const tokens = useMemo<LineTokens | null>(() => {
    if (!canonical || !LANG_LOADERS[canonical] || !readyHighlighter) return null;
    if (code.length > MAX_HIGHLIGHT_LENGTH) return null;
    if (!readyHighlighter.getLoadedLanguages().includes(canonical)) return null;
    try {
      return whole
        ? tokenizeWhole(readyHighlighter, code, canonical)
        : tokenizeLines(readyHighlighter, code.split("\n"), canonical);
    } catch {
      return null;
    }
    // `ready` is a dep so the memo re-runs once the async load completes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, canonical, whole, ready]);

  useEffect(() => {
    if (
      tokens ||
      !canonical ||
      !LANG_LOADERS[canonical] ||
      failedLangs.has(canonical) ||
      highlighterFailed
    )
      return; // resolved, failed, or nothing loadable
    if (code.length > MAX_HIGHLIGHT_LENGTH) return;
    let cancelled = false;
    (async () => {
      try {
        const hi = await getHighlighter();
        const loaded = await ensureLang(hi, canonical);
        if (!cancelled && loaded) setReady((v) => v + 1);
      } catch {
        highlighterFailed = true;
        if (!cancelled) setReady((v) => v + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tokens, canonical, code, whole]);

  return tokens;
}

const NBSP = " ";

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;

/**
 * Render one line's tokens as colored spans, or plain text (escaped by React) when `tokens` is null
 * (still loading / unknown lang). A blank line keeps its row height via a non-breaking space. Shared by
 * every renderer so span styling never drifts.
 */
export function renderTokenLine(
  tokens: ThemedToken[] | null | undefined,
  code: string,
): ReactNode {
  if (!tokens) return code.length ? code : NBSP;
  if (tokens.length === 0) return NBSP;
  return tokens.map((t, i) => (
    <span
      key={i}
      style={{
        color: t.color,
        fontStyle: (t.fontStyle ?? 0) & FONT_STYLE_ITALIC ? "italic" : undefined,
        fontWeight: (t.fontStyle ?? 0) & FONT_STYLE_BOLD ? 600 : undefined,
      }}
    >
      {t.content}
    </span>
  ));
}
