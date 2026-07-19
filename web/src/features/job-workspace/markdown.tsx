'use client';

import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  Hand,
  Hourglass,
  Info,
  Lock,
  Maximize2,
  RefreshCw,
  Rocket,
  RotateCcw,
  Search,
  Send,
  Settings,
  Siren,
  Wrench,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { JsonView, allExpanded, darkStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton, TerminalChromeBar, WrapButton, useCopied } from './terminal-chrome';
import { renderTokenLine, useHighlightTokens } from './tool-calls/highlight';

/**
 * Markdown renderer for assistant prose in the conversation — ported from the "Atlas Conversation View"
 * handoff. Component overrides (not the typography plugin) so headings use the display font, code blocks
 * get the dark terminal treatment, and tables/blockquotes/lists match the mock pixel-for-pixel.
 */

/**
 * Optional actions a host (the Conversation) can expose to deeply-nested markdown content. Today it's just
 * `sendToThread`, which lets a broken `mermaid` diagram offer a "Send to Atlas" button that posts its
 * source into the current thread. Absent (null) in contexts with no thread — the buttons hide gracefully.
 */
export interface MarkdownActions {
  sendToThread: (text: string) => void;
}
const MarkdownActionsContext = createContext<MarkdownActions | null>(null);
export const MarkdownActionsProvider = MarkdownActionsContext.Provider;

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [wrapped, setWrapped] = useState(false);
  // Whole-block tokenization — a fence is contiguous, so cross-line context (multi-line strings,
  // block comments, JSX) is preserved. `null` until the highlighter + language resolve → plain text.
  const lineTokens = useHighlightTokens(code, lang ?? null, true);
  const lines = useMemo(() => code.split('\n'), [code]);
  return (
    <div
      className="my-3 overflow-hidden rounded-[9px] border border-border"
      style={{ background: 'var(--term)' }}
    >
      <TerminalChromeBar
        label={lang}
        actions={
          <>
            <WrapButton wrapped={wrapped} onToggle={() => setWrapped((w) => !w)} />
            <CopyButton text={code} />
          </>
        }
      />
      <pre
        className={`m-0 px-3.5 py-3 font-mono text-[11.5px] leading-[1.7] ${
          wrapped ? 'whitespace-pre-wrap wrap-break-word' : 'overflow-x-auto'
        }`}
        style={{ color: 'var(--term-fg)' }}
      >
        {lineTokens
          ? lines.map((ln, i) => (
              <span key={i}>
                {i > 0 ? '\n' : null}
                {renderTokenLine(lineTokens[i], ln)}
              </span>
            ))
          : renderTokenLine(null, code)}
      </pre>
    </div>
  );
}

// ── JSON tree ──────────────────────────────────────────────────────────────────────────────────────
// A ```json fence whose content is an object/array renders as an interactive collapsible tree
// (react-json-view-lite) instead of a flat, often-minified code line. Colors mirror the --term token
// palette (the same hues the Shiki atlas-term theme emits); the `!` important classes win over the
// package CSS regardless of stylesheet order. Structure (indentation + expand/collapse icons) comes
// from spreading darkStyles.
const JSON_VIEW_STYLES = {
  ...darkStyles,
  container: `${darkStyles.container} !bg-transparent`,
  label: `${darkStyles.label} text-[#b89cf0]!`, // object keys — lavender (function/title)
  stringValue: `${darkStyles.stringValue} text-[#6fb3c9]!`, // teal (string)
  numberValue: `${darkStyles.numberValue} text-[#d89a5c]!`,
  booleanValue: `${darkStyles.booleanValue} text-[#e8983f]!`, // amber
  nullValue: `${darkStyles.nullValue} text-[#e8983f]!`,
  undefinedValue: `${darkStyles.undefinedValue} text-[#e8983f]!`,
  punctuation: `${darkStyles.punctuation} text-(--term-dim)!`,
  otherValue: `${darkStyles.otherValue} text-(--term-fg)!`,
};

/** Parse `raw` as JSON, returning it only when it's a non-null object/array (what JsonView renders);
 *  anything else (scalar or malformed) returns null so the caller falls back to the plain code frame. */
function parseJsonContainer(raw: string): object | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function JsonBlock({ value }: { value: object }) {
  return (
    <div
      className="my-3 overflow-hidden rounded-[9px] border border-border"
      style={{ background: 'var(--term)' }}
    >
      <TerminalChromeBar
        label="json"
        actions={<CopyButton text={JSON.stringify(value, null, 2)} />}
      />
      <div
        className="overflow-x-auto px-3.5 py-3 font-mono text-[11.5px] leading-[1.7]"
        style={{ color: 'var(--term-fg)' }}
      >
        <JsonView
          data={value}
          style={JSON_VIEW_STYLES}
          shouldExpandNode={allExpanded}
          clickToExpandNode
        />
      </div>
    </div>
  );
}

