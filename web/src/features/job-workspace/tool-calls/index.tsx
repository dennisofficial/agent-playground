'use client';

import { useState, type ReactNode } from 'react';
import { isFileEditTool } from './handlers/native-file';
import { resolveHandler } from './registry';
import type { ToolBadge, ToolItem } from './types';
import { Badge, Chevron, JitContextPanel, JitPill, NewPill, StructuredPanel, ToolIcon } from './ui';
import { formatPayload } from './util';

/**
 * Split a run of consecutive tool calls into maximal segments of file-edits vs. other tools, preserving
 * order. A file-edit segment renders as a "N files changed" group (Write/Edit rows + diff bodies);
 * everything else stays a "N tools called" group. So `Read, Grep, Write, Edit, Bash` → three groups.
 */
export function segmentToolRun(tools: ToolItem[]): ToolItem[][] {
  const segments: ToolItem[][] = [];
  for (const tool of tools) {
    const last = segments[segments.length - 1];
    if (last && isFileEditTool(last[0].name) === isFileEditTool(tool.name)) last.push(tool);
    else segments.push([tool]);
  }
  return segments;
}

/** Sum the +/- diffstats across a group's tool calls into one badge — null if none carry a diffstat. */
function aggregateDiffstat(tools: ToolItem[]): ToolBadge {
  let added = 0;
  let removed = 0;
  let sawDiffstat = false;
  let sawRemoved = false;
  for (const t of tools) {
    const badge = resolveHandler(t.name, t.input).describe(t).badge;
    if (badge?.kind !== 'diffstat') continue;
    sawDiffstat = true;
    added += badge.added;
    if (badge.removed != null) {
      removed += badge.removed;
      sawRemoved = true;
    }
  }
  return sawDiffstat ? { kind: 'diffstat', added, removed: sawRemoved ? removed : null } : null;
}

/** Sum the line counts across a group's tool calls (Read) into one badge — null if none. */
function aggregateLines(tools: ToolItem[]): ToolBadge {
  let n = 0;
  let saw = false;
  for (const t of tools) {
    const badge = resolveHandler(t.name, t.input).describe(t).badge;
    if (badge?.kind !== 'lines') continue;
    saw = true;
    n += badge.n;
  }
  return saw ? { kind: 'lines', n } : null;
}

export type { ToolItem } from './types';

/**
 * Tool-call rendering for the conversation.
 *
 * Consecutive tool calls collapse into ONE group ("N tools called" + a preview of names). Each row's
 * treatment comes from the pluggable {@link resolveHandler} registry: native tools (Bash/Read/Edit/…)
 * and the Atlas host-bridge tools get bespoke renderers; unknown tools fall back to a generic `mcp · name`
 * row. File edits carry a `+N −N` diffstat badge and expand to a unified diff.
 */

/** The inline arg slot. For a file path, dims the directory prefix and keeps the filename normal. */
function PathArg({ arg, pathArg }: { arg: string; pathArg?: boolean }) {
  if (!pathArg) return <span className="flex-1 truncate font-mono text-[11.5px]">{arg}</span>;
  const cut = arg.lastIndexOf('/');
  const dir = cut >= 0 ? arg.slice(0, cut + 1) : '';
  const base = cut >= 0 ? arg.slice(cut + 1) : arg;
  return (
    <span className="flex-1 truncate font-mono text-[11.5px]">
      {dir ? <span className="text-faint">{dir}</span> : null}
      {base}
    </span>
  );
}

/**
 * The single clickable shell shared by a lone tool row AND a group header: leading disclosure chevron,
 * a flex content thread (the `children`), and a trailing running-dot. Padding, gap, chevron size, and
 * hover are defined ONCE here — change them in this one place and every tool-call row stays aligned.
 * `group` is always set so a child can opt into `group-hover:` (the header label uses it; rows ignore it).
 */
function DisclosureRow({
  open,
  onToggle,
  running,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  running?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group flex w-full items-center gap-2 rounded-md py-[5px] pl-0.5 pr-2 text-left text-[12.5px] text-dim transition hover:bg-surface-3"
    >
      <Chevron size={12} className={`text-faint ${open ? 'rotate-90' : ''}`} />
      {children}
      {running ? (
        <span
          className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: 'var(--accent)' }}
        />
      ) : null}
    </button>
  );
}

