/**
 * Admin API response shapes — the cross-app contract between the backend admin
 * endpoints and the admin web UI. Pure TypeScript: no TypeORM, no class-validator.
 * Safe to import in any package including frontend bundles.
 */

/**
 * The four memory-sharing tiers that a fact's scope belongs to.
 * Mirrors the scope prefix hierarchy in the backend's `domain/identity.ts`.
 */
export type Tier = 'team' | 'project' | 'bot' | 'private';

/** Full fact response shape for the Memory Viewer API. */
export interface FactView {
  id: number;
  /** The fact text — `content` per the Memory Viewer API contract (spec field name). */
  content: string;
  tier: Tier;
  /** Bot id parsed from scope; null for team/project-tier facts. */
  botId: string | null;
  /** Project id parsed from scope; null for non-project facts. */
  projectId: string | null;
  /** Human participant parsed from a pair scope; null for non-private facts. */
  humanId: string | null;
  confidence: number;
  createdAt: string;
  /** Included for client-side sort and last-updated display. */
  updatedAt: string;
  /** ISO timestamp when soft-deleted; null if the fact is active. */
  deletedAt: string | null;
}

/**
 * Paginated fact list response — `{ items, total, limit, offset }`.
 * `total` allows the client to compute pagination controls and the
 * per-tier live/forgotten count hint without a second request.
 */
export interface FactListResponse {
  items: FactView[];
  total: number;
  limit: number;
  offset: number;
}

/** Query params for `listFacts` / `listAllFacts`. All optional. */
export interface FactQuery {
  tier?: Tier;
  projectId?: string;
  botId?: string;
  assertedBy?: string;
  q?: string;
  includeDeleted?: boolean;
  includeGlobal?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'updated' | 'created';
}

/**
 * Lightweight workspace summary for the admin UI workspace picker.
 *
 * `slug` is the same value as `id` (the Slack `team_id`): there is no separate
 * slug column in the `tenants` table, and the Slack team ID already serves as
 * the canonical URL-safe unique identifier. If a human-readable slug is needed
 * in a future iteration, a column migration is the right fix.
 */
export interface TenantView {
  /** Slack team id — the `:teamId` path param in all tenant-scoped endpoints. */
  id: string;
  /** Human-readable workspace display name. */
  name: string;
  /** URL-safe workspace identifier (same as `id` — see jsdoc above). */
  slug: string;
}

/** A registered project: binds a project id (the slug rooms carry) to a GitHub repo. */
export interface ProjectRecord {
  /** The tenant (Slack team id) this project belongs to. */
  teamId: string;
  projectId: string;
  displayName: string;
  /** HTTPS GitHub URL (validated at the API edge). */
  gitUrl: string;
  /** The PR base branch. */
  defaultBranch: string;
  /** Named token override; null -> the default token. */
  tokenName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewProject {
  teamId: string;
  projectId: string;
  displayName: string;
  gitUrl: string;
  defaultBranch?: string;
  tokenName?: string | null;
}

/** Token METADATA — the only shape that ever leaves the store besides `resolve()`. */
export interface GithubTokenMeta {
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
