import type { Seeder } from '@workspace/nestjs-core';
import { EmployeeSkill } from '@workspace/shared/schemas';
import { IsNull } from 'typeorm';

/**
 * Seeds DB-controlled employee SKILL grants (the GLOBAL tier — `team_id IS NULL`) so `db:seed` gives
 * a repeatable, role-based baseline of skills without hand-editing rows. The harness provisioner picks
 * the rows up reactively (DB-trigger NOTIFY) and materializes each employee's per-engine home.
 *
 * This list is SKILL-CENTRIC: each skill is declared once with the set of employees who get it
 * (overlap is intentional and justified inline). It is also AUTHORITATIVE for the global tier — after
 * upserting every row below, any other `team_id IS NULL` skill row NOT in this list is pruned, so the
 * seed fully describes the global baseline. Per-team overrides (`team_id` non-null) are left alone.
 *
 * Provenance for the `git` sources is Dennis's skill lockfile (`~/.agents/.skill-lock.json`):
 * `subPath` is the directory holding the skill's SKILL.md. `local` sources point at skills vendored
 * into the repo's top-level `skills/<name>` (repo-root-relative, resolved against the git root).
 */

// One const per source repo (a single shallow clone is shared across all its skills).
const MARKETING = 'https://github.com/coreyhaines31/marketingskills.git';
const CKM = 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git';
const MATTP = 'https://github.com/mattpocock/skills.git';
const NEXT = 'https://github.com/vercel-labs/next-skills.git';
const VERCEL = 'https://github.com/vercel-labs/skills.git';
const NESTJS = 'https://github.com/Kadajett/agent-nestjs-skills.git';
const SHADCN = 'https://github.com/shadcn/ui.git';
const DOTENV = 'https://github.com/motdotla/dotenv.git';
const REMOTION = 'https://github.com/remotion-dev/skills.git';
const CTXENG =
  'https://github.com/muratcankoylan/agent-skills-for-context-engineering.git';
const STOPSLOP = 'https://github.com/hardikpandya/stop-slop.git';
const CCC = 'https://github.com/cocoindex-io/cocoindex-code.git';

const git = (url: string, subPath?: string): Record<string, unknown> => ({
  kind: 'git',
  url,
  ...(subPath ? { subPath } : {}),
});
const local = (name: string): Record<string, unknown> => ({
  kind: 'local',
  path: `skills/${name}`,
});

// Roster ids.
const ALEX = 'alex';
const RILEY = 'riley';
const MAYA = 'maya';
const JAMES = 'james';
const NORA = 'nora';
const SAM = 'sam';
const ALL = [ALEX, RILEY, MAYA, JAMES, NORA, SAM];

interface SkillDef {
  /** Canonical SKILL.md frontmatter name — the provisioner dedupes loaded skills on it. */
  name: string;
  /** Short row label (the loader re-reads the real description from SKILL.md at load time). */
  description: string;
  source: Record<string, unknown>;
  /** Every employee who gets this skill — overlap allowed, justified by the role split. */
  employees: string[];
}

// Helper for the many James-only marketing skills (all from MARKETING, subPath skills/<name>).
const jamesMarketing = (name: string, description: string): SkillDef => ({
  name,
  description,
  source: git(MARKETING, `skills/${name}`),
  employees: [JAMES],
});