// ── Mermaid (lazy) ─────────────────────────────────────────────────────────────────────────────────
// Inline ```mermaid fences render as real diagrams. mermaid is heavy + DOM-only, so it's dynamically
// imported (kept out of the main bundle), client-side, pulling its palette from the live CSS tokens so
// diagrams match the design system (and re-match it live on a theme switch — see the theme store below).
// securityLevel 'strict' DOMPurify-sanitizes the SVG (diagrams are agent-authored), which makes the
// dangerouslySetInnerHTML below safe.
let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
/** Import-only — memoized so the heavy module is fetched once regardless of theme. */
function loadMermaid() {
  if (!mermaidReady) mermaidReady = import('mermaid').then((mod) => mod.default);
  return mermaidReady;
}

/** (Re-)initialize mermaid from the CURRENTLY live CSS custom properties, so the diagram palette tracks
 *  whichever theme is active at call time rather than whatever was live the first time mermaid loaded. */
function applyMermaidTheme(mermaid: Awaited<ReturnType<typeof loadMermaid>>) {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // We catch render errors and show our own inline fallback; without this, mermaid ALSO
    // injects its default "bomb" error SVG into the DOM. Suppress it so only our UI shows.
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: v('--f-mono', 'ui-monospace, monospace'),
    themeVariables: {
      background: 'transparent',
      primaryColor: v('--surface-2', '#f6f6f3'),
      primaryTextColor: v('--text', '#1a1d23'),
      primaryBorderColor: v('--border-2', '#d3d3cc'),
      secondaryColor: v('--surface-3', '#eeeee9'),
      tertiaryColor: v('--surface', '#ffffff'),
      lineColor: v('--dim', '#5c6573'),
      textColor: v('--text', '#1a1d23'),
    },
  });
}

// ── Theme-reactive re-init ────────────────────────────────────────────────────────────────────────
// next-themes applies `data-theme` on <html> from its OWN useEffect, and React 19 flushes CHILD passive
// effects before PARENT ones — so a naive "read data-theme inside the Mermaid component's effect" can run
// before next-themes has actually applied the new attribute. Reacting to a MutationObserver on the
// attribute instead is ordering-independent: it only fires once the attribute (and the CSS vars it
// controls) are truly live.
let appliedMermaidTheme: string | null = null;
let themeVersion = 0;
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function currentThemeKey() {
  if (typeof document === 'undefined') return 'daylight';
  const key = document.documentElement.getAttribute('data-theme');
  // next-themes' pre-paint script writes raw light/dark before the runtime value map writes daylight/night.
  if (key === 'dark') return 'night';
  if (key === 'light' || !key) return 'daylight';
  return key;
}
function ensureThemeObserver() {
  if (themeObserver || typeof document === 'undefined') return;
  themeObserver = new MutationObserver(() => {
    if (currentThemeKey() === appliedMermaidTheme) return; // unrelated attribute write
    appliedMermaidTheme = null; // force re-init (with now-live CSS vars) on next ensureMermaid
    mermaidCache.clear(); // cached SVGs bake in the old palette — drop them
    themeVersion++;
    themeListeners.forEach((l) => l());
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}
function subscribeTheme(cb: () => void) {
  ensureThemeObserver();
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}
function getThemeVersion() {
  return themeVersion;
}

/** Load mermaid and (re-)apply its theme if the live data-theme has changed since the last init. */
async function ensureMermaid() {
  const mermaid = await loadMermaid();
  const key = currentThemeKey();
  if (appliedMermaidTheme !== key) {
    applyMermaidTheme(mermaid);
    appliedMermaidTheme = key;
    mermaidCache.clear();
  }
  return mermaid;
}

/** Flatten code-block children to plain text (string, number, or nested markdown nodes). */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

/**
 * Strip mermaid's inline `max-width` clamp (which uniformly downscales wide diagrams until text is
 * illegible) and read the intrinsic px size from the viewBox, so we can size the diagram ourselves.
 */
function parseSvg(raw: string): { svg: string; w: number; h: number } {
  const vb = /viewBox="[\d.\-]+ [\d.\-]+ ([\d.\-]+) ([\d.\-]+)"/.exec(raw);
  return {
    svg: raw.replace(/max-width:\s*[\d.]+px;?/g, ''),
    w: vb ? Math.round(parseFloat(vb[1])) : 0,
    h: vb ? Math.round(parseFloat(vb[2])) : 0,
  };
}

/** Rendered SVGs by TRIMMED diagram source, tagged with the theme key they were rendered under. A diagram
 *  already seen elsewhere in the transcript (in the SAME live theme) can reuse its parsed result instead of
 *  replaying the async render and the placeholder→SVG size jump it causes. The theme tag matters because a
 *  theme flip mid-flight (e.g. `warmMermaidDiagrams` still looping when the operator switches theme) can
 *  otherwise write a stale-palette SVG back into a freshly-cleared cache with nothing to invalidate it
 *  afterward — see {@link getCachedMermaid}. */
const mermaidCache = new Map<string, { theme: string; svg: string; w: number; h: number }>();

/** Cache lookup that also validates the entry was rendered under the CURRENTLY live theme — a hit tagged
 *  with a stale theme (see above) is treated as a miss so callers re-render instead of showing the wrong
 *  palette. */
function getCachedMermaid(chart: string) {
  const entry = mermaidCache.get(chart);
  return entry && entry.theme === currentThemeKey() ? entry : undefined;
}

/** Extract trimmed ```mermaid fence sources from raw markdown text. */
export function extractMermaidSources(text: string): string[] {
  const out: string[] = [];
  const re = /```mermaid\n([\s\S]*?)```/g; // same shape as conversation.tsx MERMAID_FENCE
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1].replace(/\n$/, '').trim());
  return out;
}

