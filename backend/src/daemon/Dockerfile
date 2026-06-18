# syntax=docker/dockerfile:1.7
# =============================================================================
# Workspace-sandbox DAEMON base image.
#
# This is the image every isolated workspace sandbox runs (one container = one fresh clone + its own
# inner Docker). It bakes a real Linux dev environment — git, gh, curl, pnpm, the Claude + Codex CLIs,
# Playwright/chromium, and a Docker CLI + compose plugin for the inner privileged DinD (Phase 10) —
# plus the built `dist/daemon` and prod node_modules. The daemon (Phase 5) connects OUT to Redis and
# runs Claude/Codex engine turns in-container.
#
# BUILD CONTEXT = THE REPO ROOT (it needs pnpm-workspace.yaml, pnpm-lock.yaml, the submodule packages,
# shared/, and backend/). From the repo root:
#     docker build -f backend/src/daemon/Dockerfile -t agent-daemon:dev .
# (Submodules must be checked out first: `git submodule update --init --recursive`, which `pnpm run
# setup` also does — the build copies them in, it does NOT clone them.)
#
# NOTE: this image is large/slow to build (chromium + the toolchain); it is VALIDATED in a later
# phase, not in the Phase-3 gate. Pin points are called out inline.
# =============================================================================

# Pinned to the repo's Node line (.nvmrc = 22.13). bookworm-slim is the Debian base the plan names.
ARG NODE_IMAGE=node:22.13-bookworm-slim

# SDK CLI resolution — kept in lockstep with backend/package.json + pnpm-lock.yaml so in-container
# engine behavior matches the host (top risk #8: SDK/CLI drift host↔image).
#
# IMPORTANT — the engines do NOT depend on a PATH-installed CLI. Both SDKs self-provision their own
# native binary from a LOCKFILE-PINNED platform package:
#  - @anthropic-ai/claude-agent-sdk@0.3.168 declares optionalDependencies
#    @anthropic-ai/claude-agent-sdk-<platform>@0.3.168 and extracts/chmods that binary at run time
#    (its extractFromBunfs path) — so SDK-driven Claude turns use the pinned 0.3.168 binary, NOT a
#    PATH `claude`. (claude.engine.ts never sets pathToClaudeCodeExecutable; it doesn't need to.)
#  - @openai/codex-sdk@0.137.0 resolves @openai/codex (+ @openai/codex-<platform>@0.137.0), pinned in
#    the lockfile, the same way.
# So the ENGINES are fully pinned via the prod node_modules alone — no global install required, and we
# deliberately AVOID an unpinnable `@latest` global (top risk #8 / reproducibility).
#
# We still install the codex CLI GLOBALLY at the SDK-matched version purely as a PATH convenience for
# the AGENT (an execute turn may `codex …` in its own shell). The claude CLI is intentionally NOT
# globally installed: the SDK self-resolves it, and there is no lockfile version to pin a global to.
ARG CODEX_CLI_VERSION=0.137.0

# -----------------------------------------------------------------------------
# Stage 1: base — the OS toolchain shared by build + runtime.
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base

ENV DEBIAN_FRONTEND=noninteractive
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Playwright browsers are baked at a stable system path so both build + runtime resolve them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# System packages:
#  - git: the daemon owns git (Phase 4) — clone/worktree/publish inside the sandbox.
#  - gh: GitHub CLI (PR surface alongside GithubApiService).
#  - curl/ca-certificates/gnupg: TLS + fetching apt keys + the agent's `curl localhost` self-checks.
#  - the Docker CLI + compose plugin (docker.com apt repo) for the inner privileged DinD (Phase 10):
#    `docker compose up` is PRIVATE to the sandbox (the collision fix the whole feature exists for).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      gh \
      curl \
      ca-certificates \
      gnupg \
      lsb-release \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
         | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
         > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce-cli \
      docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack, pinned to the repo's packageManager (root package.json: pnpm@11.1.2).
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

# The codex CLI on PATH at the SDK-matched version (agent shell convenience — see ARG notes above;
# the engines themselves resolve their binaries from the pinned SDK packages, not from PATH).
ARG CODEX_CLI_VERSION
RUN npm install -g @openai/codex@${CODEX_CLI_VERSION} \
    && npm cache clean --force

# -----------------------------------------------------------------------------
# Stage 2: build — install the full workspace, build packages + shared, compile the daemon.
# -----------------------------------------------------------------------------
FROM base AS build
WORKDIR /repo

# Copy the WHOLE repo (build context = repo root). The .dockerignore at the repo root must exclude
# node_modules / dist / .git so the context stays sane; submodules are expected already checked out.
COPY . .

# Full workspace install (dev deps included — needed to build). The lockfile is authoritative.
# `pnpm install` honors pnpm-workspace.yaml (injected workspace packages, isolated node-linker).
RUN pnpm install --frozen-lockfile

# Build the house submodule packages (@workspace/nestjs-core, @workspace/auth, …) and shared/ — the
# TypeORM entities + @CreateModule/BaseEnvService the daemon imports resolve from their dist output.
RUN pnpm --filter "./packages/**" run build \
    && pnpm --filter "@workspace/shared" run build

# Bake Playwright + chromium and its OS deps (the agent drives a real browser in-sandbox).
RUN pnpm --filter backend exec playwright install --with-deps chromium

# Compile just the daemon nest-cli project → dist/daemon/main.js (+ the harness/_core/_lib it pulls).
RUN pnpm --filter backend exec nest build daemon

# Prune dev deps so only prod node_modules ships. CRITICAL: the dynamically-imported ESM SDKs
# (@anthropic-ai/claude-agent-sdk, @openai/codex-sdk) + their pinned platform binaries are prod
# `dependencies`, loaded lazily via the EsmModule tokens, so this prod install KEEPS them — do not add
# any aggressive manual deletion that strips them.
# `confirmModulesPurge=false` is REQUIRED: re-installing with --prod over a full node_modules makes
# pnpm PURGE the dev deps, and in a non-TTY build it would otherwise BLOCK on a confirmation prompt.
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false

# -----------------------------------------------------------------------------
# Stage 3: runtime — the lean image the sandbox actually runs.
# -----------------------------------------------------------------------------
FROM base AS runtime

# The sandbox's conventional layout (Phase 4 clones into WORKSPACE_ROOT; engine homes + skill cache
# live under AGENT_HOME_ROOT — both on the per-sandbox workspace volume in deployment).
ENV NODE_ENV=production
ENV AGENT_HOME_ROOT=/workspace/.agent-home
ENV WORKSPACE_ROOT=/workspace/repo
WORKDIR /workspace

# Ship the built app + its pruned prod node_modules + the workspace manifests. We copy the whole
# /repo tree from the build stage so the isolated/injected pnpm node_modules symlink graph (shared/,
# the submodule packages) stays intact — the daemon resolves @workspace/* and the ESM SDKs through it.
COPY --from=build /repo /repo

# Entrypoint: the compiled daemon. dist is flat (all nest-cli apps share outDir ../../dist), so the
# daemon entry is /repo/backend/dist/daemon/main.js.
CMD ["node", "/repo/backend/dist/daemon/main.js"]
