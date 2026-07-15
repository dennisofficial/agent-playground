/**
 * thread-group-kind / registry — the ONE list of `ThreadGroupKindSpec`s + the boot validation over it.
 * Mirrors `thread-kind/registry.ts`: a plain, explicit list (no runtime discovery), boot-validated LOUD so
 * a misconfigured kind (a role with no `ThreadKindSpec`, a duplicate kind) fails at startup, not mid-build.
 */
import { THREAD_KIND_SPECS } from '../thread-kind/registry';
import type { ThreadGroupKindSpec, ThreadGroupKind } from './spec';

/**
 * THE thread-group-kind registry. One spec per kind; thread 3's orchestration reads everything about a
 * thread group's shape from here instead of branching on `threadGroup.kind` inline (d8).
 */
export const THREAD_GROUP_KIND_SPECS: readonly ThreadGroupKindSpec[] = [
  {
    kind: 'planning',
    roles: [{ role: 'planning', min: 1, max: 1 }],
    hasReview: false,
    titleRequired: true,
    spawnAt: 'job_start',
  },
  {
    kind: 'plan_review',
    roles: [{ role: 'plan_review', min: 1, max: 1 }],
    hasReview: false,
    titleRequired: false,
    spawnAt: 'plan',
  },
  {
    kind: 'build',
    roles: [
      { role: 'builder', min: 1, max: null }, // sequential legs (d1) — rotation appends the next row.
      { role: 'review_agent', min: 0, max: null }, // 0..N selected lenses (reviewAgentsForThread).
      { role: 'review_fix', min: 1, max: 1 },
    ],
    hasReview: true,
    titleRequired: true,
    spawnAt: 'dispatch',
  },
  {
    kind: 'direct_build',
    // The no-review fast path (d9): a single builder, no review_agent/review_fix, no master_review group.
    roles: [{ role: 'builder', min: 1, max: 1 }],
    hasReview: false,
    titleRequired: false,
    spawnAt: 'dispatch',
  },
  {
    kind: 'master_review',
    roles: [{ role: 'master_review', min: 1, max: 1 }],
    hasReview: false,
    titleRequired: false,
    spawnAt: 'after_build_thread_groups',
  },
  {
    kind: 'post_build',
    roles: [{ role: 'post_build', min: 1, max: 1 }],
    hasReview: false,
    titleRequired: false,
    spawnAt: 'after_master_review',
  },
  {
    kind: 'ci',
    roles: [{ role: 'ci', min: 1, max: 1 }],
    hasReview: false,
    titleRequired: false,
    spawnAt: 'after_ship',
  },
];

const BY_THREAD_GROUP_KIND = new Map<string, ThreadGroupKindSpec>(
  THREAD_GROUP_KIND_SPECS.map((s) => [s.kind, s]),
);

/** Resolve a thread-group kind's spec, or throw (an unknown kind is a bug — every row's kind is
 *  registry-backed). */
export function threadGroupKindSpec(kind: string): ThreadGroupKindSpec {
  const spec = BY_THREAD_GROUP_KIND.get(kind);
  if (!spec)
    throw new Error(
      `thread-group-kind: unknown kind "${kind}" (no ThreadGroupKindSpec).`,
    );
  return spec;
}

const THREAD_GROUP_KIND_SET = new Set<string>(
  THREAD_GROUP_KIND_SPECS.map((s) => s.kind),
);

/** Coerce any raw value to a valid ThreadGroupKind, or throw — mirrors `coerceThreadType`'s shape but
 *  stays strict (unlike the open `general` fallback, an unrecognized thread-group kind is always a bug,
 *  never data). */
export function coerceThreadGroupKind(raw: unknown): ThreadGroupKind {
  const value = String(raw ?? '').trim();
  if (!THREAD_GROUP_KIND_SET.has(value)) {
    throw new Error(
      `thread-group-kind: "${value}" is not a valid ThreadGroupKind.`,
    );
  }
  return value as ThreadGroupKind;
}

/**
 * Fail LOUDLY on a misconfigured thread-group-kind set (twin of `validateThreadKinds`): a duplicate kind,
 * and a role reference that names a kind with no `ThreadKindSpec` (so every declared role always
 * resolves).
 */
export function validateThreadGroupKinds(
  specs: readonly ThreadGroupKindSpec[] = THREAD_GROUP_KIND_SPECS,
): void {
  const validRoles = new Set<string>(THREAD_KIND_SPECS.map((s) => s.kind));
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.kind)) {
      throw new Error(
        `thread-group-kind: duplicate spec for kind "${s.kind}".`,
      );
    }
    seen.add(s.kind);
    if (s.roles.length === 0) {
      throw new Error(
        `thread-group-kind: kind "${s.kind}" declares no roles.`,
      );
    }
    for (const r of s.roles) {
      if (!validRoles.has(r.role)) {
        throw new Error(
          `thread-group-kind: kind "${s.kind}" references unknown role "${r.role}".`,
        );
      }
      if (r.max !== null && r.max < r.min) {
        throw new Error(
          `thread-group-kind: kind "${s.kind}" role "${r.role}" has max < min.`,
        );
      }
    }
  }
}
