# syntax=docker/dockerfile:1.7
# Build context: REPO ROOT (not web/).
#
# Next.js standalone build — no Node.js server needed at runtime beyond `node web/.next/standalone/server.js`.
# Requires `output: "standalone"` in web/next.config.ts (already added).
#
# The NEXT_PUBLIC_HTTP_URL is baked into the JS bundle at build time — pass the prod
# value as a build-arg. Do NOT omit it or the browser will fall back to localhost:4002.
#
# Usage:
#   docker build -f infra/web.Dockerfile \
#     --build-arg NEXT_PUBLIC_HTTP_URL=https://api.atlas.dltechnologies.co \
#     .

ARG PNPM_VERSION=11.1.2
ARG NODE_IMAGE=node:22-bookworm-slim
ARG NEXT_PUBLIC_HTTP_URL=https://api.atlas.dltechnologies.co

# ─── base ───────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /srv/atlas/web

# ─── build ───────────────────────────────────────────────────────────────────────
# Full source (not a manifests-only cache layer) — same rationale as backend.Dockerfile: this pnpm
# workspace uses `injectWorkspacePackages: true` + `syncInjectedDepsAfterScripts: [build, prepare]`, so
# `pnpm install` runs each workspace package's build/prepare (e.g. `shared`, the `nestjs-ai-essentials`
# submodule's `langchain`/`langfuse`) DURING install — which needs real source, not just package.json.
# A manifests-only enumeration is also fragile: nestjs-ai-essentials has no root package.json (it's a
# nested mini-monorepo — langchain/ and langfuse/ each have their own), which broke every web build
# until this was caught.
FROM base AS builder

# node-gyp toolchain — a root-level `pnpm install` resolves the WHOLE workspace lockfile (backend's
# native deps included, e.g. better-sqlite3/msgpackr-extract), not just web's, even in this image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

ARG NEXT_PUBLIC_HTTP_URL

COPY . .

RUN --mount=type=cache,id=pnpm-store-web,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Build shared + auth first (web imports @workspace/shared and @workspace/auth types + dist).
# shared's own `prepare` script builds it during `pnpm install` above, but this is kept explicit for the
# same reason auth needs it: @workspace/auth (packages/jwt-auth) has only a `build` script, no `prepare`
# hook, so nothing else ever compiles its dist/ — omitting this broke every web build with "Module not
# found: Can't resolve '@workspace/auth'".
RUN pnpm --filter @workspace/shared run build
RUN pnpm --filter @workspace/auth run build

# next build reads NEXT_PUBLIC_* at build time and embeds them in the JS bundle.
# NODE_ENV=production suppresses dev warnings in the build output.
ENV NEXT_PUBLIC_HTTP_URL=${NEXT_PUBLIC_HTTP_URL}
ENV NODE_ENV=production

RUN pnpm --filter web run build

# ─── runtime ─────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

# curl is required by the docker-compose web healthcheck (curl -sf http://localhost:3000/).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/atlas/web

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next.js standalone output bundles everything needed to run into .next/standalone/.
# Static files and public/ must be copied in separately — the standalone server doesn't
# include them (they're served by Caddy in prod, but include them for completeness).
COPY --from=builder /srv/atlas/web/web/.next/standalone ./
COPY --from=builder /srv/atlas/web/web/.next/static     ./web/.next/static
COPY --from=builder /srv/atlas/web/web/public           ./web/public

EXPOSE 3000

# The standalone entry point is server.js at the root of the standalone output.
CMD ["node", "web/server.js"]
