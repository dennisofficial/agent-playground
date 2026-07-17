import { ChatAnthropic } from '@langchain/anthropic';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessageLike,
} from '@langchain/core/messages';
import { defineModule, scorer } from '@workspace/ai-testing';
import { Agent, renderAgentPrompt, renderReviewIntent } from '../prompt-kit';
import { parsePlanFindings, type ReviewFinding } from './plan-review.service';


type In = { messages: BaseMessageLike[] };
type Out = { raw: string; findings: ReviewFinding[] };

const MODEL = 'claude-sonnet-5';

const SYSTEM = renderAgentPrompt(Agent.META_PLAN_REVIEW);

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


const CLEAN_CONTEXT = `
@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() email!: string;
  @CreateDateColumn() created_at!: Date;
}

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

export class UserDto {
  id!: string;
  email!: string;
  createdAt!: Date;
}

@Get(':id')
async getUser(@Param('id') id: string): Promise<UserDto> {
  const user = await this.users.findOneOrFail({ where: { id } });
  return { id: user.id, email: user.email, createdAt: user.created_at };
}

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


const GAP_CONTEXT = `
@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() email!: string;
  @CreateDateColumn() created_at!: Date;
}

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

export class UserDto {
  id!: string;
  email!: string;
  createdAt!: Date;
}

@Get(':id')
async getUser(@Param('id') id: string): Promise<UserDto> {
  const user = await this.userCache.getUser(id); // ALWAYS cache, never the repository directly
  return { id: user.id, email: user.email, createdAt: user.created_at };
}

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


const RESUME_ROUND1_CONTEXT = `
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


function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => (b as { type?: string })?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function buildRunnable() {
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
              goal: "Show each user's last login time on their profile.",
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
              goal: "Show each user's last login time on their profile.",
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
              "every user's email; there is no locked decision on which guard/role gates this endpoint " +
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
    scorer<In, Out>({
      key: 'well-formed-output',
      threshold: 1,
      run: ({ output }) => output.findings.length > 0 || /\bNO_FINDINGS\b/i.test(output.raw),
    }),
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