let warmId = 0;
/** Render each not-yet-cached diagram off-screen so mermaidCache holds its real {svg,w,h} BEFORE its row is
 *  measured/enters the viewport. Pure in source (theme fixed at init), so it is the same result the live
 *  component would produce. Broken diagrams are skipped (they render an error frame at a small height,
 *  not an aspect-ratio box, so they need no warm). Renders sequentially to bound main-thread cost. */
export async function warmMermaidDiagrams(sources: string[]): Promise<void> {
  const todo = [...new Set(sources.map((s) => s.trim()))].filter(
    (s) => s.length > 0 && !getCachedMermaid(s),
  );
  if (todo.length === 0) return;
  // ensureMermaid (and the theme key) are re-checked EVERY iteration, not once before the loop — a theme
  // flip mid-flight re-applies the palette and is reflected in the tag each entry is written with, so a
  // fast switch can no longer poison the cache with wrong-palette, theme-untagged SVGs (see mermaidCache).
  for (const src of todo) {
    if (getCachedMermaid(src)) continue;
    let mermaid: Awaited<ReturnType<typeof loadMermaid>>;
    try {
      mermaid = await ensureMermaid();
    } catch {
      return; // module failed to load (e.g. a transient chunk-load error) — nothing to warm this pass
    }
    const key = currentThemeKey();
    try {
      await mermaid.parse(src);
      const { svg } = await mermaid.render(`mmd-warm-${warmId++}`, src);
      mermaidCache.set(src, { theme: key, ...parseSvg(svg) });
    } catch {
      /* leave uncached — the error frame reserves the same mermaidReservePx height as the loading
         placeholder (see Mermaid's error branch below), so it needs no warming to avoid a shift */
    }
  }
}

/** A header-bar action button shared by the diagram frame (copy / expand / fix). */
function FrameBtn({
  onClick,
  title,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[10px] text-dim transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-dim"
    >
      {children}
    </button>
  );
}

/** The card chrome shared by every mermaid state: a labelled header bar (with actions) over a body. */
function MermaidFrame({
  label,
  actions,
  children,
}: {
  label: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="my-3 overflow-hidden rounded-[9px] border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.75">
        <span className="font-mono text-[10px] lowercase text-faint">{label}</span>
        <span className="flex-1" />
        {actions}
      </div>
      {children}
    </div>
  );
}

const MERMAID_RESERVE_MIN = 200;
/** Tall diagrams (deep flowcharts) really do render past 1000px on a phone-width column — a low cap is
 *  exactly what left big diagrams badly under-reserved, so the placeholder jumped when the SVG landed. */
const MERMAID_RESERVE_MAX = 1600;

function clampMermaidReserve(px: number): number {
  return Math.min(Math.max(Math.round(px), MERMAID_RESERVE_MIN), MERMAID_RESERVE_MAX);
}

/**
 * Approximate rendered body height (px) of a Mermaid diagram from its SOURCE, reserved by the loading
 * placeholder AND used by the transcript virtualizer's row estimate — the two MUST agree so the async
 * placeholder→SVG swap barely changes the row height. A flat "px per source line" is a poor proxy because
 * height depends on the diagram KIND: a vertical flowchart grows with its rank depth (tall), while a
 * sequence diagram grows with its message count and renders wide-and-short — sizing both by raw line count
 * over-reserves sequences and (with a low cap) under-reserves flowcharts. So estimate per kind instead.
 * Still only an approximation — the exact height isn't knowable until Mermaid lays the diagram out; the
 * virtualizer's own resize compensation absorbs the residual.
 */
