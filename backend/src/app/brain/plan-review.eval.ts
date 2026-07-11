import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessageLike } from '@langchain/core/messages';
import { defineModule, scorer } from '@workspace/ai-testing';
import { Agent, renderAgentPrompt, renderReviewIntent } from '../prompt-kit';
import { parsePlanFindings, type ReviewFinding } from './plan-review.service';

/**
 * REVIEWER-CALIBRATION EVAL — the "LLMs always find something" concern from the synchronous Codex
 * plan-review redesign. Codex review is MANDATORY TO RUN but ADVISORY TO PASS: Atlas is the judge, so
 * findings never block. That only works if the reviewer's signal is actually calibrated — surfacing what
 * MATTERS (BLOCKING) and staying quiet on a genuinely clean plan, never manufacturing issues because it
 * was asked to look, and never rubber-stamping a real gap either.
 *
 * SCOPE / WHAT THIS DOES NOT TEST: the real reviewer runs Codex-in-a-Docker-sandbox reading live
 * `/context/specs/` files (`PlanReviewService.review`, `redis-engine-runner.ts`) — that needs a running
 * container + Codex credentials and is validated LIVE, not in this eval. What IS shared with production
 * and therefore genuinely regression-tested here: the EXACT system prompt (`Agent.META_PLAN_REVIEW`,
 * `renderAgentPrompt`) and the EXACT output parser (`parsePlanFindings`). This eval feeds that prompt a
 * plain multi-turn chat completion (Claude standing in for Codex — the prompt's role/severity/output
 * contract is model-agnostic text, not Codex-specific) with the plan + supporting code CONTEXT INLINED
 * directly in the task (standing in for what Codex would have read from files), then grades the parsed
 * findings. This is a proxy for calibration, not an end-to-end replacement for the live-run check.
 *
 * Three fixtures, three failure modes:
 *   - `clean`      — a well-specified, gap-free plan. Assert 0 BLOCKING (the "always finds something" guard).
 *   - `planted-gap`— a plan with a real, concrete intent gap. Assert it's caught as BLOCKING (the
 *                    rubber-stamp guard — a lenient reviewer is just as useless as an over-eager one).
 *   - `resume`     — a second round where Atlas's fix genuinely resolved the prior finding. Assert the
 *                    reviewer CONCEDES (0 BLOCKING) rather than inventing a new, smaller issue to justify
 *                    another round (the anti-escalation instruction in the output contract).
 */

type In = { messages: BaseMessageLike[] };
type Out = { raw: string; findings: ReviewFinding[] };

/** Stand-in reviewer model — a capable model, not the cheap Haiku reserved for judges elsewhere in this
 *  repo's evals. Swap freely; the fixtures test the PROMPT, not this specific model's quirks. */
const MODEL = 'claude-sonnet-5';

const SYSTEM = renderAgentPrompt(Agent.META_PLAN_REVIEW);

/** Frame a fixture the same way `renderPlanForReview` does (intent → authored plan → judge), but with
 *  supporting code inlined as CONTEXT instead of a `/context/specs/` file pointer (no sandbox here). */
function renderTask(input: {
  goal: string;
  overview: string;
  plan: string;
  context: string;
}): string {
  return [
    renderReviewIntent({ goal: input.goal, overview: input.overview }),
    '',
    '<authored_plan>',
    'The plan Atlas authored, to grade.',
    '',
    input.plan,
    '</authored_plan>',
    '',
    '<context>',
    'The relevant existing code (stands in for what you would read from the repo).',
    '',
    input.context,
    '</context>',
    '',
    'Now judge per <what_to_judge> + <output_contract>.',
  ].join('\n');
}

// ── fixture: clean — a well-specified plan with no real gap ──────────────────────────────────────────

const CLEAN_CONTEXT = `
// user.entity.ts
@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() email!: string;
  @CreateDateColumn() created_at!: Date;
}

// auth.service.ts
@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string): Promise<{ token: string }> {
    const user = await this.users.findOneOrFail({ where: { email } });
    await this.verifyPassword(user, password);
    const token = this.jwt.sign({ sub: user.id });
    return { token };
  }
}

// user.dto.ts
export class UserDto {
  id!: string;
  email!: string;
  createdAt!: Date;
}

// users.controller.ts
@Get(':id')
async getUser(@Param('id') id: string): Promise<UserDto> {
  const user = await this.users.findOneOrFail({ where: { id } });
  return { id: user.id, email: user.email, createdAt: user.created_at };
}

// This repo's existing migration convention: after an entity change, run
// \`pnpm typeorm migration:generate migrations/<Name> -d data-source.ts\` and commit the generated file;
// \`pnpm db:migrate\` applies it in CI/deploy.
`.trim();

