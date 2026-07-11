"use client";

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Copy,
  Maximize2,
  RotateCcw,
  Send,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { JsonView, allExpanded, darkStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import {
  CopyButton,
  TerminalChromeBar,
  WrapButton,
  useCopied,
} from "./terminal-chrome";
import { renderTokenLine, useHighlightTokens } from "./tool-calls/highlight";

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
  const lines = useMemo(() => code.split("\n"), [code]);
  return (
    <div
      className="my-3 overflow-hidden rounded-[9px] border border-border"
      style={{ background: "var(--term)" }}
    >
      <TerminalChromeBar
        label={lang}
        actions={
          <>
            <WrapButton
              wrapped={wrapped}
              onToggle={() => setWrapped((w) => !w)}
            />
            <CopyButton text={code} />
          </>
        }
      />
      <pre
        className={`m-0 px-[14px] py-3 font-mono text-[11.5px] leading-[1.7] ${
          wrapped ? "whitespace-pre-wrap break-words" : "overflow-x-auto"
        }`}
        style={{ color: "var(--term-fg)" }}
      >
        {lineTokens
          ? lines.map((ln, i) => (
              <span key={i}>
                {i > 0 ? "\n" : null}
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
  label: `${darkStyles.label} !text-[#b89cf0]`, // object keys — lavender (function/title)
  stringValue: `${darkStyles.stringValue} !text-[#6fb3c9]`, // teal (string)
  numberValue: `${darkStyles.numberValue} !text-[#d89a5c]`,
  booleanValue: `${darkStyles.booleanValue} !text-[#e8983f]`, // amber
  nullValue: `${darkStyles.nullValue} !text-[#e8983f]`,
  undefinedValue: `${darkStyles.undefinedValue} !text-[#e8983f]`,
  punctuation: `${darkStyles.punctuation} !text-[var(--term-dim)]`,
  otherValue: `${darkStyles.otherValue} !text-[var(--term-fg)]`,
};

/** Parse `raw` as JSON, returning it only when it's a non-null object/array (what JsonView renders);
 *  anything else (scalar or malformed) returns null so the caller falls back to the plain code frame. */
function parseJsonContainer(raw: string): object | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function JsonBlock({ value }: { value: object }) {
  return (
    <div
      className="my-3 overflow-hidden rounded-[9px] border border-border"
      style={{ background: "var(--term)" }}
    >
      <TerminalChromeBar
        label="json"
        actions={<CopyButton text={JSON.stringify(value, null, 2)} />}
      />
      <div
        className="overflow-x-auto px-[14px] py-3 font-mono text-[11.5px] leading-[1.7]"
        style={{ color: "var(--term-fg)" }}
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
// imported (kept out of the main bundle) and initialized ONCE, client-side, pulling its palette from the
// live CSS tokens so diagrams match the design system. securityLevel 'strict' DOMPurify-sanitizes the SVG
// (diagrams are agent-authored), which makes the dangerouslySetInnerHTML below safe.
let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      const css = getComputedStyle(document.documentElement);
      const v = (name: string, fallback: string) =>
        css.getPropertyValue(name).trim() || fallback;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        // We catch render errors and show our own inline fallback; without this, mermaid ALSO
        // injects its default "bomb" error SVG into the DOM. Suppress it so only our UI shows.
        suppressErrorRendering: true,
        theme: "base",
        fontFamily: v("--f-mono", "ui-monospace, monospace"),
        themeVariables: {
          background: "transparent",
          primaryColor: v("--surface-2", "#f6f6f3"),
          primaryTextColor: v("--text", "#1a1d23"),
          primaryBorderColor: v("--border-2", "#d3d3cc"),
          secondaryColor: v("--surface-3", "#eeeee9"),
          tertiaryColor: v("--surface", "#ffffff"),
          lineColor: v("--dim", "#5c6573"),
          textColor: v("--text", "#1a1d23"),
        },
      });
      return mermaid;
    });
  }
  return mermaidReady;
}

/** Flatten code-block children to plain text (string, number, or nested markdown nodes). */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeText(
      (node as { props?: { children?: ReactNode } }).props?.children,
    );
  }
  return "";
}

/**
 * Strip mermaid's inline `max-width` clamp (which uniformly downscales wide diagrams until text is
 * illegible) and read the intrinsic px size from the viewBox, so we can size the diagram ourselves.
 */
function parseSvg(raw: string): { svg: string; w: number; h: number } {
  const vb = /viewBox="[\d.\-]+ [\d.\-]+ ([\d.\-]+) ([\d.\-]+)"/.exec(raw);
  return {
    svg: raw.replace(/max-width:\s*[\d.]+px;?/g, ""),
    w: vb ? Math.round(parseFloat(vb[1])) : 0,
    h: vb ? Math.round(parseFloat(vb[2])) : 0,
  };
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
      <div className="flex items-center gap-2 border-b border-border px-3 py-[7px]">
        <span className="font-mono text-[10px] lowercase text-faint">
          {label}
        </span>
        <span className="flex-1" />
        {actions}
      </div>
      {children}
    </div>
  );
}

