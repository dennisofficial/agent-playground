/**
 * Shared in-memory fakes for the PipelineRunnerService specs (NOT a test file — no `.spec`/`.test`
 * suffix, so vitest never collects it). These mirror the durable stores' OBSERVABLE contracts —
 * status-driven `activeSection`/`activePhase`, topological `nextPending`, and the living-section
 * invariants (frozen-wedge, forward-dep, pending-only reorder) — closely enough to drive the FSM
 * without a DB. The real SQL is exercised by `pipeline-rows.int.test.ts`.
 */

export interface Row {
  [k: string]: unknown;
}

const clone = (r: Row): Row => ({ ...r });

/** Apply a partial patch the way the raw-SQL stores do: null clears (→ undefined), other keys overwrite. */
function applyPatch(r: Row, patch: Row): void {
  for (const k of Object.keys(patch)) r[k] = patch[k] === null ? undefined : patch[k];
}

export class FakeRunStore {
  rows = new Map<string, Row>();
  private seq = 0;
  async create(n: Row): Promise<Row> {
    const id = `run-${++this.seq}`;
    const row: Row = {
      id,
      team: n.team,
      taskId: n.taskId,
      pipeline: n.pipeline,
      status: n.status ?? 'running',
      currentRole: n.currentRole,
      mode: n.mode,
      worktreeId: n.worktreeId,
      sessionId: n.sessionId,
      notifyThread: n.notifyThread,
      project: n.project,
      kind: n.kind ?? 'feature',
      sectionIndex: n.sectionIndex ?? 0,
      phaseIndex: n.phaseIndex ?? 0,
      planningSubstep: n.planningSubstep,
      overview: n.overview,
      activeSectionId: n.activeSectionId,
    };
    this.rows.set(id, row);
    return clone(row);
  }
  async get(team: string, id: string): Promise<Row | undefined> {
    const r = this.rows.get(id);
    return r && r.team === team ? clone(r) : undefined;
  }
  async getByTask(team: string, taskId: number): Promise<Row | undefined> {
    const all = [...this.rows.values()].filter(
      (r) => r.team === team && r.taskId === taskId,
    );
    return all.length ? clone(all[all.length - 1]) : undefined;
  }
  async update(team: string, id: string, patch: Row): Promise<Row | undefined> {
    const r = this.rows.get(id);
    if (!r) return undefined;
    applyPatch(r, patch);
    return clone(r);
  }
  async listAllActive(): Promise<Row[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === 'running' || r.status === 'paused')
      .map(clone);
  }
}

const ACTIVE_SECTION = new Set(['planning', 'building', 'awaiting_design']);
const SATISFIED = new Set(['done', 'skipped']);

export class FakeSectionStore {
  rows: Row[] = [];
  private seq = 0;

