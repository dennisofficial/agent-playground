# Deferred: DB-backed employee config + gated cross-tenant promotion

> Status: **DEFERRED** (own session, heavy guardrails). The single-process / single-DB refactor
> (`refactor/single-process-multitenant`) laid the rails for this; only the write/gating side and
> the persona-→-DB migration remain. See the plan `~/.claude/plans/take-a-look-at-ancient-ritchie.md`
> and memory `deployment-sandbox-architecture-handoff`.

## Goal

Move employee identity out of byte-stable code constants
(`backend/src/harness/employees/roster/*.employee.ts`: `roleContext`, `personality`, `protocols`,
`skills`) into the **database** so personas load **dynamically**. "Promoting / training" an
employee then becomes a **DB write** that the skills/persona loader picks up — every workspace
benefits at once, no redeploy, no per-workspace retrain. This is the connectivity Dennis wants:
improve an employee once, all workspaces get it.

## What this build already shipped (the rails)

- **`facts.team_id` nullable** — `NULL` is the **shared/global tier** (recalled in every workspace);
  per-tenant reads filter `(team_id = :tid OR team_id IS NULL)`, dedup/insert use `team_id = :tid`.
  Promoting a fact = setting its `team_id` to `NULL`.
- **`employee_skills` table** (`shared/src/schemas/employee-skill.entity.ts`): `employee_id`,
  `team_id` (NULL = global), `name`, `description`, `source` (the `SkillSource` JSON the loader
  resolves). The skills loader (`backend/src/harness/skills/`) is still a no-op; this table is the
  read target it will gain.
- Per-tenant isolation everywhere else (conversation/project/bot/pair memory stays workspace-private).

## Shape to build

`employee_config(employee_id, version, role_context, personality, protocols jsonb, skills jsonb,
team_id NULL=global, status draft|active, approved_by, created_at)`.

- `EmployeeRegistry` / `PersonaService` read the **active global row** (overlaid by any per-team
  override), instead of the decorator constants. Decorator discovery still seeds the **baseline**
  row on first boot (so a fresh DB has working personas).
- The skills loader merges code-declared skills + `employee_skills` rows (global + per-team).

## Critical constraint — prompt-cache byte-stability

`roleContext` / `personality` are `cache_control` breakpoints and MUST be **byte-stable within a
cache window** (see CLAUDE.md "byte-stable string constants"). DB loading is fine **only if**:

- the value is resolved **once per process (or per explicit refresh)**, never interpolated per turn;
- a **`version` bump** is the deliberate cache-invalidation signal (a new active version → the
  loader rebuilds the persona string → the next turn writes a fresh cache prefix).

Document and enforce this in the loader: cache the assembled persona per `(employee_id, version)`.

## Gated promotion pipeline (the reason this is deferred)

Promotion = elevating a per-team learning (a `team_id`-scoped fact, an `employee_skills` row, or an
`employee_config` draft) to `team_id = NULL`. Model it as a **reviewed release** (fits the
"skills-as-reviewed-git-releases" stance):

1. **draft** — a per-team change captured (a fact, a skill package, a config edit).
2. **diff / preview** — show what changes globally (which workspaces, what behavior).
3. **multi-approval gate** — at least Dennis; the pipeline is the guardrail, training MODIFIES
   employee internal behavior so it must not be one-click.
4. **activate** — version bump; all workspaces pick it up on next refresh.
5. **rollback** — revert to the prior active version.

Tie facts promotion (`team_id := NULL`) and skills/config promotion to the **same release object**
so a promotion is one auditable unit.

## Out of scope here / open questions

- Where promotion is initiated (admin web UI vs a gated in-Slack action) — decide in the session.
- Whether per-team persona overrides are allowed at all, or global-only (simpler).
- Migration of the existing 6 roster classes into seed rows (keep the classes as the seed source).
