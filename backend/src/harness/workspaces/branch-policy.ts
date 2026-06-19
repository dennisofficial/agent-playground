import {
  type BranchKind,
  type BranchingPolicy,
  DEFAULT_BRANCHING_POLICY,
  slugify,
} from '@workspace/shared';

/** A structured workstation intent — what Atlas passes to `create_workspace`. */
export interface WorkstationIntent {
  kind: BranchKind;
  /** Feature name (kebab-cased into the branch). */
  slug?: string;
  /** Ticket id (used by templates, esp. hotfix). */
  ticket?: string;
}

export interface DerivedBranch {
  /** The git branch this workstation lives on. */
  branch: string;
  /** The ref the branch is cut FROM when it doesn't exist yet. */
  baseRef: string;
  /** Where the branch refreshes-from / opens its PR INTO. */
  upstream: string;
}

function resolveRef(
  ref: string,
  projectDefault: string,
  resolvedAutoBase: string,
): string {
  if (ref === 'auto') return resolvedAutoBase;
  if (ref === '{default}') return projectDefault;
  return ref;
}

/**
 * Derive a workstation's `{ branch, baseRef, upstream }` from a structured intent and the project's
 * branching policy. PURE — the one piece of I/O (resolving the auto-base by listing the repo's
 * branches) happens before this and is passed in as `resolvedAutoBase`.
 *
 * - `branch`   — `feature/<slug>` / `hotfix/<ticket>` / (for `base`) the base branch itself.
 * - `baseRef`  — what to cut the branch from if it doesn't exist yet.
 * - `upstream` — what the branch refreshes from / PRs into (a feature off `dev` PRs back to `dev`).
 */
export function deriveBranch(
  intent: WorkstationIntent,
  policy: BranchingPolicy | null | undefined,
  projectDefault: string,
  resolvedAutoBase: string,
): DerivedBranch {
  const rule =
    (policy ?? DEFAULT_BRANCHING_POLICY)[intent.kind] ??
    DEFAULT_BRANCHING_POLICY[intent.kind];

  const baseRef = resolveRef(rule.from, projectDefault, resolvedAutoBase);
  const upstream =
    rule.upstream === 'auto'
      ? baseRef
      : resolveRef(rule.upstream, projectDefault, resolvedAutoBase);

  // A feature/hotfix MUST be nameable; `base` ignores slug/ticket (its branch is the base itself).
  const slugVal = intent.slug?.trim() || intent.ticket?.trim() || '';
  const ticketVal = intent.ticket?.trim() || intent.slug?.trim() || '';
  if (intent.kind !== 'base' && !slugVal) {
    throw new Error(
      `a ${intent.kind} workstation needs a slug or ticket to name its branch`,
    );
  }

  const branch = rule.name
    .replace('{slug}', slugify(slugVal))
    .replace('{ticket}', slugify(ticketVal))
    .replace('{from}', baseRef);

  return { branch, baseRef, upstream };
}
