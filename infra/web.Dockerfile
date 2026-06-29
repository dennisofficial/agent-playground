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

# ─── deps ────────────────────────────────────────────────────────────────────────
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json   ./web/
COPY shared/package.json ./shared/

# Submodule package.jsons referenced by web workspace packages
COPY packages/pg-realtime/package.json            ./packages/pg-realtime/
COPY packages/nestjs-core-essentials/package.json ./packages/nestjs-core-essentials/
COPY packages/jwt-auth/package.json               ./packages/jwt-auth/
COPY packages/nestjs-ai-essentials/package.json   ./packages/nestjs-ai-essentials/

RUN --mount=type=cache,id=pnpm-store-web,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ─── build ───────────────────────────────────────────────────────────────────────
FROM deps AS builder

ARG NEXT_PUBLIC_HTTP_URL

COPY . .

# Build shared first (web imports @workspace/shared types + dist).
RUN pnpm --filter @workspace/shared run build

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
