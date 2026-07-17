import type { McpSurface } from '../persistence/entities';

export interface SystemSkillGitSource {
  url: string;
  subpath: string;
  ref: string;
}

export interface SystemSkill {
  name: string;
  description: string;
  surfaces: McpSurface[];
  git?: SystemSkillGitSource;
  reviewForTypes?: string[];
  reviewForGlobs?: string[];
}

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
      name: 'react-review-checklist',
      description:
        'React/Next.js conformance rules for reviewing frontend changes — hook dependencies, list keys, ' +
        'effect cleanup, and render-time purity. Applied by the framework-conformance review lens on ' +
        'frontend threads.',
      surfaces: ['review'],
      reviewForTypes: ['frontend'],
    },
    {
      name: 'playwright-cli',
      description: 'Automate browser interactions, test web pages and work with Playwright tests.',
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
