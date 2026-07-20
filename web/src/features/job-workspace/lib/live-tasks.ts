import type { LiveTurn } from '@/lib/api/job-stream';
import type { TaskItem } from '@/lib/api/types';
import { isBridgeTool, mcpName } from '../tool-calls/util';

/**
 * REALTIME task overlay — the client-side twin of the backend's `task_create`/`task_update` host-bridge
 * handlers, applied to a lane's LIVE turn blocks on top of the last-fetched durable list. The handler
 * writes the stage's `tasks` row as it happens, but the web's pipeline query only refetches on `/events`
 * frames (turn end) — mid-turn the checklist would sit frozen. The live turn stream already carries the
 * same tool blocks (`mcp__atlas-host-bridge__task_create`/`_update`) token-by-token, so re-applying them
 * here makes the navigator tick in realtime, and because both folds share semantics the overlay is
 * IDEMPOTENT over whatever the durable snapshot already absorbed (double-applying an event lands on the
 * same state). The durable refetch reconciles at turn end.
 */

const isStr = (v: unknown): v is string => typeof v === 'string';
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** The created task's id from a `task_create` result — it returns a STRING ("Task #8 created…"); a
 *  structured `{ task: { id } }` shape is kept as a fallback. Mirrors the backend `createdTaskId`. */
function createdTaskId(result: unknown): string | null {
  if (isStr(result)) {
    const m = /task\s+#([\w-]+)/i.exec(result);
    return m ? m[1] : null;
  }
  const id = asRecord(asRecord(result).task).id;
  return isStr(id) ? id : null;
}

function mapStatus(raw: unknown): TaskItem['status'] | null {
  return raw === 'pending' || raw === 'in_progress' || raw === 'completed' ? raw : null;
}

function applyCall(
  byId: Map<string, TaskItem>,
  name: string,
  input: Record<string, unknown>,
  result: unknown,
): void {
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
  const extras = (prev?: TaskItem): Pick<TaskItem, 'description' | 'activeForm'> => ({
    ...(isStr(input.description)
      ? { description: input.description }
      : prev?.description
        ? { description: prev.description }
        : {}),
    ...(isStr(input.activeForm)
      ? { activeForm: input.activeForm }
      : prev?.activeForm
        ? { activeForm: prev.activeForm }
        : {}),
  });
  // Dependency edges: prev ∪ addBlockedBy ∖ removeBlockedBy; `addBlocks`/`removeBlocks` fold the inverse
  // onto the target's blockedBy (mirrors the backend fold exactly).
  const blockedEdges = (prev?: TaskItem): Pick<TaskItem, 'blockedBy'> => {
    const remove = new Set(strArr(input.removeBlockedBy));
    const merged = [
      ...new Set([
        ...(prev?.blockedBy ?? []),
        ...strArr(input.blockedBy),
        ...strArr(input.addBlockedBy),
      ]),
    ].filter((b) => !remove.has(b));
    return merged.length > 0 ? { blockedBy: merged } : {};
  };
  const applyInverseEdges = (id: string): void => {
    for (const target of strArr(input.addBlocks)) {
      const t = byId.get(target);
      if (t)
        byId.set(target, {
          ...t,
          blockedBy: [...new Set([...(t.blockedBy ?? []), id])],
        });
    }
    for (const target of strArr(input.removeBlocks)) {
      const t = byId.get(target);
      if (!t?.blockedBy) continue;
      const rest = t.blockedBy.filter((b) => b !== id);
      const { blockedBy: _drop, ...bare } = t;
      byId.set(target, rest.length > 0 ? { ...bare, blockedBy: rest } : bare);
    }
  };
  if (name === 'task_create') {
    const id = createdTaskId(result);
    if (!id) return; // result not streamed yet — the row appears the moment it lands
    const subject = isStr(input.subject)
      ? input.subject
      : isStr(input.description)
        ? input.description
        : id;
    byId.set(id, {
      id,
      subject,
      status: 'pending',
      ...extras(),
      ...blockedEdges(),
    });
    applyInverseEdges(id);
  } else if (name === 'task_update') {
    const id = isStr(input.taskId) ? input.taskId : null;
    if (!id) return;
    if (input.status === 'deleted') {
      byId.delete(id);
      return;
    }
    const existing = byId.get(id);
    const status = mapStatus(input.status) ?? existing?.status ?? 'pending';
    const subject = isStr(input.subject) ? input.subject : (existing?.subject ?? id);
    byId.set(id, {
      id,
      subject,
      status,
      ...extras(existing),
      ...blockedEdges(existing),
    });
    applyInverseEdges(id);
  }
}

/**
 * The durable list with the live lane's task calls folded on top. Excludes a writer subagent's own calls
 * (`parentToolUseId` set) — only the orchestrating session's list is tracked, same as the backend.
 * Legacy `dropped` rows (persisted before deletes removed tasks) are filtered out of the result.
 */
export function overlayLiveTasks(durable: TaskItem[], live: LiveTurn | undefined): TaskItem[] {
  const byId = new Map(durable.filter((t) => t.status !== 'dropped').map((t) => [t.id, { ...t }]));
  for (const b of live?.blocks ?? []) {
    if (b.kind !== 'tool' || b.parentToolUseId) continue;
    const name = (isBridgeTool(b.name) ? mcpName(b.name) : b.name).toLowerCase();
    if (name !== 'task_create' && name !== 'task_update') continue;
    applyCall(byId, name, asRecord(b.input as unknown), b.result as unknown);
  }
  return [...byId.values()];
}
