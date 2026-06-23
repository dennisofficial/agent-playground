<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Local development setup

Shared dev config — local Postgres creds, the Slack ears tokens, the puppet + tenant seeds,
`SECRETS_ENCRYPTION_KEY`, `ADMIN_API_TOKEN`, `APPROVAL_BOSS_USER_ID` — lives **encrypted** in the
committed `backend/.env.local.enc`. The only thing not in the repo is the private key that
decrypts it. So onboarding a new teammate is:

```bash
# 1. Initialize git submodules — required before pnpm install.
#    packages/nestjs-ai-essentials (provides @workspace/langfuse) and packages/jwt-auth
#    (provides @workspace/auth) are git submodules; pnpm can't link them until they exist.
#    Either clone with: git clone --recurse-submodules <url>
#    Or, on an existing clone: git submodule update --init --recursive
#    Or, use the convenience script from the repo root: pnpm run setup
# 2. Get backend/.env.keys (DOTENV_PRIVATE_KEY_LOCAL_ENC) from 1Password, drop it in backend/.
#    .env.keys is git-ignored — it never lives in the repo.
# 3. Copy the example for your personal secrets (LLM keys, machine paths):
cp .env.example .env.personal       # then fill in ANTHROPIC_API_KEY / OPENAI_API_KEY
# 4. Start Postgres and build the DB (drops → migrates → seeds Slack identities + tenant row):
docker compose up -d postgres       # from the repo root
pnpm install
pnpm db:recreate
```

After this the 6 puppet bots and the workspace tenant row are seeded from the shared config — no
manual Slack OAuth needed for local testing. `.env.personal` overrides `.env.local.enc`, so set a
key there only to deviate from the shared dev workspace.

## Workspace sandboxes (let the bots read/build code)

Workspaces are now **mandatory and containerized** — daemon-only, no local-worktree fallback. The
first time a bot tries to read or build code it spawns a per-task DinD sandbox via
`ContainerManagerService`. The **slack-app self-provisions the base image + mounted daemon build at
boot** (`WorkspaceProvisionerService`, through the same dockerode seam), so a deploy is just running
the slack-app — **no manual `pnpm daemon:build`, no SSH**. One-time local setup on **Docker Desktop**:

```bash
# 1. Postgres + Redis (Redis = the host↔sandbox bus: host localhost:6380, service DNS
#    agent-playground-redis:6379 on the agent-playground_default network).
docker compose up -d                 # from the repo root

# 2. Set the host env (backend/.env.personal — already in .env.example):
#    WORKSPACE_IMAGE=agent-workspace-base
#    WORKSPACE_DOCKER_STORAGE_DRIVER=vfs   # Docker Desktop only (overlay-on-overlay can't mount); EMPTY on Linux
#    REDIS_URL=redis://localhost:6380      # the compose Redis; the default :6379 is the wrong instance

# 3. Start the harness (pnpm slack:dev / dev server). At boot it builds the base image (if missing) and
#    (re)builds the daemon into the mounted volume — the first time takes a few minutes; later boots are
#    incremental (frozen lockfile + persistent pnpm-store ⇒ pnpm install ≈ no-op, only nest build runs).
```

A redeploy/restart rebuilds the mounted daemon volume, so a sandbox picks up new daemon code on its
next (re)start. `pnpm daemon:build` still works as a **manual escape hatch** (pre-build, or rebuild
outside the app); set `SKIP_DAEMON_BUILD=true` to skip the boot rebuild for fast restarts, or
`REBUILD_IMAGE=true` to force a base-image rebuild.

**Resetting / inspecting sandboxes** — workspaces are **not** in Postgres: Docker (`com.agent.managed`
labels) and the daemon's git worktrees are the source of truth, and the host registries are in-memory
caches reconciled at boot (only `sessions` are durable). So there's no in-app reset to maintain — to
clear sandboxes just `docker rm -f` the `com.agent.managed=1` containers; the boot reconcile re-adopts
what's left and the orphan-volume sweep reclaims leaked `/var/lib/docker` volumes. `pnpm daemon:reset`
remains a dev convenience for that (plus the optional build-volume wipe / dev-DB drop).

`WORKSPACE_REDIS_URL` and `WORKSPACE_NETWORK` use correct compose defaults — only override them for a
non-default compose project name/network. The canonical, runnable recipe (and the exact reason
Docker Desktop needs `vfs`) lives in `backend/src/daemon/__e2e__/sandbox-turn.e2e.ts`.

## Subscription (OAuth) engine auth — run coding turns off a Claude Max / ChatGPT plan

By default every engine turn bills the workspace's metered **API key**. A workspace can instead drive
its expensive coding-**engine** turns (the sessions — claude/codex) off its own **subscription**, a
~20× saving when it already pays for a plan. This is *additive*: chat, the gate, and embeddings still
use the API key, so a subscription workspace still stores one.

Per-workspace, per-provider, via the admin REST (gated by `ADMIN_API_TOKEN`):

```bash
# Codex (ChatGPT plan): run `codex login` locally, then submit ~/.codex/auth.json's contents.
PUT /tenants/:teamId/llm-keys/openai/subscription    { "mode": "subscription", "secret": "<auth.json contents>" }

# Claude (Max plan): run `claude setup-token` locally, then submit the printed CLAUDE_CODE_OAUTH_TOKEN.
PUT /tenants/:teamId/llm-keys/anthropic/subscription { "mode": "subscription", "secret": "<oauth token>" }

# Revert to metered billing (keeps the stored secret):
PUT /tenants/:teamId/llm-keys/anthropic/subscription { "mode": "api_key" }
```

Caveats: subscription **rate limits** (pooled 5h/weekly) apply — fine for a personal workspace, will
throttle a heavy one. The Claude path uses the Agent SDK's `CLAUDE_CODE_OAUTH_TOKEN`; verify it works
for your account before relying on it (Anthropic steers third-party SDK use toward API keys). Each
person uses their **own** subscription for their **own** workspace — credentials are never shared.

## Project setup

**Submodules must be initialized before `pnpm install`** — `@workspace/langfuse` and
`@workspace/auth` live in git submodules (`packages/nestjs-ai-essentials`, `packages/jwt-auth`).
Without them pnpm can't link the workspace packages and `tsc` throws TS2307.

```bash
# From the repo root — initializes submodules, installs, AND builds packages in one step:
$ pnpm run setup

# Or separately:
$ git submodule update --init --recursive
$ pnpm install
$ pnpm build:packages   # required: builds @workspace/langfuse and @workspace/auth dist/
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
