# Atlas v3 sandbox image — a privileged, Docker-in-Docker per-job dev environment.
#
# The sandbox is a REAL dev box: PID 1 (entrypoint.sh) starts an inner dockerd so the agent can
# `docker compose up` its stack and boot the repo's app; the host drives engine turns via `kubectl exec`
# into it. glibc (Debian) base so the agent's builds + native modules behave like deployment.
#
# MULTI-STAGE + SELF-CONTAINED: the builder stage builds the engine bundle INSIDE the image from the
# monorepo source (no host pre-build), so the deploy step is just `docker build` → push (see
# backend/sandbox/build-and-push.sh). BUILD CONTEXT IS THE REPO ROOT — build with:
#   docker build -f backend/sandbox/Dockerfile -t <ref> .
# (run from /Users/dennis/Developer/atlas). The root .dockerignore keeps node_modules/dist/.git out.

# ---------------------------------------------------------------------------------------------------
# Builder — install the pnpm workspace, build the @workspace/* packages, webpack the engine bundle.
# node:22-bookworm (NON-slim, buildpack-deps based) has gcc/g++/make/python3/git for native deps.
# ---------------------------------------------------------------------------------------------------
FROM node:22-bookworm AS builder

ENV CI=true \
    DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/root/.local/share/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

# Pin pnpm to the repo's packageManager version via corepack.
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

WORKDIR /repo

# Copy the whole monorepo (root .dockerignore strips node_modules/dist/.git/.env). A tighter dependency-
# graph copy isn't worth the maintenance here — the builder stage is discarded.
COPY . .

# Install the workspace from the lockfile, build the in-repo @workspace/* packages the engine inlines
# (shared + packages/** + submodules/**), then webpack the engine into backend/sandbox/engine-app.js.
RUN pnpm install --frozen-lockfile \
  && pnpm build:packages \
  && pnpm --filter backend build:engine

# ---------------------------------------------------------------------------------------------------
# Runtime — slim base + git + Docker CE (dockerd/CLI/compose) + the baked engine bundle & agent SDKs.
# ---------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
# Non-interactive shell hygiene so the agent's tooling never blocks on a prompt.
ENV TERM=xterm \
    GIT_TERMINAL_PROMPT=0 \
    GIT_EDITOR=true \
    EDITOR=true \
    PAGER=cat \
    GIT_PAGER=cat \
    npm_config_yes=true

# System deps + Docker CE (dockerd + CLI + compose v2) from Docker's official apt repo.
#  - git, iptables, procps, ca-certificates, curl, gnupg, openssh-client: DinD + repo/clone essentials.
#  - jq, unzip: general utility + unpacking downloaded release archives.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git iptables openssh-client procps jq unzip \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# Trust every worktree for all users (root PID 1 + any host-uid exec user touching the same mount).
# Single-tenant throwaway sandbox, so a blanket safe.directory is fine here.
RUN git config --system --add safe.directory '*'

# Engine runtime: the bundled engine entrypoint + an `atlas-engine-turn` launcher on PATH. The two agent
# SDKs are webpack-EXTERNAL (`import()`), so they must exist in a node_modules colocated with the bundle.
# Install them flat via npm into /usr/local/lib/atlas/node_modules (NOT pnpm — a plain flat layout so the
# ESM `import()` resolves identically without pnpm's symlink store). Pin to the engine's own deps versions.
ARG CLAUDE_SDK_VERSION=0.3.204
ARG CODEX_SDK_VERSION=0.137.0
RUN mkdir -p /usr/local/lib/atlas \
  && cd /usr/local/lib/atlas \
  && printf '{"name":"atlas-engine-runtime","private":true}\n' > package.json \
  && npm install "@anthropic-ai/claude-agent-sdk@${CLAUDE_SDK_VERSION}" "@openai/codex-sdk@${CODEX_SDK_VERSION}"

# The webpack bundle built in the builder stage (pinned to this image's Node 22 by absolute path). Glob ALL
# chunks — webpack code-splits some deps into `<id>.engine-app.js` chunks the main bundle lazy-loads at
# runtime (`__webpack_require__.e`), so copying only engine-app.js would crash at the first dynamic import.
COPY --from=builder /repo/backend/sandbox/*engine-app.js /usr/local/lib/atlas/
COPY --from=builder /repo/backend/sandbox/*engine-app.js.map /usr/local/lib/atlas/
RUN printf '#!/usr/bin/env bash\nexec /usr/local/bin/node --enable-source-maps /usr/local/lib/atlas/engine-app.js "$@"\n' \
      > /usr/local/bin/atlas-engine-turn \
  && chmod +x /usr/local/bin/atlas-engine-turn

# atlas-classify: the wrapper Claude Code runs every Bash command through (via CLAUDE_CODE_SHELL_PREFIX,
# set on the engine in launchEngineTurn). It renices agent-spawned work — builds, installs, integration
# tests — to the bottom of the CPU/IO scheduler so the engine's streaming loop always preempts it. The
# engine itself never routes through here, so it keeps default priority. `nice` is coreutils (always
# present); `ionice` is util-linux and guarded so a missing binary can't break command execution.
RUN printf '%s\n' \
      '#!/bin/sh' \
      '# Deprioritize agent-spawned work so the engine stream never waits behind a build. $1 = full command.' \
      'if command -v ionice >/dev/null 2>&1; then' \
      '  exec nice -n 19 ionice -c 3 -t /bin/bash -c "$1"' \
      'else' \
      '  exec nice -n 19 /bin/bash -c "$1"' \
      'fi' \
      > /usr/local/bin/atlas-classify \
  && chmod +x /usr/local/bin/atlas-classify

# PID 1: start the inner dockerd (auto overlay2/vfs), then idle / exec the given command.
COPY backend/sandbox/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
