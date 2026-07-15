"use client";

import type { IconKind, ToolDescriptor, ToolHandler, ToolItem } from "../types";
import { asRecord, formatPayload, isBridgeTool, mcpName, str } from "../util";
import { StructuredPanel } from "../ui";

/**
 * The remaining native Claude Code tools that aren't a file edit / shell / search — TodoWrite, Task,
 * WebFetch, WebSearch, BashOutput, KillShell, ExitPlanMode, SlashCommand — plus the Atlas host-bridge
 * `task_*` tools (the orchestrator's live task list, unified across engines; distinct from the
 * subagent-spawning bare `task`). Without this they'd hit the generic catch-all and render as a
 * misleading blue `mcp · name` row; here they get a proper icon + label (`isMcp: false`). TodoWrite
 * gets a checklist body; the rest use the default structured panel.
 */

interface NativeSpec {
  label: string;
  icon: IconKind;
  color: string;
  arg: (input: Record<string, unknown>) => string;
}

function todoSummary(i: Record<string, unknown>): string {
  const todos = Array.isArray(i.todos) ? i.todos : [];
  if (!todos.length) return "";
  const done = todos.filter(
    (t) => str(asRecord(t).status) === "completed",
  ).length;
  return `${done}/${todos.length} done`;
}

const NATIVE: Record<string, NativeSpec> = {
  todowrite: {
    label: "Todos",
    icon: "todo",
    color: "var(--accent)",
    arg: todoSummary,
  },
  // The unified Atlas host-bridge task tools (the orchestrator's live task list) — distinct from the
  // subagent-spawning `task`. Arrive as `mcp__atlas-host-bridge__task_*`; `nativeKey` strips the prefix.
  task_create: {
    label: "Add task",
    icon: "todo",
    color: "var(--accent)",
    arg: (i) => str(i.subject),
  },
  task_update: {
    label: "Update task",
    icon: "todo",
    color: "var(--accent)",
    arg: (i) => str(i.status) || str(i.subject),
  },
  task_list: {
    label: "Tasks",
    icon: "todo",
    color: "var(--accent)",
    arg: () => "",
  },
  task_get: {
    label: "Task",
    icon: "todo",
    color: "var(--accent)",
    arg: (i) => str(i.taskId),
  },
  task: {
    label: "Task",
    icon: "task",
    color: "var(--blue)",
    arg: (i) => str(i.description) || str(i.subagent_type),
  },
  webfetch: {
    label: "Fetch",
    icon: "web",
    color: "var(--blue)",
    arg: (i) => str(i.url),
  },
  websearch: {
    label: "Search",
    icon: "web",
    color: "var(--blue)",
    arg: (i) => str(i.query),
  },
  bashoutput: {
    label: "Bash output",
    icon: "bash",
    color: "var(--accent)",
    arg: (i) => str(i.bash_id ?? i.shell_id),
  },
  killshell: {
    label: "Kill shell",
    icon: "bash",
    color: "var(--accent)",
    arg: (i) => str(i.shell_id ?? i.bash_id),
  },
  killbash: {
    label: "Kill shell",
    icon: "bash",
    color: "var(--accent)",
    arg: (i) => str(i.shell_id ?? i.bash_id),
  },
  exitplanmode: {
    label: "Exit plan mode",
    icon: "plan",
    color: "var(--accent)",
    arg: () => "",
  },
  slashcommand: {
    label: "Command",
    icon: "bash",
    color: "var(--accent)",
    arg: (i) => str(i.command),
  },
};

const STATUS_DOT: Record<string, { color: string; fill: boolean }> = {
  completed: { color: "var(--green)", fill: true },
  in_progress: { color: "var(--accent)", fill: true },
  pending: { color: "var(--faint)", fill: false },
};

/** TodoWrite body — the agent's checklist, with a per-item status marker. */
function TodoBody({ tool }: { tool: ToolItem }) {
  const todos = Array.isArray(asRecord(tool.input).todos)
    ? (asRecord(tool.input).todos as unknown[])
    : [];
  if (!todos.length) {
    return (
      <StructuredPanel
        input={formatPayload(tool.input)}
        result={formatPayload(tool.result)}
        isError={tool.isError}
      />
    );
  }
  return (
    <>
      <div
        className="my-[3px] rounded-[7px] border border-border px-[11px] py-2"
        style={{ background: "var(--panel)" }}
      >
        {todos.map((raw, i) => {
          const t = asRecord(raw);
          const status = str(t.status);
          const dot = STATUS_DOT[status] ?? STATUS_DOT.pending;
          const content = str(t.content) || str(t.activeForm);
          const done = status === "completed";
          return (
            <div
              key={i}
              className="flex items-center gap-2 py-[3px] text-[12px]"
            >
              <span
                className="h-[10px] w-[10px] shrink-0 rounded-full"
                style={{
                  background: dot.fill ? dot.color : "transparent",
                  border: `1.5px solid ${dot.color}`,
                }}
              />
              <span
                style={{
                  color: done ? "var(--faint)" : "var(--text)",
                  textDecoration: done ? "line-through" : "none",
                }}
              >
                {content}
              </span>
            </div>
          );
        })}
      </div>
      {tool.isError ? (
        <StructuredPanel result={formatPayload(tool.result)} isError />
      ) : null}
    </>
  );
}

/** Default body for the non-Todo native tools — the structured input/result panel. */
function MiscBody({ tool }: { tool: ToolItem }) {
  if (tool.name.toLowerCase() === "todowrite") return <TodoBody tool={tool} />;
  return (
    <StructuredPanel
      input={formatPayload(tool.input)}
      result={formatPayload(tool.result)}
      isError={tool.isError}
    />
  );
}

/** The `NATIVE` lookup key: strip the `mcp__atlas-host-bridge__` prefix off the unified `task_*` tools
 *  before lowercasing, so both the bare SDK names and the bridged names resolve to the same entry. */
const nativeKey = (name: string): string =>
  (isBridgeTool(name) ? mcpName(name) : name).toLowerCase();

/** Misc native tools — proper label/icon so they don't render as `mcp · name`. */
export const nativeMiscHandler: ToolHandler = {
  id: "native-misc",
  match: (name) =>
    Object.prototype.hasOwnProperty.call(NATIVE, nativeKey(name)),
  describe: (tool): ToolDescriptor => {
    const spec = NATIVE[nativeKey(tool.name)];
    const arg = spec.arg(asRecord(tool.input));
    return {
      icon: spec.icon,
      label: spec.label,
      arg,
      preview: arg || spec.label.toLowerCase(),
      color: spec.color,
      isMcp: false,
      badge: tool.isError ? { kind: "error" } : null,
    };
  },
  Body: MiscBody,
};
