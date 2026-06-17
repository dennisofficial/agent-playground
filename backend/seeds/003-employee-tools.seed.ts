import type { Seeder } from '@workspace/nestjs-core';
import { EmployeeSkill } from '@workspace/shared/schemas';
import { IsNull } from 'typeorm';

/**
 * Seeds DB-controlled employee SKILL grants (the GLOBAL tier — `team_id IS NULL`) so `db:seed` gives
 * a repeatable, role-based baseline of skills without hand-editing rows. The harness provisioner picks
 * the rows up reactively (DB-trigger NOTIFY) and materializes each employee's per-engine home.
 *
 * Grants are keyed on ROLE ids, not names: the build work runs as pipeline SECTIONS, each a phase-config
 * (`phase_backend`/`phase_frontend`/`phase_design`/`phase_research`/`phase_marketing`/`phase_analytics`),
 * plus `atlas` (the orchestrator) for planning/meta skills. The old named specialists (alex/riley/…/sam)
 * are gone; the grant path is id-generic, so the same skill-centric list just targets the role ids.
 *
 * This list is SKILL-CENTRIC: each skill is declared once with the set of roles who get it (overlap is
 * intentional and justified inline). It is also AUTHORITATIVE for the global tier — after upserting every
 * row below, any other `team_id IS NULL` skill row NOT in this list is pruned, so the seed fully describes
 * the global baseline. Per-team overrides (`team_id` non-null) are left alone.
 *
 * Provenance for the `git` sources is Dennis's skill lockfile (`~/.agents/.skill-lock.json`):
 * `subPath` is the directory holding the skill's SKILL.md. `local` sources point at skills vendored
 * into the repo's top-level `skills/<name>` (repo-root-relative, resolved against the git root).
 */

// One const per source repo (a single shallow clone is shared across all its skills).
const MARKETING_REPO = 'https://github.com/coreyhaines31/marketingskills.git';
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

// Role ids: the pipeline phase-configs + the orchestrator. These ARE the grant targets.
const BACKEND = 'phase_backend';
const FRONTEND = 'phase_frontend';
const DESIGN = 'phase_design';
const RESEARCH = 'phase_research';
const MARKETING = 'phase_marketing';
const ANALYTICS = 'phase_analytics';
const ATLAS = 'atlas';
const ALL = [BACKEND, FRONTEND, DESIGN, RESEARCH, MARKETING, ANALYTICS, ATLAS];

interface SkillDef {
  /** Canonical SKILL.md frontmatter name — the provisioner dedupes loaded skills on it. */
  name: string;
  /** Short row label (the loader re-reads the real description from SKILL.md at load time). */
  description: string;
  source: Record<string, unknown>;
  /** Every role who gets this skill — overlap allowed, justified by the role split. */
  employees: string[];
}

// Helper for the many marketing skills (all from MARKETING_REPO, subPath skills/<name>).
const mktg = (name: string, description: string): SkillDef => ({
  name,
  description,
  source: git(MARKETING_REPO, `skills/${name}`),
  employees: [MARKETING],
});

