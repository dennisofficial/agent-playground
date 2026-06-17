import { PipelineRunSection as PipelineRunSectionEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

export type SectionStatus =
  | 'pending'
  | 'planning'
  | 'building'
  | 'done'
  | 'failed'
  // A design section paused for the human (or, later, a designer agent) to produce its artifact.
  | 'awaiting_design'
  // A design section (and its implementer) the human chose to skip — deferred, not built.
  | 'skipped';

/** Section statuses that count as "this section is the live one" (at most one per run, sequential). */
export const ACTIVE_SECTION_STATUSES: SectionStatus[] = [
  'planning',
  'building',
  'awaiting_design',
];
/** A dependency is satisfied once the upstream section has landed (done) or been deliberately skipped. */
const SATISFIED_DEP_STATUSES: ReadonlySet<string> = new Set(['done', 'skipped']);

/** One build phase parsed from a section's approved plan (the fenced `phases` JSON block). The
 * explicit `pipeline_run_phases` rows are now authoritative for navigation; this jsonb mirror is
 * dual-written during the transition (boot fallback + the prompt builders + the awareness slice). */
export interface SectionPhase {
  /** Phase number from the plan (1-based). */
  id: number;
  title?: string;
  /** Optional coding-session GROUP number from the plan (Phase 4): CONSECUTIVE phases sharing the same
   * `group` build in ONE engine context (one shared worktree, tight context). Omitted ⇒ this phase is
   * its own group, preserving the 1-phase-per-session default. `phaseGroups` folds contiguous runs. */
  group?: number;
  /** Set true once this phase's post-phase review has completed — keeps boot-recovery from
   * re-running a review whose phase session was already idle. */
  reviewed?: boolean;
}

/** A coding-session group: the contiguous run of phases that share one engine context. */
export interface PhaseGroup {
  /** 0-based position of this group within the section (execution order). */
  index: number;
  /** The phases (plan order) built together in this group's single session. */
  phases: SectionPhase[];
}

/**
 * Fold a section's phases into CONTIGUOUS coding-session groups (Phase 4). Adjacent phases carrying the
 * same defined `group` number fold into one group (one shared engine context); any phase with no
 * `group`, or one that breaks the contiguous same-number run, starts a fresh group. With no `group`
 * anywhere this yields one group per phase — exactly the pre-Phase-4 1:1 behavior. Groups stay in plan
 * order and partition the phase sequence (every phase lands in exactly one group).
 */
export function phaseGroups(phases: SectionPhase[]): PhaseGroup[] {
  const groups: PhaseGroup[] = [];
  let current: SectionPhase[] = [];
  let currentKey: number | undefined;
  for (const p of phases) {
    const foldable =
      current.length > 0 &&
      p.group !== undefined &&
      currentKey !== undefined &&
      p.group === currentKey;
    if (foldable) {
      current.push(p);
    } else {
      if (current.length) groups.push({ index: groups.length, phases: current });
      current = [p];
    }
    currentKey = p.group;
  }
  if (current.length) groups.push({ index: groups.length, phases: current });
  return groups;
}

export interface PipelineRunSection {
  id: string;
  runId: string;
  team: string;
  /** Gap-numbered (10, 20, 30…) for insert-without-renumber; ORDER BY this for execution order. */
  ordinal: number;
  name: string;
  brief?: string;
  phaseRole: string;
  status: SectionStatus;
  /** The APPROVED plan (MD#2), archived at the section's gate (team_task_plans holds only the active). */
  planMd?: string;
  phases?: SectionPhase[];
  phaseCount?: number;
  /** Section ordinals this section waits on (default empty = strictly ordinal-sequential). */
  dependsOn: number[];
  /** True once the section has committed work — IMMUTABLE to living-section ops (no reorder / no wedge
   * before it). */
  frozen: boolean;
  /** The harness Session id currently live for this section, or undefined between sessions. */
  activeSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewPipelineRunSection {
  ordinal: number;
  name: string;
  brief?: string;
  phaseRole: string;
  status?: SectionStatus;
  dependsOn?: number[];
}

/** A living-section mutation result: the new/affected section, or a helpful refusal reason. */
export type SectionMutation =
  | { ok: true; section: PipelineRunSection }
  | { ok: false; reason: string };

interface PipelineRunSectionRow {
  id: string;
  run_id: string;
  team_id: string;
  ordinal: number | string;
  name: string;
  brief: string | null;
  phase_role: string;
  status: string;
  plan_md: string | null;
  phases_json: SectionPhase[] | null;
  phase_count: number | string | null;
  depends_on: (number | string)[] | null;
  frozen: boolean | null;
  active_session_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const toSection = (r: PipelineRunSectionRow): PipelineRunSection => ({
  id: r.id,
  runId: r.run_id,
  team: r.team_id,
  ordinal: Number(r.ordinal),
  name: r.name,
  brief: r.brief ?? undefined,
  phaseRole: r.phase_role,
  status: r.status as SectionStatus,
  planMd: r.plan_md ?? undefined,
  phases: r.phases_json ?? undefined,
  phaseCount: r.phase_count == null ? undefined : Number(r.phase_count),
  dependsOn: (r.depends_on ?? []).map(Number),
  frozen: r.frozen === true,
  activeSessionId: r.active_session_id ?? undefined,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

/**
 * Durable store for the SECTIONS of a dynamic section-driver pipeline run (e.g. "backend", then
 * "frontend"). Atlas declares the section list at dispatch; each is planned just-in-time and built
 * sequentially. Each section's `status` is the authoritative cursor — `activeSection`/`nextPending`
 * navigate by status (+ `depends_on` topological order), not by the positional `section_index`
 * (dual-written through the transition). LIVING sections: `insertSection`/`reorderSections`/
 * `appendSection` edit the still-pending tail of the queue, never the `frozen` (committed) head.
 * Raw-SQL, mirroring `PipelineRunStore`.
 */
export class PipelineRunSectionStore {
  constructor(private readonly repo: Repository<PipelineRunSectionEntity>) {}

  private async q(
    sql: string,
    params: unknown[],
  ): Promise<PipelineRunSectionRow[]> {
    return rawRows<PipelineRunSectionRow>(
      await this.repo.manager.query(sql, params),
    );
  }

  /** Insert the declared section list for a run (ordinal-ordered). */
  async createMany(
    runId: string,
    team: string,
    sections: ReadonlyArray<NewPipelineRunSection>,
  ): Promise<PipelineRunSection[]> {
    const out: PipelineRunSection[] = [];
    for (const s of sections) {
      const rows = await this.q(
        `INSERT INTO pipeline_run_sections
           (run_id, team_id, ordinal, name, brief, phase_role, status, depends_on, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
         RETURNING *`,
        [
          runId,
          team,
          s.ordinal,
          s.name,
          s.brief ?? null,
          s.phaseRole,
          s.status ?? 'pending',
          [...new Set(s.dependsOn ?? [])],
        ],
      );
      out.push(toSection(rows[0]));
    }
    return out;
  }

  /** All sections of a run, in execution order (ordinal asc). */
  async listForRun(runId: string): Promise<PipelineRunSection[]> {
    const rows = await this.q(
      `SELECT * FROM pipeline_run_sections WHERE run_id = $1 ORDER BY ordinal ASC`,
      [runId],
    );
    return rows.map(toSection);
  }

  /** A single section by id, or undefined. */
  async get(id: string): Promise<PipelineRunSection | undefined> {
    const rows = await this.q(
      `SELECT * FROM pipeline_run_sections WHERE id = $1`,
      [id],
    );
    return rows[0] ? toSection(rows[0]) : undefined;
  }

  /** The section currently live (status planning/building/awaiting_design), lowest ordinal — the
   * explicit-row cursor. At most one per run by the sequential invariant. */
  async activeSection(runId: string): Promise<PipelineRunSection | undefined> {
    const rows = await this.q(
      `SELECT * FROM pipeline_run_sections
         WHERE run_id = $1 AND status = ANY($2)
         ORDER BY ordinal ASC LIMIT 1`,
      [runId, ACTIVE_SECTION_STATUSES],
    );
    return rows[0] ? toSection(rows[0]) : undefined;
  }

  /**
   * The next section ready to run: the lowest-ordinal `pending` section whose every dependency has
   * landed (done/skipped). undefined when none is runnable — the caller distinguishes "no pending
   * left → ship" from "pending left but blocked → dependency deadlock → failRun". Topological over
   * `depends_on`; with the default empty deps this is plain ordinal order.
   */
  async nextPending(runId: string): Promise<PipelineRunSection | undefined> {
    const sections = await this.listForRun(runId);
    const byOrdinal = new Map(sections.map((s) => [s.ordinal, s]));
    for (const s of sections) {
      if (s.status !== 'pending') continue;
      const satisfied = s.dependsOn.every((d) => {
        const dep = byOrdinal.get(d);
        return dep != null && SATISFIED_DEP_STATUSES.has(dep.status);
      });
      if (satisfied) return s;
    }
    return undefined;
  }

  /** Guarded partial update — only fields present in patch are written; updated_at always set. */
  async update(
    id: string,
    patch: {
      status?: SectionStatus;
      planMd?: string | null;
      phases?: SectionPhase[] | null;
      phaseCount?: number | null;
      ordinal?: number;
      dependsOn?: number[];
      frozen?: boolean;
      activeSessionId?: string | null;
    },
  ): Promise<PipelineRunSection | undefined> {
    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if ('planMd' in patch) set('plan_md', patch.planMd ?? null);
    if ('phases' in patch) {
      args.push(patch.phases == null ? null : JSON.stringify(patch.phases));
      sets.push(`phases_json = $${args.length}::jsonb`);
    }
    if ('phaseCount' in patch) set('phase_count', patch.phaseCount ?? null);
    if (patch.ordinal !== undefined) set('ordinal', patch.ordinal);
    if (patch.dependsOn !== undefined)
      set('depends_on', [...new Set(patch.dependsOn)]);
    if (patch.frozen !== undefined) set('frozen', patch.frozen);
    if ('activeSessionId' in patch)
      set('active_session_id', patch.activeSessionId ?? null);
    const rows = await this.q(
      `UPDATE pipeline_run_sections SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      args,
    );
    return rows[0] ? toSection(rows[0]) : undefined;
  }

  // ── living sections ───────────────────────────────────────────────────────

  /**
   * Append a new pending section after every existing one (always legal — you may add work after
   * committed work). Born `pending`; deps default to none (runs after the current tail by ordinal).
   */
  async appendSection(
    runId: string,
    team: string,
    spec: { name: string; brief?: string; phaseRole: string; dependsOn?: number[] },
  ): Promise<SectionMutation> {
    return this.repo.manager.transaction(async (em) => {
      const sections = await this.lockSections(em, runId);
      const maxOrdinal = sections.reduce((m, s) => Math.max(m, s.ordinal), 0);
      const ordinal = maxOrdinal + 10;
      const deps = [...new Set(spec.dependsOn ?? [])];
      const bad = this.invalidBackwardDeps(deps, ordinal, sections);
      if (bad) return { ok: false, reason: bad };
      return this.insertRow(em, runId, team, ordinal, spec, deps);
    });
  }

  /**
   * Insert a new pending section immediately after the section at `afterOrdinal`, using the gap-ordinal
   * midpoint. INVARIANTS (rejected, never silently coerced): the anchor must exist; there must be an
   * integer gap; and the new section may NOT land before any frozen (committed) section — you can only
   * wedge into the still-pending tail. Born `pending`, depending on the anchor by default.
   */
  async insertSection(
    runId: string,
    team: string,
    afterOrdinal: number,
    spec: { name: string; brief?: string; phaseRole: string; dependsOn?: number[] },
  ): Promise<SectionMutation> {
    return this.repo.manager.transaction(async (em) => {
      const sections = await this.lockSections(em, runId);
      const anchor = sections.find((s) => s.ordinal === afterOrdinal);
      if (!anchor)
        return {
          ok: false,
          reason: `no section at ordinal ${afterOrdinal} to insert after`,
        };
      const next = sections.find((s) => s.ordinal > afterOrdinal);
      const ordinal = next
        ? Math.floor((anchor.ordinal + next.ordinal) / 2)
        : anchor.ordinal + 10;
      if (next && ordinal <= anchor.ordinal)
        return {
          ok: false,
          reason: `no ordinal gap between ${anchor.ordinal} and ${next.ordinal} to wedge into — reorder the pending sections first`,
        };
      const maxFrozen = sections
        .filter((s) => s.frozen)
        .reduce((m, s) => Math.max(m, s.ordinal), 0);
      if (ordinal <= maxFrozen)
        return {
          ok: false,
          reason: `can't wedge a section before already-committed work — you can only append after the frozen sections`,
        };
      const deps =
        spec.dependsOn !== undefined
          ? [...new Set(spec.dependsOn)]
          : [anchor.ordinal];
      const bad = this.invalidBackwardDeps(deps, ordinal, sections);
      if (bad) return { ok: false, reason: bad };
      return this.insertRow(em, runId, team, ordinal, spec, deps);
    });
  }

  /**
   * Reorder the still-`pending` sections of a run to match `orderedNames` (gate-the-substance: same
   * sections, new order ⇒ no re-approval). Only pending sections move; frozen/active/done sections keep
   * their ordinals. The new ordinals sit AFTER the last committed/active section, and any `depends_on`
   * referencing a moved section is remapped so the dependency graph stays consistent. Rejected if a
   * named section isn't pending, the set doesn't match, or the requested order breaks a dependency
   * (a dep would point forward). Atomic (single transaction).
   */
  async reorderSections(
    runId: string,
    team: string,
    orderedNames: string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.repo.manager.transaction(async (em) => {
      const sections = await this.lockSections(em, runId);
      const pending = sections.filter((s) => s.status === 'pending');
      const pendingByName = new Map(pending.map((s) => [s.name, s]));

      if (orderedNames.length !== pending.length)
        return {
          ok: false,
          reason: `reorder must list every pending section exactly once (${pending.length} pending: ${pending.map((s) => s.name).join(', ') || 'none'})`,
        };
      const seen = new Set<string>();
      for (const name of orderedNames) {
        if (seen.has(name))
          return { ok: false, reason: `'${name}' listed twice in the reorder` };
        seen.add(name);
        if (!pendingByName.has(name)) {
          const found = sections.find((s) => s.name === name);
          return {
            ok: false,
            reason: found
              ? `can't reorder '${name}' — it's already ${found.status}, not pending`
              : `no pending section named '${name}' in this run`,
          };
        }
      }

      const base = sections
        .filter((s) => s.status !== 'pending')
        .reduce((m, s) => Math.max(m, s.ordinal), 0);
      // old→new ordinal map (identity for the unmoved, committed/active sections).
      const remap = new Map<number, number>();
      orderedNames.forEach((name, i) => {
        remap.set(pendingByName.get(name)!.ordinal, base + (i + 1) * 10);
      });
      const newOrdinal = (o: number): number => remap.get(o) ?? o;

      // Validate the resulting graph: every dependency must still point strictly backward.
      for (const s of sections) {
        const sOrd = newOrdinal(s.ordinal);
        for (const d of s.dependsOn) {
          const depExists = sections.some((x) => x.ordinal === d);
          if (!depExists) continue; // a stale dep is inert (treated as unsatisfiable elsewhere)
          if (newOrdinal(d) >= sOrd)
            return {
              ok: false,
              reason: `that order breaks a dependency — '${s.name}' must come after the section it depends on`,
            };
        }
      }

      // Two-phase ordinal rewrite to dodge the UNIQUE(run_id, ordinal) constraint mid-update: shift all
      // pending sections far out of range, then drop each onto its final ordinal.
      await em.query(
        `UPDATE pipeline_run_sections SET ordinal = ordinal + 1000000 WHERE run_id = $1 AND status = 'pending'`,
        [runId],
      );
      for (const name of orderedNames) {
        const sec = pendingByName.get(name)!;
        await em.query(
          `UPDATE pipeline_run_sections SET ordinal = $2, updated_at = now() WHERE id = $1`,
          [sec.id, newOrdinal(sec.ordinal)],
        );
      }
      // Remap any depends_on that referenced a moved section.
      for (const s of sections) {
        const remapped = s.dependsOn.map(newOrdinal);
        if (remapped.some((v, i) => v !== s.dependsOn[i]))
          await em.query(
            `UPDATE pipeline_run_sections SET depends_on = $2, updated_at = now() WHERE id = $1`,
            [s.id, remapped],
          );
      }
      return { ok: true };
    });
  }

  // ── living-section helpers ──────────────────────────────────────────────────

  private async lockSections(
    em: { query(sql: string, params: unknown[]): Promise<unknown> },
    runId: string,
  ): Promise<PipelineRunSection[]> {
    const rows = rawRows<PipelineRunSectionRow>(
      await em.query(
        `SELECT * FROM pipeline_run_sections WHERE run_id = $1 ORDER BY ordinal ASC FOR UPDATE`,
        [runId],
      ),
    );
    return rows.map(toSection);
  }

  /** Reject deps that don't reference an existing section with a strictly smaller ordinal (a forward
   * or cyclic dependency). Returns a reason string, or null when the deps are valid (backward-only). */
  private invalidBackwardDeps(
    deps: number[],
    ordinal: number,
    sections: PipelineRunSection[],
  ): string | null {
    for (const d of deps) {
      const dep = sections.find((s) => s.ordinal === d);
      if (!dep)
        return `dependency on ordinal ${d} doesn't match any section in this run`;
      if (dep.ordinal >= ordinal)
        return `a section can only depend on earlier sections (ordinal ${d} is not before ${ordinal})`;
    }
    return null;
  }

  private async insertRow(
    em: { query(sql: string, params: unknown[]): Promise<unknown> },
    runId: string,
    team: string,
    ordinal: number,
    spec: { name: string; brief?: string; phaseRole: string },
    deps: number[],
  ): Promise<{ ok: true; section: PipelineRunSection }> {
    const rows = rawRows<PipelineRunSectionRow>(
      await em.query(
        `INSERT INTO pipeline_run_sections
           (run_id, team_id, ordinal, name, brief, phase_role, status, depends_on, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, now(), now())
         RETURNING *`,
        [runId, team, ordinal, spec.name, spec.brief ?? null, spec.phaseRole, deps],
      ),
    );
    return { ok: true, section: toSection(rows[0]) };
  }
}