function ToolRow({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useState(false);
  const handler = resolveHandler(tool.name, tool.input);
  const d = handler.describe(tool);
  const badge = tool.superseded ? ({ kind: 'superseded' } as const) : d.badge;
  const Body = handler.Body;

  return (
    <div>
      <DisclosureRow open={open} onToggle={() => setOpen((o) => !o)} running={tool.running}>
        <ToolIcon kind={d.icon} color={d.color} />
        {d.isMcp ? (
          <span
            className="flex-1 truncate font-mono text-[11.5px]"
            style={{ color: 'var(--blue)' }}
          >
            <span className="text-faint">mcp · </span>
            {d.arg}
          </span>
        ) : (
          <>
            <span className="shrink-0 font-semibold text-text">{d.label}</span>
            <PathArg arg={d.arg} pathArg={d.pathArg} />
          </>
        )}
        {d.pill ? <NewPill text={d.pill} /> : null}
        {tool.jitContext?.length ? <JitPill count={tool.jitContext.length} /> : null}
        <Badge badge={badge} />
      </DisclosureRow>
      {open ? (
        <>
          {Body ? (
            <Body tool={tool} />
          ) : (
            <StructuredPanel
              input={formatPayload(tool.input)}
              result={formatPayload(tool.result)}
              isError={tool.isError}
              superseded={tool.superseded}
            />
          )}
          {tool.jitContext?.length ? <JitContextPanel items={tool.jitContext} /> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * A run of consecutive tool calls, collapsed into one group. Open by default while any tool is running.
 * A group of only file-edits reads as "N files changed" with a `+N −N` rollup chip — shown ONLY while
 * collapsed (open, each file row carries its own counts, so the rollup is redundant).
 *
 * A lone tool call is NOT wrapped in a group — it renders as a bare row (its own badge already carries
 * the diffstat / NEW / lines tag, so a "1 tool called" header would be pure redundancy).
 */
export function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const anyRunning = tools.some((t) => t.running);
  const [open, setOpen] = useState(anyRunning);
  // A lone tool call is NOT wrapped in a group — bare row (its badge already carries the tag). This
  // returns AFTER the hooks above so hook order stays stable if a streaming segment grows 1→N.
  if (tools.length === 1) {
    return (
      <div className="anim-fadeUp my-px">
        <ToolRow tool={tools[0]} />
      </div>
    );
  }
  const preview = tools
    .map((t) => resolveHandler(t.name, t.input).describe(t).preview)
    .filter(Boolean)
    .join(' · ');
  const count = tools.length;
  const totalStat = aggregateDiffstat(tools);
  const totalLines = aggregateLines(tools);
  // How many grouped tools failed — a failed tool's own line/diffstat badge is dropped from the
  // rollups above, so without this the collapsed header gives no hint that anything errored.
  const errorCount = tools.filter((t) => t.isError && !t.superseded).length;
  const allFiles = tools.every((t) => isFileEditTool(t.name));
  // How many of the grouped files are newly created (their row carries a "NEW" pill) — rolled up onto
  // the collapsed header alongside the diffstat, mirroring the per-row tags.
  const newCount = tools.reduce(
    (n, t) => (resolveHandler(t.name, t.input).describe(t).pill === 'NEW' ? n + 1 : n),
    0,
  );
  const label = allFiles
    ? `${count} ${count === 1 ? 'file' : 'files'} changed`
    : `${count} ${count === 1 ? 'tool' : 'tools'} called`;
  // Rollups show ONLY while collapsed (open, each row carries its own tags, so they'd be redundant).
  const showStat = totalStat && (!allFiles || !open);
  const showNew = allFiles && !open && newCount > 0;
  const showLines = totalLines && !open;
  const showError = errorCount > 0 && !open;

  return (
    <div className="anim-fadeUp my-px">
      <DisclosureRow open={open} onToggle={() => setOpen((o) => !o)} running={anyRunning}>
        <span className="shrink-0 font-semibold text-dim transition group-hover:text-text">
          {label}
        </span>
        <span className="flex-1 truncate font-mono text-[11px] text-faint">{preview}</span>
        {showError ? (
          <span className="shrink-0 font-mono text-[10px]" style={{ color: 'var(--red)' }}>
            {errorCount === 1 ? 'error' : `${errorCount} errors`}
          </span>
        ) : null}
        {showNew ? (
          <NewPill text={newCount === count ? 'NEW' : `${newCount} NEW`} size="group" />
        ) : null}
        {showStat ? <Badge badge={totalStat} size="group" /> : null}
        {showLines ? <Badge badge={totalLines} /> : null}
      </DisclosureRow>
      {open ? (
        <div
          className="ml-[5px] flex flex-col gap-px pl-[13px]"
          style={{ borderLeft: '1.5px solid var(--border)' }}
        >
          {tools.map((t) => (
            <ToolRow key={t.key} tool={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