function Mermaid({ chart }: { chart: string }) {
  // useId is colon-bearing; mermaid's render id must be a valid DOM/CSS id, so strip non-word chars.
  const renderId = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [result, setResult] = useState<{
    svg: string;
    w: number;
    h: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [sent, setSent] = useState(false);
  const [copied, copy] = useCopied();
  const actions = useContext(MarkdownActionsContext);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    loadMermaid()
      .then(async (mermaid) => {
        // Validate BEFORE rendering: parse() throws on bad syntax but injects nothing, so mermaid's
        // default "bomb" error SVG never lands in the DOM — independent of whether suppressErrorRendering
        // took effect at init time (initialize runs once via a module singleton).
        await mermaid.parse(chart);
        return mermaid.render(renderId, chart);
      })
      .then(({ svg }) => {
        if (!cancelled) setResult(parseSvg(svg));
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [chart, renderId]);

  const copyButton = (
    <FrameBtn title="Copy mermaid source" onClick={() => copy(chart)}>
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? "copied" : "copy"}
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
                      "```\n" +
                      chart +
                      "\n```",
                  );
                  setSent(true);
                }}
              >
                <Send size={10} />
                {sent ? "sent to Atlas" : "fix with Atlas"}
              </FrameBtn>
            ) : null}
          </>
        }
      >
        <p className="border-b border-border px-[14px] py-2 font-mono text-[10px] leading-[1.5] text-red">
          failed to render — {error}
        </p>
        <pre className="m-0 overflow-x-auto px-[14px] py-3 font-mono text-[11.5px] leading-[1.7] text-dim">
          {chart}
        </pre>
      </MermaidFrame>
    );
  }
  if (!result) {
    return (
      <MermaidFrame label="mermaid">
        <div className="flex items-center justify-center px-4 py-6 font-mono text-[10.5px] text-faint">
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
            layout, and the whole thing is click-to-expand for a readable view. */}
        <div
          onClick={() => setZoomed(true)}
          className="mx-auto cursor-zoom-in p-4 [&>svg]:!h-auto [&>svg]:!w-full"
          style={{ maxWidth: result.w || undefined }}
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
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(
    null,
  );
  // Start at fit-to-viewport (capped at 2× so a small diagram doesn't blow up), then zoom/pan from there.
  const fit = () => {
    if (typeof window === "undefined" || !w || !h) return 1;
    const s = Math.min(
      (window.innerWidth - 96) / w,
      (window.innerHeight - 150) / h,
    );
    return Math.max(0.25, Math.min(2, Number(s.toFixed(2))));
  };
  const [scale, setScale] = useState(fit);
  const zoom = (f: number) =>
    setScale((s) => Math.max(0.25, Math.min(4, Number((s * f).toFixed(2)))));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex flex-col"
      role="dialog"
      aria-modal
    >
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.55)" }}
      />
      <div className="relative z-10 flex items-center justify-between border-b border-border bg-panel px-3 py-2">
        <span className="font-mono text-[9px] tracking-[0.16em] text-faint">
          DIAGRAM
        </span>
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
          if (!(e.target as HTMLElement).closest("[data-mmd-card]")) onClose();
        }}
      >
        {/* min-h/w-full + flex centering keeps the diagram centered when it fits, and scrollable when it
            doesn't. The diagram sits on its own solid surface card so it reads over the dark backdrop. */}
        <div className="flex min-h-full min-w-full items-center justify-center p-8">
          {/* Drag the diagram itself to pan (like an image viewer); clicks elsewhere fall through to close. */}
          <div
            data-mmd-card
            className="shrink-0 cursor-grab touch-none rounded-lg border border-border bg-surface p-5 shadow-[var(--shadow-card)] active:cursor-grabbing"
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
              className="[&>svg]:!h-full [&>svg]:!w-full"
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
 * block → {@link CodeBlock}, else a plain inline code chip. When `resolveFileLink` is provided (spec/plan
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
  resolveFileLink?: (
    raw: string,
  ) => { url: string; onSelect: () => void } | null;
}) {
  const cls = className ?? "";
  const match = /language-(\w+)/.exec(cls);
  // A ```mermaid fence becomes a rendered diagram instead of a code frame.
  if (match?.[1] === "mermaid")
    return <Mermaid chart={nodeText(children).replace(/\n$/, "")} />;
  // A ```json fence whose content is an object/array renders as an interactive collapsible tree;
  // invalid or scalar JSON falls through to the normal code frame below.
  if (match?.[1] === "json") {
    const parsed = parseJsonContainer(nodeText(children).replace(/\n$/, ""));
    if (parsed) return <JsonBlock value={parsed} />;
  }
  // A fence carries a `language-*` class (react-markdown tags it independently of any highlighter);
  // fall back to a newline sniff for the rare un-highlighted block.
  const isBlock = Boolean(match) || String(children ?? "").includes("\n");
  if (isBlock)
    return (
      <CodeBlock
        lang={match?.[1]}
        code={nodeText(children).replace(/\n$/, "")}
      />
    );
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
      className="rounded-[3px] px-[5px] py-px font-mono text-[12px]"
      style={{ background: "var(--surface-3)" }}
    >
      {children}
    </code>
  );
}

