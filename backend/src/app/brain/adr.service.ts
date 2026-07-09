import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * THE DURABLE ARCHITECTURAL DECISION RECORDS (`.atlas/adr/`).
 *
 * Per-thread decisions (the working-set `pending_decisions` → generated `decision-record.md`) are
 * per-FEATURE and ephemeral. This service writes the SUBSET that is durable + cross-cutting — the calls
 * that outlive one feature ("money-out requires SUPER_ADMIN", "credits via Stripe balance, no internal
 * balance journal") —
 * into committed `.atlas/adr/<slug>.md` files inside the thread's worktree, so they ride the PR and
 * a future thread inherits them.
 *
 * The BRAIN distills (decides what's durable + authors the prose); this host service only WRITES — it
 * validates structure, renders frontmatter + the ADR body, and keeps the supersession graph back-linked. It
 * is the structural-freshness guarantee: every write leaves the folder internally consistent (slug ==
 * frontmatter id, no dangling supersedes). Idempotent —
 * re-promoting the same slug overwrites cleanly (so a driver resume / boot re-run is safe).
 *
 * Phase 1 deliberately has NO manifest table: the files ARE the store, frontmatter carries the graph, and
 * trust is presence-based (a file visible in a thread's worktree is on its base branch ⇒ already merged ⇒
 * canonical). Phase 2 adds a `repo_adrs` manifest for merge-time accept + tamper-resistant edit
 * detection. See the plan + ARCHITECTURE.md.
 */

/** Where the BRAIN authors the durable prose — provenance for a promoted decision. */
export type AdrAuthor = 'atlas' | 'operator' | 'human-edit';

/** An ADR entry's lifecycle. Phase 1 writes `proposed`; Phase 2's merge hook flips it to `accepted`. */
export type AdrStatus = 'proposed' | 'accepted' | 'superseded';

/** One durable decision the brain elects to promote. The brain authors the prose; the host writes it. */
export type AdrEntryInput = {
  /** Stable topic slug — becomes the filename `<slug>.md` AND the frontmatter `id`. NOT a counter. */
  slug: string;
  /** Short imperative title. */
  title: string;
  /** ## Context — the forces/constraints in play before the decision. */
  context: string;
  /** ## Decision — the call, stated plainly. */
  decision: string;
  /** ## Consequences — what gets easier/harder, including costs. */
  consequences?: string;
  /** ## Alternatives considered — what else was on the table and why it was rejected. */
  alternatives?: string;
  /** Free-text tags (no fixed taxonomy — the planning-time `DecisionClass` is NOT copied here). */
  tags?: string[];
  /** Provenance — who authored this durable record. Defaults to `atlas`. */
  authoredBy?: AdrAuthor;
  /** True only when the operator directly settled the ruling (mirrors `Decision.confirmedByOperator`). */
  confirmedByOperator?: boolean;
  /** The thread this was distilled from (back-link). */
  sourceThread?: string;
  /** The in-thread decision id this distills (e.g. `d3`) — keeps the original class derivable. */
  sourceDecision?: string;
  /** Slugs of earlier ADR entries this decision REPLACES (they get back-linked + marked superseded). */
  supersedes?: string[];
  /** Globs the decision constrains — the hook the Phase 3 drift detector uses to scope a diff. */
  governsPaths?: string[];
};

export type PromoteAdrResult = {
  /** Slugs written or overwritten this call. */
  written: string[];
  /** Slugs back-linked as `superseded` because a written entry supersedes them. */
  superseded: string[];
  /** Per-written-slug sha256 of the file contents — the Phase-2 manifest's promotion-time baseline. */
  hashes: Record<string, string>;
};

/** sha256 of an ADR file's full contents — the manifest's tamper-resistant baseline (Phase 2). */
export function adrContentHash(fileText: string): string {
  return createHash('sha256').update(fileText, 'utf8').digest('hex');
}

/** Thrown when a promotion would leave the ADR store structurally inconsistent. Surfaced as a tool error. */
export class AdrValidationError extends Error {}

const ADR_DIR = join('.atlas', 'adr');
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

@Injectable()
export class AdrService {
  private readonly logger = new Logger(AdrService.name);

  /**
   * Write/overwrite the given durable decisions into `<worktree>/.atlas/adr/`, back-link any
   * supersessions. Validates BEFORE writing — a structural problem (bad slug, missing body, dangling
   * `supersedes`) throws and nothing is written. Caller commits the worktree.
   */
  async promote(
    worktreePath: string,
    entries: AdrEntryInput[],
    opts: { now?: Date } = {},
  ): Promise<PromoteAdrResult> {
    const now = opts.now ?? new Date();
    const dir = join(worktreePath, ADR_DIR);

    // Validate every entry up front so a bad batch writes NOTHING.
    for (const e of entries) this.validate(e);
    const batchSlugs = new Set(entries.map((e) => e.slug));
    if (batchSlugs.size !== entries.length) {
      throw new AdrValidationError('duplicate slug within the promotion batch');
    }

    await mkdir(dir, { recursive: true });
    const existing = await this.existingSlugs(dir);

    // Every `supersedes` target must resolve to a real slug (this batch ∪ on-disk) — no dangling edges.
    for (const e of entries) {
      for (const target of e.supersedes ?? []) {
        if (!batchSlugs.has(target) && !existing.has(target)) {
          throw new AdrValidationError(
            `decision "${e.slug}" supersedes "${target}", which does not exist in the ADR store`,
          );
        }
      }
    }

    // 1. Write the entries (preserving original `decided_on` on overwrite); record each file's hash.
    const written: string[] = [];
    const hashes: Record<string, string> = {};
    for (const e of entries) {
      const file = join(dir, `${e.slug}.md`);
      const prior = await readFile(file, 'utf8').catch(() => null);
      const decidedOn = (prior && readScalar(prior, 'decided_on')) || isoDate(now);
      const supersededBy = prior ? readScalar(prior, 'superseded_by') : null;
      const text = this.renderEntry(e, { decidedOn, supersededBy, now });
      await writeFile(file, text, 'utf8');
      written.push(e.slug);
      hashes[e.slug] = adrContentHash(text);
    }

    // 2. Back-link supersession: mark each superseded target `superseded` + point it at its replacer.
    const superseded: string[] = [];
    for (const e of entries) {
      for (const target of e.supersedes ?? []) {
        if (batchSlugs.has(target)) continue; // a batch entry's own frontmatter already reflects intent
        const file = join(dir, `${target}.md`);
        const text = await readFile(file, 'utf8').catch(() => null);
        if (!text) continue;
        // Values are pre-rendered to match renderEntry exactly: `status` bare, `superseded_by` quoted.
        await writeFile(
          file,
          patchFrontmatter(text, { status: 'superseded', superseded_by: yamlStr(e.slug) }),
          'utf8',
        );
        superseded.push(target);
      }
    }

    this.logger.log(
      `ADR promote: wrote ${written.length} (${written.join(', ')})` +
        (superseded.length ? `, superseded ${superseded.join(', ')}` : ''),
    );
    return { written, superseded, hashes };
  }

  private validate(e: AdrEntryInput): void {
    if (!SLUG_RE.test(e.slug)) {
      throw new AdrValidationError(
        `invalid slug "${e.slug}" — use lowercase kebab-case (a-z, 0-9, single hyphens)`,
      );
    }
    if (!e.title?.trim()) throw new AdrValidationError(`decision "${e.slug}" needs a title`);
    if (!e.context?.trim()) throw new AdrValidationError(`decision "${e.slug}" needs a Context`);
    if (!e.decision?.trim()) throw new AdrValidationError(`decision "${e.slug}" needs a Decision`);
  }

  /** All slugs already on disk (every ADR `*.md`; an old generated index is ignored if present). */
  private async existingSlugs(dir: string): Promise<Set<string>> {
    const names = await readdir(dir).catch(() => [] as string[]);
    return new Set(
      names
        .filter((n) => n.endsWith('.md') && n !== 'index.md')
        .map((n) => n.slice(0, -'.md'.length)),
    );
  }

  private renderEntry(
    e: AdrEntryInput,
    ctx: { decidedOn: string; supersededBy: string | null; now: Date },
  ): string {
    const fm: string[] = [
      '---',
      `id: ${e.slug}`,
      `title: ${yamlStr(e.title.trim())}`,
      `status: ${ctx.supersededBy ? 'superseded' : 'proposed'}`,
      `tags: ${yamlList(e.tags)}`,
      `decided_on: ${ctx.decidedOn}`,
      `authored_by: ${e.authoredBy ?? 'atlas'}`,
      `confirmed_by_operator: ${e.confirmedByOperator === true}`,
      `source_job: ${e.sourceThread ? yamlStr(e.sourceThread) : 'null'}`,
      `source_decision: ${e.sourceDecision ? yamlStr(e.sourceDecision) : 'null'}`,
      `supersedes: ${yamlList(e.supersedes)}`,
      `superseded_by: ${ctx.supersededBy ? yamlStr(ctx.supersededBy) : 'null'}`,
      `governs_paths: ${yamlList(e.governsPaths)}`,
      `last_reconciled: ${ctx.now.toISOString()}`,
      '---',
    ];
    const body: string[] = ['', `# ${e.title.trim()}`, '', '## Context', '', e.context.trim(), '', '## Decision', '', e.decision.trim()];
    if (e.consequences?.trim()) body.push('', '## Consequences', '', e.consequences.trim());
    if (e.alternatives?.trim()) body.push('', '## Alternatives considered', '', e.alternatives.trim());
    return `${fm.join('\n')}${body.join('\n')}\n`;
  }

}

/** The frontmatter fields the Phase-2 manifest reads back from a committed ADR file. */
export type ParsedAdrFrontmatter = {
  id: string | null;
  title: string | null;
  status: string | null;
  tags: string[];
  sourceThread: string | null;
  supersedes: string[];
  supersededBy: string | null;
  governsPaths: string[];
};

/**
 * Parse an ADR file's frontmatter back into structured fields (the read side of {@link renderEntry} —
 * kept here so the write + read formats can never drift). Tolerant of a hand-edited file: a missing or
 * malformed field degrades to null/[], never throws.
 */
export function parseAdrFrontmatter(fileText: string): ParsedAdrFrontmatter {
  return {
    id: readScalar(fileText, 'id'),
    title: readScalar(fileText, 'title'),
    status: readScalar(fileText, 'status'),
    tags: readList(fileText, 'tags'),
    sourceThread: readScalar(fileText, 'source_job'),
    supersedes: readList(fileText, 'supersedes'),
    supersededBy: readScalar(fileText, 'superseded_by'),
    governsPaths: readList(fileText, 'governs_paths'),
  };
}

// ── tiny, purpose-built frontmatter helpers (the schema is simple + fully ours; no YAML dep) ──────────

/** A YAML double-quoted scalar — JSON string encoding is a valid subset for our text. */
function yamlStr(s: string): string {
  return JSON.stringify(s);
}

/** A YAML flow sequence: `[]` when empty, else `["a", "b"]`. */
function yamlList(items?: string[]): string {
  const clean = (items ?? []).map((s) => s.trim()).filter(Boolean);
  return clean.length ? `[${clean.map(yamlStr).join(', ')}]` : '[]';
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Read a scalar frontmatter value (between the leading `---` fences). Strips surrounding quotes. */
function readScalar(fileText: string, key: string): string | null {
  const fm = frontmatterBlock(fileText);
  if (fm == null) return null;
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm);
  if (!m) return null;
  const raw = m[1].trim();
  if (raw === '' || raw === 'null') return null;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Read a frontmatter flow list (`key: ["a", "b"]`) — our lists are JSON-array-compatible. Empty on miss. */
function readList(fileText: string, key: string): string[] {
  const fm = frontmatterBlock(fileText);
  if (fm == null) return [];
  const m = new RegExp(`^${key}:[ \\t]*(\\[.*\\])[ \\t]*$`, 'm').exec(fm);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]) as unknown;
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/**
 * Replace (or append) the given frontmatter keys, leaving the body untouched. VALUES ARE PRE-RENDERED
 * YAML scalars (the caller controls quoting so a patched file matches a freshly-rendered one byte-for-byte).
 */
function patchFrontmatter(fileText: string, fields: Record<string, string>): string {
  if (!fileText.startsWith('---')) return fileText; // not a frontmatter doc — leave it alone
  const end = fileText.indexOf('\n---', 3);
  if (end < 0) return fileText;
  let fm = fileText.slice(3, end + 1); // between the fences (keeps trailing newline)
  const rest = fileText.slice(end + 1); // from the closing `\n---` onward
  for (const [key, value] of Object.entries(fields)) {
    const rendered = `${key}: ${value}`;
    const re = new RegExp(`^${key}:.*$`, 'm');
    fm = re.test(fm) ? fm.replace(re, rendered) : `${fm}${rendered}\n`;
  }
  return `---${fm}${rest}`;
}

/** The raw text between the leading `---` fences, or null when the doc has no frontmatter. */
function frontmatterBlock(fileText: string): string | null {
  if (!fileText.startsWith('---')) return null;
  const end = fileText.indexOf('\n---', 3);
  return end < 0 ? null : fileText.slice(3, end + 1);
}