const SKILLS: SkillDef[] = [
  // ── Marketing — the marketing section owns positioning/funnel/GTM ────────────────────────────────
  mktg('ad-creative', 'Generate and iterate ad creative at scale.'),
  mktg('ads', 'Plan and optimize paid advertising campaigns.'),
  mktg('ai-seo', 'Optimize content to be cited by AI search engines.'),
  mktg('aso', 'App Store / Play listing optimization.'),
  mktg('co-marketing', 'Find partners and plan joint campaigns.'),
  mktg('cold-email', 'Write B2B cold outreach and follow-up sequences.'),
  mktg('community-marketing', 'Build and leverage online communities.'),
  mktg('competitors', 'Build competitor comparison / alternative pages.'),
  mktg('content-strategy', 'Plan what content to create and why.'),
  mktg('copy-editing', 'Edit and refresh existing marketing copy.'),
  mktg('copywriting', 'Write and improve marketing page copy.'),
  mktg('directory-submissions', 'Submit to relevant directories for SEO/links.'),
  mktg('emails', 'Lifecycle and warm email sequences.'),
  mktg('free-tools', 'Plan free-tool lead magnets for acquisition.'),
  mktg('lead-magnets', 'Design lead magnets that convert.'),
  mktg('marketing-ideas', 'Brainstorm marketing channels and tactics.'),
  mktg('pricing', 'Pricing strategy and page design.'),
  mktg('product-marketing', 'Positioning, launches, and messaging.'),
  mktg('programmatic-seo', 'Scale SEO pages programmatically.'),
  mktg('prospecting', 'Find and qualify outbound prospects.'),
  mktg('referrals', 'Design customer referral programs.'),
  mktg('sales-enablement', 'Battle cards and sales collateral.'),
  mktg('seo-audit', 'Technical and on-page SEO audits.'),
  mktg('sms', 'SMS lifecycle messaging.'),
  mktg('social', 'Social media content and strategy.'),
  mktg('video', 'Marketing video strategy and scripting.'),

  // ── Analytics & measurement — the analytics section owns instrumentation/measurement ─────────────
  {
    name: 'analytics',
    description: 'Set up and audit analytics tracking.',
    source: git(MARKETING_REPO, 'skills/analytics'),
    employees: [ANALYTICS, FRONTEND], // measurement plan / frontend instrumentation
  },
  {
    name: 'ab-testing',
    description: 'Design and run A/B tests and experiments.',
    source: git(MARKETING_REPO, 'skills/ab-testing'),
    employees: [ANALYTICS, FRONTEND], // designs experiments / implements variants
  },
  {
    name: 'revops',
    description: 'Revenue operations and funnel mechanics.',
    source: git(MARKETING_REPO, 'skills/revops'),
    employees: [ANALYTICS], // funnel measurement / ops
  },

  // ── Conversion & funnel — shared between marketing (strategy) and design (flows) ─────────────────
  {
    name: 'schema',
    description: 'Structured-data / schema markup for SEO.',
    source: git(MARKETING_REPO, 'skills/schema'),
    employees: [MARKETING, FRONTEND], // SEO markup / frontend implementation
  },
  {
    name: 'cro',
    description: 'Conversion-rate optimization for pages and forms.',
    source: git(MARKETING_REPO, 'skills/cro'),
    employees: [MARKETING, DESIGN], // conversion / flow & UX
  },
  {
    name: 'onboarding',
    description: 'Post-signup activation and onboarding flows.',
    source: git(MARKETING_REPO, 'skills/onboarding'),
    employees: [MARKETING, DESIGN], // activation / UX flows
  },
  {
    name: 'signup',
    description: 'Signup / registration flow optimization.',
    source: git(MARKETING_REPO, 'skills/signup'),
    employees: [MARKETING, DESIGN], // funnel / UX flows
  },
  {
    name: 'paywalls',
    description: 'In-app upgrade paywalls.',
    source: git(MARKETING_REPO, 'skills/paywalls'),
    employees: [MARKETING, DESIGN], // monetization / UX flows
  },
  {
    name: 'popups',
    description: 'Popups and modals that convert.',
    source: git(MARKETING_REPO, 'skills/popups'),
    employees: [MARKETING, DESIGN], // capture / UX flows
  },
  {
    name: 'churn-prevention',
    description: 'Reduce churn with retention and save flows.',
    source: git(MARKETING_REPO, 'skills/churn-prevention'),
    employees: [MARKETING, DESIGN], // retention strategy / UX flows
  },
  {
    name: 'site-architecture',
    description: 'Information architecture for SEO and UX.',
    source: git(MARKETING_REPO, 'skills/site-architecture'),
    employees: [MARKETING, DESIGN], // SEO IA / design IA
  },
  {
    name: 'marketing-psychology',
    description: 'Persuasion principles for copy and UX.',
    source: git(MARKETING_REPO, 'skills/marketing-psychology'),
    employees: [MARKETING, DESIGN], // persuasive copy / persuasive UX
  },
  {
    name: 'image',
    description: 'Generate marketing/visual images.',
    source: git(MARKETING_REPO, 'skills/image'),
    employees: [MARKETING, DESIGN], // ad creative / visual design
  },
  {
    name: 'launch',
    description: 'Plan and coordinate product launches.',
    source: git(MARKETING_REPO, 'skills/launch'),
    employees: [MARKETING, ATLAS], // GTM / release coordination
  },
  {
    name: 'competitor-profiling',
    description: 'Research and profile competitors from URLs.',
    source: git(MARKETING_REPO, 'skills/competitor-profiling'),
    employees: [RESEARCH, MARKETING], // research / marketing insight
  },
  {
    name: 'customer-research',
    description: 'Conduct and synthesize customer research.',
    source: git(MARKETING_REPO, 'skills/customer-research'),
    employees: [RESEARCH, MARKETING], // research / marketing insight
  },

  // ── Design & UX — the design section owns design; styling/tokens shared with frontend ────────────
  {
    name: 'ui-ux-pro-max',
    description: 'Comprehensive UI/UX design guidance.',
    source: git(CKM, '.claude/skills/ui-ux-pro-max'),
    employees: [DESIGN, FRONTEND],
  },
  {
    name: 'ckm:design',
    description: 'Brand identity, design tokens, logos, CIP.',
    source: git(CKM, '.claude/skills/design'),
    employees: [DESIGN],
  },
  {
    name: 'ckm:design-system',
    description: 'Token architecture and component specs.',
    source: git(CKM, '.claude/skills/design-system'),
    employees: [DESIGN, FRONTEND], // tokens consumed in frontend
  },
  {
    name: 'ckm:brand',
    description: 'Brand voice, visual identity, messaging.',
    source: git(CKM, '.claude/skills/brand'),
    employees: [DESIGN],
  },
  {
    name: 'ckm:banner-design',
    description: 'Banners for social/ads/web/print.',
    source: git(CKM, '.claude/skills/banner-design'),
    employees: [DESIGN, MARKETING], // visual design / ad assets
  },
  {
    name: 'ckm:slides',
    description: 'Strategic HTML presentations.',
    source: git(CKM, '.claude/skills/slides'),
    employees: [DESIGN, MARKETING], // design decks / marketing decks
  },
  {
    name: 'ckm:ui-styling',
    description: 'shadcn/Tailwind UI styling.',
    source: git(CKM, '.claude/skills/ui-styling'),
    employees: [FRONTEND, DESIGN], // implementation / design
  },

  // ── Frontend & engineering ─────────────────────────────────────────────────────────────────────
  {
    name: 'next-best-practices',
    description: 'Next.js conventions and patterns.',
    source: git(NEXT, 'skills/next-best-practices'),
    employees: [FRONTEND],
  },
  {
    name: 'shadcn',
    description: 'shadcn/ui component usage.',
    source: git(SHADCN, 'skills/shadcn'),
    employees: [FRONTEND],
  },
  {
    name: 'remotion-best-practices',
    description: 'Video creation in React (Remotion).',
    source: git(REMOTION, 'skills/remotion'),
    employees: [FRONTEND, MARKETING], // builds video / directs video
  },
  {
    name: 'nestjs-best-practices',
    description: 'NestJS architecture and patterns.',
    source: git(NESTJS),
    employees: [BACKEND],
  },
  {
    name: 'dotenvx',
    description: 'dotenvx config and encrypted .env workflows.',
    source: git(DOTENV, 'skills/dotenvx'),
    employees: [BACKEND, FRONTEND], // NestJS + Next env
  },
  {
    name: 'ccc',
    description: 'Codebase code search / indexing.',
    source: git(CCC, 'skills/ccc'),
    employees: [BACKEND, FRONTEND, ATLAS], // builders + orchestrator
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
    employees: [BACKEND, FRONTEND, DESIGN, ATLAS], // domain/doc rigor
  },
  {
    name: 'find-skills',
    description: 'Discover skills from registries.',
    source: git(VERCEL, 'skills/find-skills'),
    employees: [ATLAS], // curates team capabilities
  },
  {
    name: 'context-engineering-collection',
    description: 'Context/harness engineering for agent systems.',
    source: git(CTXENG),
    employees: [ATLAS, BACKEND], // orchestration / harness work
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
    employees: [BACKEND, FRONTEND, DESIGN, ATLAS], // self-review sections + orchestrator
  },
  {
    name: 'env-conventions',
    description: 'House style for env vars across NestJS + Next.js repos.',
    source: local('env-conventions'),
    employees: [BACKEND, FRONTEND],
  },
  {
    name: 'dotenv-vault-migration',
    description: 'Migrate dotenv-vault → dotenvx.',
    source: local('dotenv-vault-migration'),
    employees: [BACKEND, FRONTEND],
  },
  {
    name: 'langfuse',
    description: 'Langfuse tracing/observability via CLI + docs.',
    source: local('langfuse'),
    employees: [BACKEND, ANALYTICS], // backend instrumentation / analytics
  },
  {
    name: 'web-state-redux-toolkit',
    description: 'Redux Toolkit patterns for complex client state.',
    source: local('web-state-redux-toolkit'),
    employees: [FRONTEND],
  },
  {
    name: 'empty-states',
    description: 'Design empty/error/loading states.',
    source: local('empty-states'),
    employees: [DESIGN, FRONTEND], // design / implement
  },
  {
    name: 'playwright-cli',
    description: 'Browser automation and Playwright tests.',
    source: local('playwright-cli'),
    employees: [FRONTEND, BACKEND], // frontend / e2e testing
  },
  {
    name: 'ios-simulator',
    description: 'Drive the iOS simulator (screenshot/deep-link).',
    source: local('ios-simulator'),
    employees: [FRONTEND],
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