const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mb-1 mt-1 font-disp text-[21px] font-bold leading-tight tracking-[-0.02em] text-text">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-[18px] font-disp text-[16.5px] font-bold tracking-[-0.01em] text-text">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-3.5 font-disp text-[14px] font-bold tracking-[-0.01em] text-text">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="my-2 text-[14px] leading-[1.62] text-text first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-text">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <ExternalAnchor href={href}>{children}</ExternalAnchor>
  ),
  ul: ({ children }) => (
    <ul className="my-2 flex list-disc flex-col gap-1.5 pl-5 text-[14px] leading-[1.5]">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 flex list-decimal flex-col gap-1.5 pl-5 text-[14px] leading-[1.5]">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="marker:text-accent">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote
      className="my-3 rounded-r-[7px] px-3.5 py-2 text-[13px] italic leading-[1.55] text-dim"
      style={{
        borderLeft: "3px solid var(--accent-line)",
        background: "var(--accent-soft)",
      }}
    >
      {children}
    </blockquote>
  ),
  hr: () => (
    <div className="my-4 h-px" style={{ background: "var(--border)" }} />
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  th: ({ children }) => (
    <th
      className="px-3 py-1.5 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-faint"
      style={{ borderBottom: "1.5px solid var(--border-2)" }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      className="px-3 py-2 align-top text-dim"
      style={{ borderBottom: "1px solid var(--border)" }}
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
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
          return;
        e.preventDefault();
        onSelect();
      }}
      className="cursor-pointer rounded-[3px] px-[5px] py-px font-mono text-[12px] text-accent hover:underline"
      style={{
        background: "var(--surface-3)",
        borderBottom: "1px solid var(--accent-line)",
      }}
    >
      {children}
    </a>
  );
}

/** The default external link (new tab) — used for absolute/scheme/anchor hrefs. */
function ExternalAnchor({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent"
      style={{
        textDecoration: "none",
        borderBottom: "1px solid var(--accent-line)",
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
    !href.startsWith("#") &&
    !href.startsWith("/") &&
    !href.startsWith("//")
  );
}

/** A site-absolute link into a `/context` bucket — e.g. `/context/artifacts/preview.html`. These are
 *  rejected by {@link isRelativeHref} (leading `/`) but must still reach the resolver so a conversation link
 *  to a spec/generated/artifact file opens it in the detail pane. */
function isContextHref(href: string | undefined): href is string {
  return !!href && /^\/context\/(specs|generated|artifacts)\//.test(href);
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
  resolveRelativeLink?: (
    href: string,
  ) => { url: string; onSelect: () => void } | null;
  /** Linkify an inline-code span that names a REAL repo file into a clickable pill. Given the raw span text
   *  (e.g. `web/src/…/markdown.tsx:18-24`), return `{ url, onSelect }` to render a pill, or null to keep it a
   *  plain code chip. Absent → all inline code stays plain (used only in the spec/plan panes). */
  resolveFileLink?: (
    raw: string,
  ) => { url: string; onSelect: () => void } | null;
}) {
  const components = useMemo<Components>(() => {
    if (!resolveRelativeLink && !resolveFileLink) return COMPONENTS;
    const next: Components = { ...COMPONENTS };
    if (resolveRelativeLink) {
      next.a = ({ href, children }) => {
        const r =
          isRelativeHref(href) || isContextHref(href)
            ? resolveRelativeLink(href)
            : null;
        if (!r) return <ExternalAnchor href={href}>{children}</ExternalAnchor>;
        return (
          <a
            href={r.url}
            onClick={(e) => {
              // Let the browser handle modified / non-left clicks (new tab/window) — they open `r.url`,
              // a real deep link. Intercept only a plain left-click for in-app SPA navigation.
              if (
                e.metaKey ||
                e.ctrlKey ||
                e.shiftKey ||
                e.altKey ||
                e.button !== 0
              )
                return;
              e.preventDefault();
              r.onSelect();
            }}
            className="cursor-pointer text-accent"
            style={{
              textDecoration: "none",
              borderBottom: "1px solid var(--accent-line)",
            }}
          >
            {children}
          </a>
        );
      };
    }
    if (resolveFileLink) {
      next.code = ({ className, children }) =>
        renderCode({ className, children, resolveFileLink });
    }
    return next;
  }, [resolveRelativeLink, resolveFileLink]);
  return (
    <div className="text-[14px] leading-[1.62] text-text">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