const CLEAN_PLAN = `
Thread: Backend
  user.entity.ts:1 — add "@Column({ type: 'timestamptz', nullable: true }) last_login_at!: Date | null;"
    to UserEntity, then run "pnpm typeorm migration:generate migrations/AddLastLoginAt -d data-source.ts"
    (this repo's existing convention) and commit the generated migration file.
  auth.service.ts:8 login() — after "const token = this.jwt.sign(...)", add
    "user.last_login_at = new Date(); await this.users.save(user);" before returning the token.
  user.dto.ts:2 — add "lastLoginAt!: Date | null;" to the UserDto class.
  users.controller.ts:6 getUser() — add "lastLoginAt: user.last_login_at" to the returned UserDto object.
Verify: an integration test logs in, then GETs the user and asserts lastLoginAt is a recent timestamp;
  "pnpm db:migrate" applies the new migration cleanly against the test DB.
`.trim();

// ── fixture: planted-gap — the plan overlooks a real, concrete intent gap ────────────────────────────

const GAP_CONTEXT = `
// user.entity.ts
@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() email!: string;
  @CreateDateColumn() created_at!: Date;
}

// auth.service.ts
@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string): Promise<{ token: string }> {
    const user = await this.users.findOneOrFail({ where: { email } });
    await this.verifyPassword(user, password);
    const token = this.jwt.sign({ sub: user.id });
    return { token };
  }
}

// user-cache.service.ts
// EVERY user read in this codebase goes through this cache — GET /users/:id NEVER queries Postgres
// directly. Entries are written once on creation and have a 24h TTL; nothing else ever refreshes or
// invalidates them.
@Injectable()
export class UserCacheService {
  async getUser(id: string): Promise<UserEntity> {
    const cached = await this.redis.get(\`user:\${id}\`);
    if (cached) return JSON.parse(cached);
    const user = await this.users.findOneOrFail({ where: { id } });
    await this.redis.set(\`user:\${id}\`, JSON.stringify(user), 'EX', 86_400);
    return user;
  }
}

// user.dto.ts
export class UserDto {
  id!: string;
  email!: string;
  createdAt!: Date;
}

// users.controller.ts
@Get(':id')
async getUser(@Param('id') id: string): Promise<UserDto> {
  const user = await this.userCache.getUser(id); // ALWAYS cache, never the repository directly
  return { id: user.id, email: user.email, createdAt: user.created_at };
}

// This repo's existing migration convention: after an entity change, run
// \`pnpm typeorm migration:generate migrations/<Name> -d data-source.ts\` and commit the generated file;
// \`pnpm db:migrate\` applies it in CI/deploy.
`.trim();

const GAP_PLAN = `
Thread: Backend
  user.entity.ts:1 — add "@Column({ type: 'timestamptz', nullable: true }) last_login_at!: Date | null;"
    to UserEntity, then run "pnpm typeorm migration:generate migrations/AddLastLoginAt -d data-source.ts"
    (this repo's existing convention) and commit the generated migration file.
  auth.service.ts:9 login() — after "const token = this.jwt.sign(...)", add
    "user.last_login_at = new Date(); await this.users.save(user);" before returning the token.
  user.dto.ts:2 — add "lastLoginAt!: Date | null;" to the UserDto class.
  users.controller.ts:6 getUser() — add "lastLoginAt: user.last_login_at" to the returned UserDto object
    (the controller already resolves the user via userCache.getUser(id)).
Verify: an integration test logs in, then GETs the user and asserts lastLoginAt is a recent timestamp;
  "pnpm db:migrate" applies the new migration cleanly against the test DB.
`.trim();

// ── fixture: resume — round 2 genuinely fixes round 1's finding; expect concession, not escalation ────

const RESUME_ROUND1_CONTEXT = `
// reports.controller.ts
@Controller('reports')
export class ReportsController {
  @Post('export')
  async exportEmails(@Res() res: Response): Promise<void> {
    const rows = await this.users.find();
    res.setHeader('Content-Type', 'text/csv');
    res.send(rows.map((u) => u.email).join('\\n'));
  }
}
`.trim();

const RESUME_ROUND1_PLAN = `
Thread: Backend
  Add POST /reports/export streaming a CSV of every user's email (reports.controller.ts).
Verify: hitting the endpoint returns a CSV body with one email per line.
`.trim();

const RESUME_ROUND2_CONTEXT = `
// reports.controller.ts
@Controller('reports')
export class ReportsController {
  @Post('export')
  @UseGuards(AdminGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async exportEmails(@Res() res: Response): Promise<void> {
    const rows = await this.users.find();
    res.setHeader('Content-Type', 'text/csv');
    res.send(rows.map((u) => u.email).join('\\n'));
  }
}
`.trim();

const RESUME_ROUND2_NOTE = `
I added @UseGuards(AdminGuard) so only admins can call the export endpoint, and a 5-req/min throttle.
Please re-review.
`.trim();

// ── the runnable: a plain multi-turn chat completion through the REAL system prompt ────────────────────

