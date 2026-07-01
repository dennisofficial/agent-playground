# syntax=docker/dockerfile:1.7
# Build context: REPO ROOT (not backend/).
#
# Usage:
#   docker build -f infra/backend.Dockerfile .                    # runtime image
#   docker build -f infra/backend.Dockerfile --target migrator .  # migration-runner image
#
# Prerequisites: git submodules must be present in the build context.
#   git submodule update --init --recursive
#
# NOTE: the backend does NOT shell out to the `gh` CLI — all Git/GitHub operations use the GitHub REST
# API via HTTPS (GITHUB_TOKEN). Only `git` is needed at runtime for the engine subprocess.
#
# Why install with the FULL source present (not a manifests-only cache layer): this pnpm workspace uses
# `injectWorkspacePackages: true` + `syncInjectedDepsAfterScripts: [build, prepare]`, so `pnpm install`
# runs each workspace package's build/prepare (e.g. `shared` → tsup) DURING install — which needs the
# package source, not just its package.json. It also compiles native deps (better-sqlite3,
# msgpackr-extract via node-gyp), which need a Python+C toolchain. Both are handled in the builder stages
# only; the runtime image stays slim.

ARG PNPM_VERSION=11.1.2
ARG NODE_IMAGE=node:22-bookworm-slim

# ─── base (slim — shared by builder + runtime) ─────────────────────────────────────
FROM ${NODE_IMAGE} AS base
# CI=true → pnpm runs non-interactively (e.g. purges node_modules when pruning to --prod without a TTY).
ENV CI=true
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /srv/atlas/app

# ─── build (full source + toolchain) ───────────────────────────────────────────────
FROM base AS build
# node-gyp toolchain for native modules built during `pnpm install`.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

# Full repo (submodules already checked out in the build context).
COPY . .

# Install (runs workspace build/prepare lifecycle + native compiles) then build everything.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm run build:packages                  # packages/** (pg-realtime, nestjs-core, auth, langfuse, langchain)
RUN pnpm --filter @workspace/shared run build # shared/ (also built via its install `prepare`; explicit = safe)
RUN pnpm --filter backend run build           # `nest build app` → backend/dist (+ sandbox image assets)

# ─── migrator ──────────────────────────────────────────────────────────────────────
# One-shot migration runner (typeorm-ts-node-commonjs needs src/ + cli/ + tsconfig.cli.json, all here).
# Run before each deploy with POSTGRES_* env (POSTGRES_SSL_MODE=disable on the internal network).
FROM build AS migrator
WORKDIR /srv/atlas/app/backend
CMD ["pnpm", "db:migrate:deploy"]

# ─── prod-deps ───────────────────────────────────────────────────────────────────
# Prune to production deps. FROM build so the workspace dists exist — pnpm re-injects the built
# @workspace/* packages (injectWorkspacePackages) when re-resolving prod-only. esbuild stays (a runtime
# dep: the backend rebundles the engine at boot).
FROM build AS prod-deps
# --ignore-scripts: the dists were already built in `build`; pruning to --prod removes devDeps (tsup
# etc.), so re-running workspace `prepare`/native rebuilds here would fail (tooling gone) and is
# unnecessary — the already-built outputs are kept.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ─── runtime (slim) ─────────────────────────────────────────────────────────────────
FROM base AS runtime
# tini: PID-1 init that forwards SIGTERM to node (so NestJS shutdown hooks fire).
# curl: HEALTHCHECK + Caddy health probes.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/atlas/app

# Production node_modules (incl. compiled native .node binaries + injected @workspace/* packages).
COPY --from=prod-deps /srv/atlas/app/node_modules ./node_modules
COPY --from=prod-deps /srv/atlas/app/backend/node_modules ./backend/node_modules

# Compiled application + the source/migration files the migrator/ad-hoc migrations need.
COPY --from=build /srv/atlas/app/backend/dist        ./backend/dist
COPY --from=build /srv/atlas/app/backend/src         ./backend/src
# The sandbox image build context — a fixed committed dir (backend/sandbox/), identical at build & runtime
# (NOT copied into dist). bundleEngine writes engine-entrypoint.mjs here at boot; ensureImage builds from it.
COPY --from=build /srv/atlas/app/backend/sandbox     ./backend/sandbox
COPY --from=build /srv/atlas/app/backend/migrations  ./backend/migrations
COPY --from=build /srv/atlas/app/backend/cli         ./backend/cli
COPY --from=build /srv/atlas/app/backend/tsconfig.cli.json ./backend/tsconfig.cli.json
COPY --from=build /srv/atlas/app/backend/package.json ./backend/package.json

# Workspace dists (for any code that resolves them by path; injected copies live under node_modules).
# `shared` is symlinked from backend/node_modules/@workspace/shared → needs BOTH its dist AND its
# package.json (the exports map) present, or `@workspace/shared/schemas` won't resolve at runtime.
COPY --from=build /srv/atlas/app/shared/dist ./shared/dist
COPY --from=build /srv/atlas/app/shared/package.json ./shared/package.json
COPY --from=build /srv/atlas/app/packages ./packages
COPY --from=build /srv/atlas/app/package.json /srv/atlas/app/pnpm-workspace.yaml ./

# Entrypoint
COPY infra/backend-entrypoint.sh /usr/local/bin/backend-entrypoint.sh
RUN chmod +x /usr/local/bin/backend-entrypoint.sh

EXPOSE 4002

# On first boot the backend (entirely in-process — no extra entrypoint logic):
#   1. bundleEngine() → writes engine-entrypoint.mjs into the fixed backend/sandbox/ build-context dir AND
#      mirrors it to ENGINE_BUNDLE_PATH (A8).
#   2. SandboxImageBuilder.ensureImage() → builds atlas-sandbox:latest on the host daemon from
#      backend/sandbox/ if the tag is absent (or its context hash changed).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:4002/health/live || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/backend-entrypoint.sh"]
