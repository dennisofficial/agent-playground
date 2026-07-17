
export interface TaskScope {
  kind: 'thread' | 'main';
  id: string;
}

export type ThreadKind =
  | 'main' // the job brain session — the operator conversation. Lane: `main`.
  | 'builder' // a build/track thread's own session. Lane: `thread:<threadId>`. (Master review is a builder too.)
  | 'autofix-stage' // the auto-fix stage's aggregate/card lane. Lane: `autofix:<autofixId>`.
  | 'autofix-lens' // one review lens's sub-lane. Lane: `autofix:<autofixId>:<lensId>`.
  | 'autofix-fix' // the auto-fix fix turn's sub-lane. Lane: `autofix:<autofixId>:fix`.
  | 'ship' // the terminal in-sandbox open-PR turn. Lane: `ship:<jobId>`.
  | 'codex-review'; // the Codex plan-review dialogue. Lane: `codex-review:<jobId>`.

export type ThreadInput = 'operator' | 'agent' | 'none';

export interface ThreadDescriptor {
  kind: ThreadKind;
  input: ThreadInput;
  lane(...ids: string[]): string;
  match(lane: string): string[] | null;
  taskScope(ctx: { jobId: string; ids: string[] }): TaskScope | null;
}

const AUTOFIX_LENS_RE = /^autofix:([^:]+):((?!fix$).+)$/; // `autofix:<id>:<lensId>` — excludes the `:fix` turn
const AUTOFIX_FIX_RE = /^autofix:([^:]+):fix$/;
const AUTOFIX_STAGE_RE = /^autofix:([^:]+)$/;

export const THREAD_REGISTRY: readonly ThreadDescriptor[] = [
  {
    kind: 'main',
    input: 'operator',
    lane: () => 'main',
    match: (lane) => (lane === 'main' ? [] : null),
    taskScope: ({ jobId }) => ({ kind: 'main', id: jobId }),
  },
  {
    kind: 'builder',
    input: 'operator',
    lane: (threadId) => `thread:${threadId}`,
    match: (lane) => (lane.startsWith('thread:') ? [lane.slice('thread:'.length)] : null),
    taskScope: ({ ids }) => ({ kind: 'thread', id: ids[0] }),
  },
  {
    kind: 'autofix-lens',
    input: 'none',
    lane: (autofixId, lensId) => `autofix:${autofixId}:${lensId}`,
    match: (lane) => {
      const m = AUTOFIX_LENS_RE.exec(lane);
      return m ? [m[1], m[2]] : null;
    },
    taskScope: () => null,
  },
  {
    kind: 'autofix-fix',
    input: 'none',
    lane: (autofixId) => `autofix:${autofixId}:fix`,
    match: (lane) => {
      const m = AUTOFIX_FIX_RE.exec(lane);
      return m ? [m[1]] : null;
    },
    taskScope: () => null,
  },
  {
    kind: 'autofix-stage',
    input: 'none',
    lane: (autofixId) => `autofix:${autofixId}`,
    match: (lane) => {
      const m = AUTOFIX_STAGE_RE.exec(lane);
      return m ? [m[1]] : null;
    },
    taskScope: () => null,
  },
  {
    kind: 'ship',
    input: 'none',
    lane: (jobId) => `ship:${jobId}`,
    match: (lane) => (lane.startsWith('ship:') ? [lane.slice('ship:'.length)] : null),
    taskScope: () => null,
  },
  {
    kind: 'codex-review',
    input: 'agent',
    lane: (jobId) => `codex-review:${jobId}`,
    match: (lane) =>
      lane.startsWith('codex-review:') ? [lane.slice('codex-review:'.length)] : null,
    taskScope: () => null,
  },
];

const BY_KIND = new Map<ThreadKind, ThreadDescriptor>(THREAD_REGISTRY.map((d) => [d.kind, d]));

export function laneFor(kind: ThreadKind, ...ids: string[]): string {
  const d = BY_KIND.get(kind);
  if (!d) throw new Error(`unknown thread kind: ${kind}`);
  return d.lane(...ids);
}

export function descriptorForLane(
  lane: string,
): { descriptor: ThreadDescriptor; ids: string[] } | null {
  for (const descriptor of THREAD_REGISTRY) {
    const ids = descriptor.match(lane);
    if (ids) return { descriptor, ids };
  }
  return null;
}

export function taskScopeForLane(lane: string, jobId: string): TaskScope | null {
  const hit = descriptorForLane(lane);
  return hit ? hit.descriptor.taskScope({ jobId, ids: hit.ids }) : null;
}