  async createMany(runId: string, team: string, sections: Row[]): Promise<Row[]> {
    return sections.map((s) => {
      const row: Row = {
        id: `sec-${++this.seq}`,
        runId,
        team,
        ordinal: s.ordinal,
        name: s.name,
        brief: s.brief,
        phaseRole: s.phaseRole,
        status: s.status ?? 'pending',
        planMd: undefined,
        phases: undefined,
        phaseCount: undefined,
        dependsOn: (s.dependsOn as number[] | undefined) ?? [],
        frozen: false,
        activeSessionId: undefined,
      };
      this.rows.push(row);
      return clone(row);
    });
  }
  private sorted(runId: string): Row[] {
    return this.rows
      .filter((r) => r.runId === runId)
      .sort((a, b) => (a.ordinal as number) - (b.ordinal as number));
  }
  async listForRun(runId: string): Promise<Row[]> {
    return this.sorted(runId).map(clone);
  }
  async get(id: string): Promise<Row | undefined> {
    const r = this.rows.find((x) => x.id === id);
    return r ? clone(r) : undefined;
  }
  async activeSection(runId: string): Promise<Row | undefined> {
    const r = this.sorted(runId).find((s) => ACTIVE_SECTION.has(s.status as string));
    return r ? clone(r) : undefined;
  }
  async nextPending(runId: string): Promise<Row | undefined> {
    const all = this.sorted(runId);
    for (const s of all) {
      if (s.status !== 'pending') continue;
      const deps = (s.dependsOn as number[] | undefined) ?? [];
      const ok = deps.every((d) => {
        const dep = all.find((x) => x.ordinal === d);
        return dep != null && SATISFIED.has(dep.status as string);
      });
      if (ok) return clone(s);
    }
    return undefined;
  }
  async update(id: string, patch: Row): Promise<Row | undefined> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return undefined;
    applyPatch(r, patch);
    return clone(r);
  }

  async insertSection(
    runId: string,
    team: string,
    afterOrdinal: number,
    spec: Row,
  ): Promise<{ ok: true; section: Row } | { ok: false; reason: string }> {
    const all = this.sorted(runId);
    const anchor = all.find((s) => s.ordinal === afterOrdinal);
    if (!anchor) return { ok: false, reason: `no section at ordinal ${afterOrdinal}` };
    const next = all.find((s) => (s.ordinal as number) > afterOrdinal);
    const ordinal = next
      ? Math.floor(((anchor.ordinal as number) + (next.ordinal as number)) / 2)
      : (anchor.ordinal as number) + 10;
    if (next && ordinal <= (anchor.ordinal as number))
      return { ok: false, reason: 'no ordinal gap' };
    const maxFrozen = all
      .filter((s) => s.frozen)
      .reduce((m, s) => Math.max(m, s.ordinal as number), 0);
    if (ordinal <= maxFrozen) return { ok: false, reason: 'before frozen work' };
    const deps =
      (spec.dependsOn as number[] | undefined) ?? [anchor.ordinal as number];
    for (const d of deps) {
      const dep = all.find((s) => s.ordinal === d);
      if (!dep || (dep.ordinal as number) >= ordinal)
        return { ok: false, reason: `bad dependency ${d}` };
    }
    const row: Row = {
      id: `sec-${++this.seq}`,
      runId,
      team,
      ordinal,
      name: spec.name,
      brief: spec.brief,
      phaseRole: spec.phaseRole,
      status: 'pending',
      planMd: undefined,
      phases: undefined,
      phaseCount: undefined,
      dependsOn: deps,
      frozen: false,
      activeSessionId: undefined,
    };
    this.rows.push(row);
    return { ok: true, section: clone(row) };
  }

  async reorderSections(
    runId: string,
    _team: string,
    orderedNames: string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const all = this.sorted(runId);
    const pending = all.filter((s) => s.status === 'pending');
    const byName = new Map(pending.map((s) => [s.name as string, s]));
    if (orderedNames.length !== pending.length)
      return { ok: false, reason: 'must list every pending section once' };
    for (const n of orderedNames) {
      if (!byName.has(n)) {
        const found = all.find((s) => s.name === n);
        return {
          ok: false,
          reason: found ? `'${n}' is ${found.status}, not pending` : `no pending '${n}'`,
        };
      }
    }
    const base = all
      .filter((s) => s.status !== 'pending')
      .reduce((m, s) => Math.max(m, s.ordinal as number), 0);
    const remap = new Map<number, number>();
    orderedNames.forEach((n, i) =>
      remap.set(byName.get(n)!.ordinal as number, base + (i + 1) * 10),
    );
    const newOrd = (o: number): number => remap.get(o) ?? o;
    for (const s of all)
      for (const d of (s.dependsOn as number[] | undefined) ?? []) {
        if (!all.some((x) => x.ordinal === d)) continue;
        if (newOrd(d) >= newOrd(s.ordinal as number))
          return { ok: false, reason: 'order breaks a dependency' };
      }
    const depUpdates = all.map((s) => ({
      id: s.id as string,
      newDeps: ((s.dependsOn as number[] | undefined) ?? []).map(newOrd),
    }));
    for (const n of orderedNames) {
      const real = this.rows.find((r) => r.id === byName.get(n)!.id)!;
      real.ordinal = newOrd(real.ordinal as number);
    }
    for (const { id, newDeps } of depUpdates) {
      const real = this.rows.find((r) => r.id === id)!;
      real.dependsOn = newDeps;
    }
    return { ok: true };
  }
}

const ACTIVE_PHASE = new Set(['building', 'reviewing']);
const ACTIVE_CODING = new Set(['building', 'reviewing']);

export class FakePhaseStore {
  rows: Row[] = [];
  private seq = 0;
  async createMany(
    runId: string,
    team: string,
    sectionId: string,
    phases: Row[],
  ): Promise<Row[]> {
    return phases.map((p) => {
      const row: Row = {
        id: `ph-${++this.seq}`,
        sectionId,
        runId,
        team,
        ordinal: p.ordinal,
        planPhaseId: p.planPhaseId,
        title: p.title,
        status: p.status ?? 'pending',
        codingSessionId: p.codingSessionId,
      };
      this.rows.push(row);
      return clone(row);
    });
  }
  private sorted(sectionId: string): Row[] {
    return this.rows
      .filter((r) => r.sectionId === sectionId)
      .sort((a, b) => (a.ordinal as number) - (b.ordinal as number));
  }
  async listForSection(sectionId: string): Promise<Row[]> {
    return this.sorted(sectionId).map(clone);
  }
  async get(id: string): Promise<Row | undefined> {
    const r = this.rows.find((x) => x.id === id);
    return r ? clone(r) : undefined;
  }
  async activePhase(sectionId: string): Promise<Row | undefined> {
    const r = this.sorted(sectionId).find((p) => ACTIVE_PHASE.has(p.status as string));
    return r ? clone(r) : undefined;
  }
  async nextPending(sectionId: string): Promise<Row | undefined> {
    const r = this.sorted(sectionId).find((p) => p.status === 'pending');
    return r ? clone(r) : undefined;
  }
  async deleteForSection(sectionId: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.sectionId !== sectionId);
    return before - this.rows.length;
  }
  async update(id: string, patch: Row): Promise<Row | undefined> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return undefined;
    applyPatch(r, patch);
    return clone(r);
  }
}

