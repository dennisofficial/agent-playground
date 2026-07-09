# prompt-kit authoring standard

The reference every fragment in `prompt-kit/` (and every coding-agent prompt sourced from it) follows. It
exists so the system prompts stay DRY, single-concern, and reviewable. The CODE is authoritative where it
disagrees with this doc; when you change the code in a way this doc should reflect, update the doc in the same
change.

## What the system is

`backend/src/app/prompt-kit/` composes every coding-agent system prompt from `@Fragment`-decorated METHODS on
`@FragmentGroup` classes (`groups/*.ts`). A prompt is assembled for exactly ONE `Agent` (the audience
dimension, `agent.ts`): `assemble.ts` lifts every fragment method, filters by `meta.usedBy.includes(agent)` and
`meta.condition(ctx)`, sorts by `meta.order`, renders, trims, drops empties, and joins with `\n\n`. Shared
prose lives ONCE in `fragments.ts` as exported consts and is spliced into the groups that need it. Boot
validation (`validateFragments`) fails loud on an empty `usedBy`, a non-finite or duplicate `order` per agent,
or a throwing fragment. Two entry points delegate to the same pure core: `PromptService.generate` (DI) and
`renderAgentPrompt` (no-DI, also bundled into the in-container engine).

The architecture is sound — a fragment library keyed by audience + order, a pure `assemble.ts`, boot
validation. This standard is about hygiene and DRY/SOLID discipline WITHIN that architecture, not a
re-architecture.

## Glossary (canonical terms — avoid the drift words)

- **Fragment** — one `@Fragment` method returning a prose block. SRP: one concern. Do NOT call these "blocks"
  (the `block NN` numbering was a legacy scar and is removed).
- **Group** — a `@FragmentGroup` class bucketing fragments by TOPIC (`groups/*.ts`).
- **Agent** — the AUDIENCE a prompt is assembled for (`Agent` enum). A "persona" = the set of fragments
  addressed to one agent. Avoid "role prompt" / "whole-body prompt" — there is no monolithic body.
- **Shared fragment (catalog const)** — reusable prose in `fragments.ts`, the single home for text more than
  one consumer needs. If prose appears for 2+ agents, it lives here, not re-derived per group.
- **Persona template** — the uniform shape every agent-facing persona fragment follows (below).

There is no legacy composer, `bodies/`, or `layers.ts` — those were a prior architecture and are gone. A doc
comment that references them, or a "Phase N of the rollout" note, is stale; delete it.

## The standard

### 1. Persona shape

Every agent-facing persona states, in order:

1. **ROLE** — who/what it is this turn.
2. **CONSTRAINTS** — what it must and must not do.
3. **OUTPUT CONTRACT** — the exact shape it returns.
4. **SEVERITY RUBRIC** — for review personas only (how to rank what it finds).

Topic/utility groups (sandbox, host-tools, context, task-list…) carry no role line — they are shared
capability prose, not a persona.

### 2. Authoring style

Build fragment text with `[...].join('\n')` (or `'\n\n'`), NOT `+`-string concatenation with leading/trailing
spaces baked into consts. Never bake a leading or trailing space into a shared const; join with explicit
separators. (Space-baked concat is what caused the double-space bug.)

### 3. DRY

Prose used by 2+ agents lives in `fragments.ts` once. A group splices the const; it does not paraphrase it.
This includes coding-agent prose that currently lives OUTSIDE `prompt-kit/` (the driver/engine/bridge task
bodies and tool descriptions) — consolidate it to a shared fragment rather than re-authoring it per site.

### 4. SOLID

One fragment = one concern. No monolith persona fragment fusing a role with 8-10 policies; decompose the tail
the way `workspace-profile.group` and the worker tail already do.

### 5. Order

Integer `order` only, in the documented per-agent bands below. No fractional orders. No `block NN` / `01a` /
`10c2` numbering comments. `order` is per-agent: two fragments may share a number only if no agent sees both
(boot validation throws on a duplicate order within one agent).

The bands as they stand today (descriptive of current reality — keep new fragments inside the right band):

| Band | Range | What lives there |
| --- | --- | --- |
| Subagent kernel | `90` | shared subagent-kernel note |
| Worker persona | `100`, `200-302`, `400-430` | worker role + orchestration tail |
| Brain identity | `1000-1001` | ATLAS_MAIN identity |
| Brain body | `1005-1160` | orientation, conversation, context, planning |
| Review persona | `1082-1090` | review-surface fragments |
| Build ceremony | `1180-1290` | plan/ship build instructions |
| Job-kind switch | `1900-1902` | the per-`jobKind` framing |
| Onboarding | `2000-2130` | onboarding bring-up persona + settings groups |
| Behavioral tail | `7990-8050` | baseline-first / spike / live-validation behavioral notes |
| Ship / autofix / meta | `9000-9110` | ship master-review, autofix, plan-review personas |

### 6. Comments

Doc comments describe CURRENT reality. No migration-scar language, no rollout-phase references ("Phase 2",
"replaces the old composer"), no `block NN` numbering. If a comment only restates what the code does, delete
it; keep a comment only for a WHY the code cannot show.

## How a change stays safe

Golden FILE snapshots (`prompt-snapshots.spec.ts` + the external-prose snapshot specs) capture the fully
assembled prompt for every `Agent`×`ctx` in the matrix and the touch-able external task-body builders. A
structural lint spec asserts the per-persona invariants above. Any change to prose surfaces as a reviewable
snapshot diff: consolidate to the canonical fragment, never free-hand rewrite meaning.
