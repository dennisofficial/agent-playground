# Atlas-managed (system-tier) skills

This is the on-disk home for Atlas's own STATIC built-in skills — the read-only tier shown above
Organization/Repository in the console's Skills page, mirroring the System tier of MCP servers.

Unlike the Organization/Repository tiers (`workspace_skills` DB rows, installed/authored per org),
these are **code-defined**: a fixed dir here, one `<name>/SKILL.md` per skill, listed in
`backend/src/app/skills/system-skill-registry.ts`'s `buildSystemSkills()`.

There's a SECOND managed flavor with no dir here: a `git`-sourced entry in the same registry (e.g.
`playwright-cli`) has no `SKILL.md` committed to this repo at all — `ManagedSkillSyncService` clones +
vendors it from its own upstream repo into a global `_managed` store under `SKILLS_ROOT` instead, kept
current on a leader-gated cadence. Both flavors compose into a turn identically (same registry, same
`SkillResolver` base layer) — only where the content physically lives differs.

## Why this location

This dir is a sibling of `backend/sandbox/` (the sandbox image build context), not under `src/app/` —
that keeps it identical in dev (ts-node) and a built `dist` deploy with no `nest-cli` asset-copy config
(see `bundle-engine.ts`'s `sandboxContextDir` for the same trick). `SandboxManager` bind-mounts this
whole dir read-only into every sandbox at `CONTAINER_SKILLS_MANAGED` (`/skills-managed`); the per-turn
skills-compose step (`engine-core.ts`) symlinks each managed skill from there into
`<CLAUDE_CONFIG_DIR>/skills/`, same as an org/repo skill but from a different root.

## Adding one

1. Create `backend/skills-managed/<name>/SKILL.md` (frontmatter `name`/`description`, then the body —
   plus any `references/`/`scripts/` the skill needs, same shape as an installed/custom skill).
2. Add `{ name, description, surfaces }` to the array in `system-skill-registry.ts`'s
   `buildSystemSkills()` — `description` should match the `SKILL.md` frontmatter.

An org/repo skill of the same `name` overrides a managed one (see `SkillResolver.resolveForTurn`) — a
managed skill is the BASE layer, never the last word.
