import type { McpSurface } from '../persistence/entities';

/**
 * Where a GIT-SOURCED managed skill (see {@link SystemSkill.git}) is vendored from — a single skill dir,
 * NOT a marketplace manifest (`ManagedSkillSyncService` always takes the installer's single-skill path,
 * never `installMarketplace`). Mirrors `SkillInstallInput`'s git fields, minus the org/scope this global
 * tier has no use for.
 */
export interface SystemSkillGitSource {
  /** HTTPS git remote. Always cloned ANONYMOUSLY — this tier is global/org-agnostic, so there is no org
   *  whose PAT could apply; only public repos belong here. */
  url: string;
  /** Subpath within the repo to vendor — the skill dir itself (containing `SKILL.md`). */
  subpath: string;
  /** Branch/tag `ManagedSkillSyncService` tracks and re-syncs on. */
  ref: string;
}

/**
 * A built-in skill Atlas ships, code-defined like `system-mcp-registry.ts`'s `SystemMcpServer` — the BASE
 * layer composed into every turn's `<CLAUDE_CONFIG_DIR>/skills/`, under an org/repo skill of the same
 * `name` (see `SkillResolver.resolveForTurn`'s precedence merge). Two flavors, same registry:
 *   - STATIC (no `git`): its real `SKILL.md` (+ any support files) is committed at
 *     `<managedSkillsRootHost()>/<name>/` — see `system-skill-store-paths.ts`.
 *   - GIT-SOURCED (`git` present): `ManagedSkillSyncService` clones+vendors it from `git.url` into the
 *     global `_managed` store (`managedGitSkillsRootHost()`, see `skill-store-paths.ts`) and keeps it
 *     current on a leader-gated cadence — nothing is committed to this repo for it.
 */
export interface SystemSkill {
  name: string;
  description: string;
  /** Which turn surfaces this skill is active on — same shape as `WorkspaceSkillEntity.surfaces`. */
  surfaces: McpSurface[];
  /** Present → git-sourced (see above); absent → static/in-repo. */
  git?: SystemSkillGitSource;
}

/**
 * The system-tier (Atlas-managed) skills. A PURE function (unit-testable with no DI, like
 * `buildSystemMcpServers`) — resolved per turn by `SkillResolver.resolveForTurn` and, for display, by
 * `SystemSkillResolver`. Being pure, a `git` entry lists REGARDLESS of whether `ManagedSkillSyncService`
 * has actually vendored it yet — the compose step (`engine-core.ts`) already skips a skill whose dir isn't
 * on disk, and `SystemSkillResolver` marks an unsynced git entry `synced: false` for the console.
 *
 * To add a STATIC one: create `backend/skills-managed/<name>/SKILL.md` (+ any `references/`/`scripts/` it
 * needs), then add `{ name, description, surfaces }` below (`description` should match the frontmatter).
 * To add a GIT-SOURCED one: add `{ name, description, surfaces, git: { url, subpath, ref } }` — no repo
 * file needed, `ManagedSkillSyncService` vendors it on boot + its reconcile cadence.
 */
export function buildSystemSkills(): SystemSkill[] {
  return [
    {
      name: 'empty-states',
      description:
        'Design empty, error, and loading states that teach and guide instead of showing a blank screen. ' +
        'Use whenever building or reviewing any list, table, grid, detail pane, tab, kanban, calendar, ' +
        'search result, feed, inbox, or dashboard that can render with no data — or when the user mentions ' +
        '"empty state," "no data," "zero results," "no results found," "nothing here," "first run," ' +
        '"blank screen," "error state," "loading state," "skeleton," or onboarding for a feature\'s first use.',
      surfaces: ['brain', 'build'],
    },
    {
      name: 'design-patterns',
      description:
        'Recognize code smells and apply the RIGHT design pattern with restraint — boring refactoring first, a ' +
        'named Gang-of-Four pattern only when it earns its keep. Use whenever writing or refactoring non-trivial ' +
        'code, when you are fighting the existing structure to add a feature, or when you notice duplication, a ' +
        'giant class/function, tangled conditionals, shotgun-surgery edits, feature envy, or a data/behavior ' +
        'mismatch — or when the user mentions "design pattern," "refactor," "code smell," "clean this up," "too ' +
        'complex," "over-engineered," Strategy, Factory, Observer, Adapter, Decorator, State, Command, or any GoF ' +
        'pattern by name.',
      surfaces: ['brain', 'build', 'review'],
    },
    {
      name: 'playwright-cli',
      description:
        'Automate browser interactions, test web pages and work with Playwright tests.',
      surfaces: ['build'],
      git: {
        url: 'https://github.com/microsoft/playwright-cli',
        subpath: 'skills/playwright-cli',
        ref: 'main',
      },
    },
    {
      name: 'web-state-redux-toolkit',
      description:
        'Redux Toolkit patterns for complex client state. Use when managing enterprise-scale state, ' +
        'needing DevTools, entity normalization, or RTK Query for data fetching.',
      surfaces: ['build'],
      git: {
        url: 'https://github.com/agents-inc/skills',
        subpath: 'src/skills/web-state-redux-toolkit',
        ref: 'main',
      },
    },
    {
      name: 'the-fool',
      description:
        'Use when challenging ideas, plans, decisions, or proposals using structured critical ' +
        "reasoning. Invoke to play devil's advocate, run a pre-mortem, red team, or audit evidence " +
        'and assumptions.',
      surfaces: ['brain', 'build'],
      git: {
        url: 'https://github.com/Jeffallan/claude-skills',
        subpath: 'skills/the-fool',
        ref: 'main',
      },
    },
  ];
}