export function mermaidReservePx(source: string): number {
  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines[0]?.toLowerCase() ?? '';
  // Sequence diagrams: height ≈ header chrome + one row per message arrow; participants add width, not height.
  if (header.startsWith('sequencediagram')) {
    const messages = lines.filter((line) => /--?>>?/.test(line)).length;
    return clampMermaidReserve(120 + messages * 44);
  }
  // Flowchart / graph / stateDiagram (the vertical, dominant kinds): height tracks the number of ranks,
  // proxied by edge count (`-->`/`->`), which avoids double-counting standalone node-label lines.
  const edges = lines.filter((line) => line.includes('->')).length;
  return clampMermaidReserve(Math.max(edges, 1) * 84);
}

function Mermaid({ chart }: { chart: string }) {
  // useId is colon-bearing; mermaid's render id must be a valid DOM/CSS id, so strip non-word chars.
  const renderId = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [result, setResult] = useState<{
    svg: string;
    w: number;
    h: number;
  } | null>(() => getCachedMermaid(chart.trim()) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [sent, setSent] = useState(false);
  const [copied, copy] = useCopied();
  const actions = useContext(MarkdownActionsContext);
  // Re-runs the render effect below on a live theme switch (see the MutationObserver-driven store
  // above `Mermaid`) — independent of next-themes/useTheme, and of React 19's child-before-parent
  // passive-effect ordering, since it only fires once the new data-theme attribute is truly live.
  const themeVersion = useSyncExternalStore(subscribeTheme, getThemeVersion, () => 0);

  useEffect(() => {
    let cancelled = false;
    // Mermaid render is pure in its source + theme, so a previously-rendered diagram (in the CURRENT
    // theme) can reuse its cached SVG instead of replaying the placeholder→SVG transition — this is what
    // makes a diagram seen once elsewhere in the transcript mount at its FINAL size immediately.
    // getCachedMermaid rejects a hit tagged with a stale theme (see mermaidCache), so a wrong-palette
    // entry left behind by an in-flight warm during a fast theme switch is treated as a miss and re-rendered.
    const cached = getCachedMermaid(chart.trim());
    if (cached) {
      setResult(cached);
      setError(null);
      return;
    }
    // Don't clear an already-rendered SVG here — e.g. on a theme switch the cache was just dropped, but
    // the old-themed diagram stays visible until the freshly re-rendered one replaces it, so re-render
    // never flashes back to the loading placeholder.
    setError(null);
    ensureMermaid()
      .then(async (mermaid) => {
        // Capture the theme key ensureMermaid just applied (not whatever is live when the render settles)
        // so the cache entry is tagged with the palette actually baked into this SVG.
        const key = currentThemeKey();
        // Validate BEFORE rendering: parse() throws on bad syntax but injects nothing, so mermaid's
        // default "bomb" error SVG never lands in the DOM — independent of whether suppressErrorRendering
        // took effect at init time (initialize runs once via a module singleton).
        await mermaid.parse(chart);
        const { svg } = await mermaid.render(renderId, chart);
        return { svg, key };
      })
      .then(({ svg, key }) => {
        if (!cancelled) {
          const parsed = parseSvg(svg);
          mermaidCache.set(chart.trim(), { theme: key, ...parsed });
          setResult(parsed);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [chart, renderId, themeVersion]);

  const copyButton = (
    <FrameBtn title="Copy mermaid source" onClick={() => copy(chart)}>
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? 'copied' : 'copy'}
    </FrameBtn>
  );

  // A malformed diagram keeps the same card chrome — we just can't draw it. The source renders in the body
  // (where the graph would be) and the header offers "fix with Atlas".
  if (error) {
    return (
      <MermaidFrame
        label="mermaid"
        actions={
          <>
            {copyButton}
            {actions ? (
              <FrameBtn
                title="Send this broken diagram to Atlas to fix"
                disabled={sent}
                onClick={() => {
                  // Fence the source as plain text (no `mermaid` lang) so the operator's own message
                  // doesn't re-trigger a failed render — Atlas reads the raw source and fixes it.
                  actions.sendToThread(
                    `This mermaid diagram failed to render. Please fix the syntax.\n\n` +
                      `Parse error: ${error}\n\n` +
                      '```\n' +
                      chart +
                      '\n```',
                  );
                  setSent(true);
                }}
              >
                <Send size={10} />
                {sent ? 'sent to Atlas' : 'fix with Atlas'}
              </FrameBtn>
            ) : null}
          </>
        }
      >
        {/* Reserve the same height the loading placeholder (and premeasure's cold-read) used, so an
            unwarmed/broken diagram's row doesn't grow or shrink when it settles into this error frame. */}
        <div style={{ minHeight: mermaidReservePx(chart) }}>
          <p className="border-b border-border px-3.5 py-2 font-mono text-[10px] leading-normal text-red">
            failed to render — {error}
          </p>
          <pre className="m-0 overflow-x-auto px-3.5 py-3 font-mono text-[11.5px] leading-[1.7] text-dim">
            {chart}
          </pre>
        </div>
      </MermaidFrame>
    );
  }
  if (!result) {
    // Reserve the body height while the SVG renders asynchronously. Without this the row mounts (and is
    // measured by the transcript virtualizer) at the tiny placeholder height, then pops taller when the
    // diagram resolves — a visible jump. The reservation is derived from the diagram SOURCE (see
    // mermaidReservePx) and matches the rendered body's min-height below, so the loading→diagram transition
    // changes height by little or nothing.
    return (
      <MermaidFrame label="mermaid">
        <div
          className="flex items-center justify-center px-4 py-6 font-mono text-[10.5px] text-faint"
          style={{ minHeight: mermaidReservePx(chart) }}
        >
          rendering diagram…
        </div>
      </MermaidFrame>
    );
  }
  return (
    <>
      <MermaidFrame
        label="mermaid"
        actions={
          <>
            {copyButton}
            <FrameBtn title="Expand diagram" onClick={() => setZoomed(true)}>
              <Maximize2 size={10} /> expand
            </FrameBtn>
          </>
        }
      >
        {/* Fit to width, but never upscale past the intrinsic size — so the diagram never breaks the doc
            layout, and the whole thing is click-to-expand for a readable view. The box hugs the SVG: it's
            forced to width:100%/height:auto (below), so it already carries its own aspect ratio — no height
            reserve or vertical centering here, which would leave dead space around wide/short diagrams. */}
        <div
          onClick={() => setZoomed(true)}
          className="mx-auto flex cursor-zoom-in flex-col p-4 [&>svg]:h-auto! [&>svg]:w-full!"
          style={{
            maxWidth: result.w || undefined,
            // Lock the box's aspect ratio so its height is a synchronous function of column width the
            // instant `result` is known — one deterministic swap instead of waiting for the SVG (forced to
            // width:100%/height:auto above) to reflow internally.
            aspectRatio: result.w > 0 && result.h > 0 ? `${result.w} / ${result.h}` : undefined,
          }}
          // eslint-disable-next-line react/no-danger -- mermaid SVG; securityLevel 'strict' sanitizes it
          dangerouslySetInnerHTML={{ __html: result.svg }}
        />
      </MermaidFrame>
      {zoomed ? (
        <MermaidLightbox
          svg={result.svg}
          w={result.w}
          h={result.h}
          onClose={() => setZoomed(false)}
        />
      ) : null}
    </>
  );
}

/** Fullscreen, zoomable, pannable view of one diagram — the readable view for dense plan diagrams. */
function MermaidLightbox({
  svg,
  w,
  h,
  onClose,
}: {
  svg: string;
  w: number;
  h: number;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  // Start at fit-to-viewport (capped at 2× so a small diagram doesn't blow up), then zoom/pan from there.
  const fit = () => {
    if (typeof window === 'undefined' || w! || !h) return 1;
    const s = Math.min((window.innerWidth - 96) / w, (window.innerHeight - 150) / h);
    return Math.max(0.25, Math.min(2, Number(s.toFixed(2))));
  };
  const [scale, setScale] = useState(fit);
  const zoom = (f: number) =>
    setScale((s) => Math.max(0.25, Math.min(4, Number((s * f).toFixed(2)))));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-90 flex flex-col" role="dialog" aria-modal>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.55)' }} />
      <div className="relative z-10 flex items-center justify-between border-b border-border bg-panel px-3 py-2">
        <span className="font-mono text-[9px] tracking-[0.16em] text-faint">DIAGRAM</span>
        <div className="flex items-center gap-0.5">
          <ToolBtn onClick={() => zoom(1 / 1.25)} title="Zoom out">
            <ZoomOut size={14} />
          </ToolBtn>
          <span className="w-11 text-center font-mono text-[11px] text-dim">
            {Math.round(scale * 100)}%
          </span>
          <ToolBtn onClick={() => zoom(1.25)} title="Zoom in">
            <ZoomIn size={14} />
          </ToolBtn>
          <ToolBtn onClick={() => setScale(fit())} title="Fit to screen">
            <RotateCcw size={13} />
          </ToolBtn>
          <div className="mx-1 h-4 w-px bg-border" />
          <ToolBtn onClick={onClose} title="Close (Esc)">
            <X size={15} />
          </ToolBtn>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="relative z-10 flex-1 overflow-auto"
        // Clicking the grayed-out area (anything that isn't the diagram card) closes the lightbox.
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('[data-mmd-card]')) onClose();
        }}
      >
        {/* min-h/w-full + flex centering keeps the diagram centered when it fits, and scrollable when it
            doesn't. The diagram sits on its own solid surface card so it reads over the dark backdrop. */}
        <div className="flex min-h-full min-w-full items-center justify-center p-8">
          {/* Drag the diagram itself to pan (like an image viewer); clicks elsewhere fall through to close. */}
          <div
            data-mmd-card
            className="shrink-0 cursor-grab touch-none rounded-lg border border-border bg-surface p-5 shadow-(--shadow-card) active:cursor-grabbing"
            onPointerDown={(e) => {
              const el = scrollRef.current;
              if (!el) return;
              drag.current = {
                x: e.clientX,
                y: e.clientY,
                l: el.scrollLeft,
                t: el.scrollTop,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const el = scrollRef.current;
              if (!el || !drag.current) return;
              el.scrollLeft = drag.current.l - (e.clientX - drag.current.x);
              el.scrollTop = drag.current.t - (e.clientY - drag.current.y);
            }}
            onPointerUp={() => (drag.current = null)}
          >
            <div
              className="[&>svg]:h-full! [&>svg]:w-full!"
              style={{ width: (w || 300) * scale, height: (h || 200) * scale }}
              // eslint-disable-next-line react/no-danger -- mermaid SVG; securityLevel 'strict' sanitizes it
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ToolBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-dim transition hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  );
}

/**
 * Single source of truth for rendering an inline/block `<code>`: a ```mermaid fence → diagram, a fenced
 * block → {@link CodeBlock}, else a plain code chip. When`resolveFileLink` is provided (spec/plan
 * panes), an inline span that names a manifest-verified repo file becomes a clickable {@link FilePill}
 * instead of a plain chip. Both `COMPONENTS.code` and the file-link override delegate here so chip styling
 * and block detection never drift.
 */
function renderCode({
  className,
  children,
  resolveFileLink,
}: {
  className?: string;
  children?: ReactNode;
  resolveFileLink?: (raw: string) => { url: string; onSelect: () => void } | null;
}) {
  const cls = className ?? '';
  const match = /language-(\w+)/.exec(cls);
  // A ```mermaid fence becomes a rendered diagram instead of a code frame.
  if (match?.[1] === 'mermaid') return <Mermaid chart={nodeText(children).replace(/\n$/, '')} />;
  // A ```json fence whose content is an object/array renders as an interactive collapsible tree;
  // invalid or scalar JSON falls through to the normal code frame below.
  if (match?.[1] === 'json') {
    const parsed = parseJsonContainer(nodeText(children).replace(/\n$/, ''));
    if (parsed) return <JsonBlock value={parsed} />;
  }
  // A fence carries a `language-*` class (react-markdown tags it independently of any highlighter);
  // fall back to a newline sniff for the rare un-highlighted block.
  const isBlock = Boolean(match) || String(children ?? '').includes('\n');
  if (isBlock) return <CodeBlock lang={match?.[1]} code={nodeText(children).replace(/\n$/, '')} />;
  // Inline span: linkify a manifest-verified file path into a pill (spec/plan panes only).
  if (resolveFileLink) {
    const link = resolveFileLink(nodeText(children));
    if (link)
      return (
        <FilePill url={link.url} onSelect={link.onSelect}>
          {children}
        </FilePill>
      );
  }
  return (
    <code
      className="rounded-[3px] px-1.25 py-px font-mono text-[12px]"
      style={{ background: 'var(--surface-3)' }}
    >
      {children}
    </code>
  );
}

// ── Slack shortcode → inline icon ────────────────────────────────────────────────────────────────
// Harness/system status messages carry Slack-era emoji shortcodes (`:rocket:`, `:warning:`, …). No
// surface converts them anymore (Atlas is web-only), so they used to leak through as literal text. We
// map the known ones to real Lucide icons at render time: a small remark pass splits each `:name:` out
// of the text stream into a custom `shortcode-icon` node (mdast `data.hName`/`hProperties`), which the
// COMPONENTS entry below renders as the toned icon. Unknown `:tokens:` are left untouched.
const SHORTCODE_ICONS: Record<string, { Icon: LucideIcon; tone: string }> = {
  rocket: { Icon: Rocket, tone: 'text-accent' },
  white_check_mark: { Icon: CheckCircle2, tone: 'text-green' },
  x: { Icon: XCircle, tone: 'text-red' },
  no_entry: { Icon: Ban, tone: 'text-red' },
  warning: { Icon: AlertTriangle, tone: 'text-amber' },
  rotating_light: { Icon: Siren, tone: 'text-red' },
  information_source: { Icon: Info, tone: 'text-blue' },
  lock: { Icon: Lock, tone: 'text-red' },
  mag: { Icon: Search, tone: 'text-dim' },
  hourglass_flowing_sand: { Icon: Hourglass, tone: 'text-amber' },
  raising_hand: { Icon: Hand, tone: 'text-amber' },
  hammer_and_wrench: { Icon: Wrench, tone: 'text-dim' },
  gear: { Icon: Settings, tone: 'text-dim' },
  recycle: { Icon: RefreshCw, tone: 'text-dim' },
  clipboard: { Icon: ClipboardList, tone: 'text-dim' },
};

const SHORTCODE_RE = /:([a-z0-9_+]+):/g;

/** Minimal mdast shape this pass touches — a container with `children`, or a `text` leaf with `value`. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** Split a text value on known `:shortcode:` tokens into interleaved text + `shortcode-icon` nodes.
 *  Returns a single unchanged text node when nothing matched. */
function splitShortcodes(value: string): MdNode[] {
  const parts: MdNode[] = [];
  let last = 0;
  SHORTCODE_RE.lastIndex = 0;
  for (let m = SHORTCODE_RE.exec(value); m; m = SHORTCODE_RE.exec(value)) {
    if (!(m[1] in SHORTCODE_ICONS)) continue;
    if (m.index > last) parts.push({ type: 'text', value: value.slice(last, m.index) });
    parts.push({
      type: 'shortcodeIcon',
      data: { hName: 'shortcode-icon', hProperties: { name: m[1] } },
    });
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return [{ type: 'text', value }];
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
  return parts;
}

/** remark plugin: rewrite `:shortcode:` runs inside text nodes into inline icon nodes. Only descends
 *  into containers (`children`); `code`/`inlineCode` are leaves with no `children`, so fenced/inline
 *  code is never rewritten. */
function remarkShortcodeIcons() {
  const walk = (node: MdNode): void => {
    if (!node.children) return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text' && typeof child.value === 'string' && child.value.includes(':')) {
        next.push(...splitShortcodes(child.value));
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: MdNode) => walk(tree);
}

/** Renders a mapped `:shortcode:` as a small, baseline-aligned Lucide icon. Decorative — the message
 *  text carries the meaning — so it's aria-hidden. Unknown names never reach here (the remark pass only
 *  emits nodes for names in SHORTCODE_ICONS). */
function ShortcodeIcon({ name }: { name?: string }) {
  const entry = name ? SHORTCODE_ICONS[name] : undefined;
  if (!entry) return null;
  const { Icon, tone } = entry;
  return (
    <Icon
      size={14}
      strokeWidth={2}
      aria-hidden
      className={`inline-block shrink-0 ${tone}`}
      style={{ verticalAlign: '-0.18em' }}
    />
  );
}

const COMPONENTS: Components = {
  // Custom inline element emitted by remarkShortcodeIcons. Its tag name isn't in JSX.IntrinsicElements,
  // so the entry is attached via a cast (react-markdown maps the hast tag name → this component).
  ...({ 'shortcode-icon': ShortcodeIcon } as unknown as Components),
  h1: ({ children }) => (
    <h1 className="mb-1 mt-1 font-disp text-[21px] font-bold leading-tight tracking-[-0.02em] text-text">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-4.5 font-disp text-[16.5px] font-bold tracking-[-0.01em] text-text">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-3.5 font-disp text-[14px] font-bold tracking-[-0.01em] text-text">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="my-2 text-[14px] leading-[1.62] text-text first:mt-0 last:mb-0">{children}</p>
  ),
  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => <ExternalAnchor href={href}>{children}</ExternalAnchor>,
  ul: ({ children }) => (
    <ul className="my-2 flex list-disc flex-col gap-1.5 pl-5 text-[14px] leading-normal">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 flex list-decimal flex-col gap-1.5 pl-5 text-[14px] leading-normal">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="marker:text-accent">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote
      className="my-3 rounded-r-[7px] px-3.5 py-2 text-[13px] italic leading-[1.55] text-dim"
      style={{
        borderLeft: '3px solid var(--accent-line)',
        background: 'var(--accent-soft)',
      }}
    >
      {children}
    </blockquote>
  ),
  hr: () => <div className="my-4 h-px" style={{ background: 'var(--border)' }} />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  th: ({ children }) => (
    <th
      className="px-3 py-1.5 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-faint"
      style={{ borderBottom: '1.5px solid var(--border-2)' }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      className="px-3 py-2 align-top text-dim"
      style={{ borderBottom: '1px solid var(--border)' }}
    >
      {children}
    </td>
  ),
  code: ({ className, children }) => renderCode({ className, children }),
  pre: ({ children }) => <>{children}</>,
};

/** A clickable file-path chip (spec/plan panes only). Left-click navigates in-app to the stacked file view;
 *  modified/middle click opens the deep link in a new tab. */
function FilePill({
  url,
  onSelect,
  children,
}: {
  url: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <a
      href={url}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onSelect();
      }}
      className="cursor-pointer rounded-[3px] px-1.25 py-px font-mono text-[12px] text-accent hover:underline"
      style={{
        background: 'var(--surface-3)',
        borderBottom: '1px solid var(--accent-line)',
      }}
    >
      {children}
    </a>
  );
}

/** The default external link (new tab) — used for absolute/scheme/anchor hrefs. */
function ExternalAnchor({ href, children }: { href?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent"
      style={{
        textDecoration: 'none',
        borderBottom: '1px solid var(--accent-line)',
      }}
    >
      {children}
    </a>
  );
}

/** A relative link (no scheme, not an anchor, not site-absolute) — e.g. `sections/01-backend.md`. */
function isRelativeHref(href: string | undefined): href is string {
  return (
    !!href &&
    !/^[a-z][a-z0-9+.-]*:/i.test(href) && // scheme: http:, mailto:, …
    !href.startsWith('#') &&
    !href.startsWith('/') &&
    !href.startsWith('//')
  );
}

/** A site-absolute link into a `/context` bucket — e.g. `/context/artifacts/preview.html`. These are
 *  rejected by {@link isRelativeHref} (leading `/`) but must still reach the resolver so a conversation link
 *  to a spec/generated/artifact file opens it in the detail pane. */
function isContextHref(href: string | undefined): href is string {
  return !!href && /^\/context\/(specs|generated|artifacts|evidence)\//.test(href);
}

export const Markdown = memo(function Markdown({
  children,
  resolveRelativeLink,
  resolveFileLink,
}: {
  children: string;
  /** Resolve a RELATIVE link (e.g. a spec file linking `sections/01-backend.md`) to a real in-app deep
   *  link + a select action. The anchor's `href` becomes `url` (so cmd/middle-click opens the right thing
   *  in a new tab), and a plain left-click is intercepted to `onSelect()` (SPA nav, no reload). Return null
   *  to leave a link as a normal external anchor. Absent → all links render as external anchors. */
  resolveRelativeLink?: (href: string) => { url: string; onSelect: () => void } | null;
  /** Linkify an inline-code span that names a REAL repo file into a clickable pill. Given the raw span text
   *  (e.g. `web/src/…/markdown.tsx:18-24`), return `{ url, onSelect }` to render a pill, or null to keep it a
   *  plain code chip. Absent → all inline code stays plain (used only in the spec/plan panes). */
  resolveFileLink?: (raw: string) => { url: string; onSelect: () => void } | null;
}) {
  const components = useMemo<Components>(() => {
    if (!resolveRelativeLink && !resolveFileLink) return COMPONENTS;
    const next: Components = { ...COMPONENTS };
    if (resolveRelativeLink) {
      next.a = ({ href, children }) => {
        const r = isRelativeHref(href) || isContextHref(href) ? resolveRelativeLink(href) : null;
        if (!r) return <ExternalAnchor href={href}>{children}</ExternalAnchor>;
        return (
          <a
            href={r.url}
            onClick={(e) => {
              // Let the browser handle modified / non-left clicks (new tab/window) — they open `r.url`,
              // a real deep link. Intercept only a plain left-click for in-app SPA navigation.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              r.onSelect();
            }}
            className="cursor-pointer text-accent"
            style={{
              textDecoration: 'none',
              borderBottom: '1px solid var(--accent-line)',
            }}
          >
            {children}
          </a>
        );
      };
    }
    if (resolveFileLink) {
      next.code = ({ className, children }) => renderCode({ className, children, resolveFileLink });
    }
    return next;
  }, [resolveRelativeLink, resolveFileLink]);
  return (
    <div className="text-[14px] leading-[1.62] text-text wrap-anywhere">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkShortcodeIcons]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