const SKILLS: SkillDef[] = [
  // ── Marketing & analytics — James owns the funnel; growth-UX & research shared by role ──────────
  jamesMarketing('ad-creative', 'Generate and iterate ad creative at scale.'),
  jamesMarketing('ads', 'Plan and optimize paid advertising campaigns.'),
  jamesMarketing('ai-seo', 'Optimize content to be cited by AI search engines.'),
  jamesMarketing('aso', 'App Store / Play listing optimization.'),
  jamesMarketing('co-marketing', 'Find partners and plan joint campaigns.'),
  jamesMarketing('cold-email', 'Write B2B cold outreach and follow-up sequences.'),
  jamesMarketing('community-marketing', 'Build and leverage online communities.'),
  jamesMarketing('competitors', 'Build competitor comparison / alternative pages.'),
  jamesMarketing('content-strategy', 'Plan what content to create and why.'),
  jamesMarketing('copy-editing', 'Edit and refresh existing marketing copy.'),
  jamesMarketing('copywriting', 'Write and improve marketing page copy.'),
  jamesMarketing('directory-submissions', 'Submit to relevant directories for SEO/links.'),
  jamesMarketing('emails', 'Lifecycle and warm email sequences.'),
  jamesMarketing('free-tools', 'Plan free-tool lead magnets for acquisition.'),
  jamesMarketing('lead-magnets', 'Design lead magnets that convert.'),
  jamesMarketing('marketing-ideas', 'Brainstorm marketing channels and tactics.'),
  jamesMarketing('pricing', 'Pricing strategy and page design.'),
  jamesMarketing('product-marketing', 'Positioning, launches, and messaging.'),
  jamesMarketing('programmatic-seo', 'Scale SEO pages programmatically.'),
  jamesMarketing('prospecting', 'Find and qualify outbound prospects.'),
  jamesMarketing('referrals', 'Design customer referral programs.'),
  jamesMarketing('revops', 'Revenue operations and funnel mechanics.'),
  jamesMarketing('sales-enablement', 'Battle cards and sales collateral.'),
  jamesMarketing('seo-audit', 'Technical and on-page SEO audits.'),
  jamesMarketing('sms', 'SMS lifecycle messaging.'),
  jamesMarketing('social', 'Social media content and strategy.'),
  jamesMarketing('video', 'Marketing video strategy and scripting.'),

  // Shared marketing skills (each overlap justified).
  {
    name: 'ab-testing',
    description: 'Design and run A/B tests and experiments.',
    source: git(MARKETING, 'skills/ab-testing'),
    employees: [JAMES, RILEY], // designs experiments / implements variants
  },
  {
    name: 'analytics',
    description: 'Set up and audit analytics tracking.',
    source: git(MARKETING, 'skills/analytics'),
    employees: [JAMES, RILEY], // measurement plan / frontend instrumentation
  },
  {
    name: 'schema',
    description: 'Structured-data / schema markup for SEO.',
    source: git(MARKETING, 'skills/schema'),
    employees: [JAMES, RILEY], // SEO markup / frontend implementation
  },
  {
    name: 'cro',
    description: 'Conversion-rate optimization for pages and forms.',
    source: git(MARKETING, 'skills/cro'),
    employees: [JAMES, MAYA], // conversion / flow & UX
  },
  {
    name: 'onboarding',
    description: 'Post-signup activation and onboarding flows.',
    source: git(MARKETING, 'skills/onboarding'),
    employees: [JAMES, MAYA], // activation / UX flows
  },
  {
    name: 'signup',
    description: 'Signup / registration flow optimization.',
    source: git(MARKETING, 'skills/signup'),
    employees: [JAMES, MAYA], // funnel / UX flows
  },
  {
    name: 'paywalls',
    description: 'In-app upgrade paywalls.',
    source: git(MARKETING, 'skills/paywalls'),
    employees: [JAMES, MAYA], // monetization / UX flows
  },
  {
    name: 'popups',
    description: 'Popups and modals that convert.',
    source: git(MARKETING, 'skills/popups'),
    employees: [JAMES, MAYA], // capture / UX flows
  },
  {
    name: 'churn-prevention',
    description: 'Reduce churn with retention and save flows.',
    source: git(MARKETING, 'skills/churn-prevention'),
    employees: [JAMES, MAYA], // retention strategy / UX flows
  },
  {
    name: 'site-architecture',
    description: 'Information architecture for SEO and UX.',
    source: git(MARKETING, 'skills/site-architecture'),
    employees: [JAMES, MAYA], // SEO IA / design IA
  },
  {
    name: 'marketing-psychology',
    description: 'Persuasion principles for copy and UX.',
    source: git(MARKETING, 'skills/marketing-psychology'),
    employees: [JAMES, MAYA], // persuasive copy / persuasive UX
  },
  {
    name: 'image',
    description: 'Generate marketing/visual images.',
    source: git(MARKETING, 'skills/image'),
    employees: [JAMES, MAYA], // ad creative / visual design
  },
  {
    name: 'launch',
    description: 'Plan and coordinate product launches.',
    source: git(MARKETING, 'skills/launch'),
    employees: [JAMES, SAM], // GTM / release coordination
  },
  {
    name: 'competitor-profiling',
    description: 'Research and profile competitors from URLs.',
    source: git(MARKETING, 'skills/competitor-profiling'),
    employees: [NORA, JAMES], // research / marketing insight
  },
  {
    name: 'customer-research',
    description: 'Conduct and synthesize customer research.',
    source: git(MARKETING, 'skills/customer-research'),
    employees: [NORA, JAMES], // research / marketing insight
  },

  // ── Design & UX — Maya owns design; styling/tokens shared with Riley; assets with James ─────────
  {
    name: 'ui-ux-pro-max',
    description: 'Comprehensive UI/UX design guidance.',
    source: git(CKM, '.claude/skills/ui-ux-pro-max'),
    employees: [MAYA, RILEY],
  },
  {
    name: 'ckm:design',
    description: 'Brand identity, design tokens, logos, CIP.',
    source: git(CKM, '.claude/skills/design'),
    employees: [MAYA],
  },
  {
    name: 'ckm:design-system',
    description: 'Token architecture and component specs.',
    source: git(CKM, '.claude/skills/design-system'),
    employees: [MAYA, RILEY], // tokens consumed in frontend
  },
  {
    name: 'ckm:brand',
    description: 'Brand voice, visual identity, messaging.',
    source: git(CKM, '.claude/skills/brand'),
    employees: [MAYA],
  },
  {
    name: 'ckm:banner-design',
    description: 'Banners for social/ads/web/print.',
    source: git(CKM, '.claude/skills/banner-design'),
    employees: [MAYA, JAMES], // visual design / ad assets
  },
  {
    name: 'ckm:slides',
    description: 'Strategic HTML presentations.',
    source: git(CKM, '.claude/skills/slides'),
    employees: [MAYA, JAMES], // design decks / marketing decks
  },
  {
    name: 'ckm:ui-styling',
    description: 'shadcn/Tailwind UI styling.',
    source: git(CKM, '.claude/skills/ui-styling'),
    employees: [RILEY, MAYA], // implementation / design
  },

  // ── Frontend & engineering ─────────────────────────────────────────────────────────────────────
  {
    name: 'next-best-practices',
    description: 'Next.js conventions and patterns.',
    source: git(NEXT, 'skills/next-best-practices'),
    employees: [RILEY],
  },
  {
    name: 'shadcn',
    description: 'shadcn/ui component usage.',
    source: git(SHADCN, 'skills/shadcn'),
    employees: [RILEY],
  },
  {
    name: 'remotion-best-practices',
    description: 'Video creation in React (Remotion).',
    source: git(REMOTION, 'skills/remotion'),
    employees: [RILEY, JAMES], // builds video / directs video
  },
  {
    name: 'nestjs-best-practices',
    description: 'NestJS architecture and patterns.',
    source: git(NESTJS),
    employees: [ALEX],
  },
  {
    name: 'dotenvx',
    description: 'dotenvx config and encrypted .env workflows.',
    source: git(DOTENV, 'skills/dotenvx'),
    employees: [ALEX, RILEY], // NestJS + Next env
  },
  {
    name: 'ccc',
    description: 'Codebase code search / indexing.',
    source: git(CCC, 'skills/ccc'),
    employees: [ALEX, RILEY, SAM], // builders + reviewer
  },

  // ── Planning & meta ────────────────────────────────────────────────────────────────────────────
  {
    name: 'grill-me',
    description: 'Stress-test a plan or design via interview.',
    source: git(MATTP, 'skills/productivity/grill-me'),
    employees: ALL, // everyone plans; stress-test plans
  },
  {
    name: 'grill-with-docs',
    description: 'Stress-test a plan against the domain model + docs.',
    source: git(MATTP, 'skills/engineering/grill-with-docs'),
    employees: [ALEX, RILEY, MAYA, SAM], // domain/doc rigor
  },
  {
    name: 'find-skills',
    description: 'Discover skills from registries.',
    source: git(VERCEL, 'skills/find-skills'),
    employees: [SAM], // curates team capabilities
  },
  {
    name: 'context-engineering-collection',
    description: 'Context/harness engineering for agent systems.',
    source: git(CTXENG),
    employees: [SAM, ALEX], // orchestration / harness work
  },
  {
    name: 'stop-slop',
    description: 'Remove AI writing tells from prose.',
    source: git(STOPSLOP),
    employees: ALL, // everyone writes chat/PR/doc prose
  },

  // ── Repo-local & vendored personal skills ──────────────────────────────────────────────────────
  {
    name: 'code-review',
    description: 'Review a diff for correctness before shipping.',
    source: local('code-review'),
    employees: [ALEX, RILEY, MAYA, SAM], // self-review ICs + lead review
  },
  {
    name: 'env-conventions',
    description: 'House style for env vars across NestJS + Next.js repos.',
    source: local('env-conventions'),
    employees: [ALEX, RILEY],
  },
  {
    name: 'dotenv-vault-migration',
    description: 'Migrate dotenv-vault → dotenvx.',
    source: local('dotenv-vault-migration'),
    employees: [ALEX, RILEY],
  },
  {
    name: 'langfuse',
    description: 'Langfuse tracing/observability via CLI + docs.',
    source: local('langfuse'),
    employees: [ALEX, JAMES], // backend instrumentation / analytics
  },
  {
    name: 'web-state-redux-toolkit',
    description: 'Redux Toolkit patterns for complex client state.',
    source: local('web-state-redux-toolkit'),
    employees: [RILEY],
  },
  {
    name: 'empty-states',
    description: 'Design empty/error/loading states.',
    source: local('empty-states'),
    employees: [MAYA, RILEY], // design / implement
  },
  {
    name: 'playwright-cli',
    description: 'Browser automation and Playwright tests.',
    source: local('playwright-cli'),
    employees: [RILEY, ALEX], // frontend / e2e testing
  },
  {
    name: 'ios-simulator',
    description: 'Drive the iOS simulator (screenshot/deep-link).',
    source: local('ios-simulator'),
    employees: [RILEY],
  },
];