export class FakeCodingStore {
  rows: Row[] = [];
  private seq = 0;
  async createMany(
    runId: string,
    team: string,
    sectionId: string,
    sessions: Row[],
  ): Promise<Row[]> {
    return sessions.map((s) => {
      const row: Row = {
        id: `cs-${++this.seq}`,
        sectionId,
        runId,
        team,
        ordinal: s.ordinal,
        status: s.status ?? 'pending',
        engineSessionId: undefined,
        handoffIn: s.handoffIn,
        handoffOut: undefined,
      };
      this.rows.push(row);
      return clone(row);
    });
  }
  async listForSection(sectionId: string): Promise<Row[]> {
    return this.rows
      .filter((r) => r.sectionId === sectionId)
      .sort((a, b) => (a.ordinal as number) - (b.ordinal as number))
      .map(clone);
  }
  async get(id: string): Promise<Row | undefined> {
    const r = this.rows.find((x) => x.id === id);
    return r ? clone(r) : undefined;
  }
  async activeCodingSession(sectionId: string): Promise<Row | undefined> {
    const r = this.rows
      .filter((x) => x.sectionId === sectionId)
      .sort((a, b) => (a.ordinal as number) - (b.ordinal as number))
      .find((c) => ACTIVE_CODING.has(c.status as string));
    return r ? clone(r) : undefined;
  }
  async nextPending(sectionId: string): Promise<Row | undefined> {
    const r = this.rows
      .filter((x) => x.sectionId === sectionId)
      .sort((a, b) => (a.ordinal as number) - (b.ordinal as number))
      .find((c) => c.status === 'pending');
    return r ? clone(r) : undefined;
  }
  async deletePending(sectionId: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (r) => !(r.sectionId === sectionId && r.status === 'pending'),
    );
    return before - this.rows.length;
  }
  async deleteForSection(sectionId: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.sectionId !== sectionId);
    return before - this.rows.length;
  }
  async update(id: string, patch: Row): Promise<Row | undefined> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return undefined;
    applyPatch(r, patch);
    return clone(r);
  }
}

/** Append-only ticket notes — newest-first `listForTask`, enough for the deny-grill (reads Dennis's
 * latest changes-requested note). Team is ignored (the specs run one team). */
export class FakeNoteStore {
  rows: Row[] = [];
  private seq = 0;
  async add(
    _team: string,
    taskId: number,
    author: string,
    body: string,
  ): Promise<Row> {
    const row: Row = { id: ++this.seq, taskId, author, body, createdAt: '' };
    this.rows.push(row);
    return clone(row);
  }
  async listForTask(
    _team: string,
    taskId: number,
    _opts: { page?: number; pageSize?: number } = {},
  ): Promise<{ notes: Row[]; total: number }> {
    const all = this.rows
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => (b.id as number) - (a.id as number)); // newest-first
    return { notes: all.map(clone), total: all.length };
  }
}

export class FakeReviewStore {
  rows: Row[] = [];
  private seq = 0;
  async create(runId: string, team: string, review: Row): Promise<Row> {
    const row: Row = {
      id: `rev-${++this.seq}`,
      phaseId: review.phaseId,
      runId,
      team,
      attempt: review.attempt ?? 1,
      status: review.status ?? 'running',
      engineSessionId: review.engineSessionId,
      blocker: undefined,
      summary: undefined,
    };
    this.rows.push(row);
    return clone(row);
  }
  async listForPhase(phaseId: string): Promise<Row[]> {
    return this.rows
      .filter((r) => r.phaseId === phaseId)
      .sort((a, b) => (a.attempt as number) - (b.attempt as number))
      .map(clone);
  }
  async latestForPhase(phaseId: string): Promise<Row | undefined> {
    const all = await this.listForPhase(phaseId);
    return all.length ? all[all.length - 1] : undefined;
  }
  /** Reviews key off phaseId (no section_id column); the real store deletes via a phase-id subquery,
   * exercised by the int tests. In the fakes a reopen deletes the section's phase rows separately, so a
   * no-op here leaves no dangling reviews the unit FSM ever reads. */
  async deleteForSection(_sectionId: string): Promise<number> {
    return 0;
  }
  async update(id: string, patch: Row): Promise<Row | undefined> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return undefined;
    applyPatch(r, patch);
    return clone(r);
  }
}