/** This model's `content` is a block array (thinking + text, extended-thinking style) — pull out just
 *  the text parts; `parsePlanFindings` only ever needs to see the model's final prose. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => (b as { type?: string })?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function buildRunnable() {
  // NOTE: `temperature` is deprecated/rejected on this model (400 invalid_request_error) — omit it.
  // maxTokens is generous: this model emits an extended-thinking block before its answer, and a tight
  // budget can be consumed entirely by thinking, leaving zero room for the actual FINDING/NO_FINDINGS text.
  const model = new ChatAnthropic({ model: MODEL, maxTokens: 8_000 });
  return {
    async invoke(input: In): Promise<Out> {
      const res = await model.invoke([new SystemMessage(SYSTEM), ...input.messages]);
      const raw = extractText(res.content);
      return { raw, findings: parsePlanFindings(raw) };
    },
  };
}

export default defineModule<In, Out>({
  name: 'plan-review · reviewer calibration',
  dataset: () => [
    {
      label: 'clean',
      input: {
        messages: [
          new HumanMessage(
            renderTask({
              goal: 'Show each user\'s last login time on their profile.',
              overview: 'Stamp last_login_at on successful login and expose it on GET /users/:id.',
              plan: CLEAN_PLAN,
              context: CLEAN_CONTEXT,
            }),
          ),
        ],
      },
    },
    {
      label: 'planted-gap',
      input: {
        messages: [
          new HumanMessage(
            renderTask({
              goal: 'Show each user\'s last login time on their profile.',
              overview: 'Stamp last_login_at on successful login and expose it on GET /users/:id.',
              plan: GAP_PLAN,
              context: GAP_CONTEXT,
            }),
          ),
        ],
      },
    },
    {
      label: 'resume',
      input: {
        messages: [
          new HumanMessage(
            renderTask({
              goal: 'Let admins export all user emails as a CSV.',
              overview: 'A one-off export endpoint for support/ops tooling.',
              plan: RESUME_ROUND1_PLAN,
              context: RESUME_ROUND1_CONTEXT,
            }),
          ),
          new AIMessage(
            'FINDING [BLOCKING]: the export endpoint has no auth guard — any anonymous caller can dump ' +
              'every user\'s email; there is no locked decision on which guard/role gates this endpoint ' +
              '(reports.controller.ts).',
          ),
          new HumanMessage(
            [
              '<re_review>',
              'You have reviewed this plan before (your prior findings are in this conversation). Atlas has',
              'revised the specs and/or is responding to your findings. RE-READ the current context — do NOT',
              'rely on any description of what changed. For EACH prior finding decide: genuinely RESOLVED',
              '(concede it), or does it STILL STAND. Only raise something NEW if it is as serious as a',
              'first-pass BLOCKING issue.',
              '',
              "ATLAS'S NOTE:",
              RESUME_ROUND2_NOTE,
              '</re_review>',
              '',
              '<context>',
              RESUME_ROUND2_CONTEXT,
              '</context>',
              '',
              'Now output per your <output_contract>.',
            ].join('\n'),
          ),
        ],
      },
    },
  ],
  runnable: buildRunnable,
  evaluators: [
    // Applies to every case: the reviewer must actually follow the output contract (parseable), not
    // free-form prose that produces zero structured signal either way.
    scorer<In, Out>({
      key: 'well-formed-output',
      threshold: 1,
      run: ({ output }) =>
        output.findings.length > 0 || /\bNO_FINDINGS\b/i.test(output.raw),
    }),
    // clean → the "always finds something" guard: a gap-free plan must not draw a false BLOCKING.
    scorer<In, Out>({
      key: 'no-false-blocking-on-clean-plan',
      threshold: 1,
      run: ({ label, output }) => {
        if (label !== 'clean') return undefined; // scoped to this case only
        const blocking = output.findings.filter((f) => f.severity === 'BLOCKING');
        return {
          key: 'no-false-blocking-on-clean-plan',
          grade: blocking.length === 0 ? 1 : 0,
          comment: blocking.map((f) => f.text).join(' | '),
        };
      },
    }),
    // planted-gap → the rubber-stamp guard: the real gap must be caught, and named specifically enough
    // that it's clearly THIS gap (not a coincidental unrelated nit).
    scorer<In, Out>({
      key: 'catches-planted-gap',
      threshold: 1,
      run: ({ label, output }) => {
        if (label !== 'planted-gap') return undefined;
        const blocking = output.findings.filter((f) => f.severity === 'BLOCKING');
        const caught = blocking.some((f) => /cache/i.test(f.text));
        return {
          key: 'catches-planted-gap',
          grade: caught ? 1 : 0,
          comment: blocking.map((f) => f.text).join(' | ') || '(no blocking findings)',
        };
      },
    }),
    // resume → the anti-escalation guard: a genuinely resolved finding must be conceded, not replaced by
    // a smaller invented one to justify another round.
    scorer<In, Out>({
      key: 'no-escalation-after-genuine-fix',
      threshold: 1,
      run: ({ label, output }) => {
        if (label !== 'resume') return undefined;
        const blocking = output.findings.filter((f) => f.severity === 'BLOCKING');
        return {
          key: 'no-escalation-after-genuine-fix',
          grade: blocking.length === 0 ? 1 : 0,
          comment: blocking.map((f) => f.text).join(' | '),
        };
      },
    }),
  ],
});