export default (async (ds) => {
  const repo = ds.getRepository(EmployeeSkill);
  const key = (employee_id: string, name: string) => `${employee_id} ${name}`;
  const desired = new Set(
    SKILLS.flatMap((s) => s.employees.map((e) => key(e, s.name))),
  );

  for (const s of SKILLS) {
    for (const employee_id of s.employees) {
      const existing = await repo.findOne({
        where: { employee_id, name: s.name, team_id: IsNull() },
      });
      if (existing) {
        existing.description = s.description;
        existing.source = s.source;
        await repo.save(existing);
      } else {
        await repo.save(
          repo.create({
            employee_id,
            team_id: null,
            name: s.name,
            description: s.description,
            source: s.source,
          }),
        );
      }
      console.log(`  ✓ skill ${employee_id}/${s.name}`);
    }
  }

  // Authoritative prune: drop GLOBAL-tier rows no longer in the mapping (per-team overrides kept).
  const globals = await repo.find({ where: { team_id: IsNull() } });
  const stale = globals.filter((r) => !desired.has(key(r.employee_id, r.name)));
  if (stale.length) {
    await repo.remove(stale);
    stale.forEach((r) => console.log(`  ✗ pruned ${r.employee_id}/${r.name}`));
  }

  console.log(`  employee skill seeds: ${desired.size} grant(s) across roster`);
}) satisfies Seeder;
