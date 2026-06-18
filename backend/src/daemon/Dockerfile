# syntax=docker/dockerfile:1.7
# =============================================================================
# GENERIC workspace base image — a lightweight "dev container" for ANY GitHub project.
#
# This image carries ONLY the toolchain a coding-agent workspace needs: a Linux dev environment with
# git, gh, curl, pnpm, the Claude + Codex CLIs, Playwright/chromium, and a full inner Docker (the
# privileged DinD that gives each workspace its OWN `docker compose`). It bakes NO repository, NO
# project packages, and NO daemon code — the daemon is a Linux build MOUNTED read-only at /daemon from a
# named volume (`pnpm daemon:build` produces it; the host's ContainerManagerService mounts it and sets
# DAEMON_ENTRY). So a daemon code change is `pnpm daemon:build` + restart, never an image rebuild, and
# this image is reusable across every project.
#
# Runtime env (DAEMON_ENTRY, WORKSPACE_ROOT, AGENT_HOME_ROOT, SANDBOX_GUARD_RELAXED, the repo coords,
# Redis URL, …) is INJECTED by the host per container — deliberately NOT baked here, so the image stays
# project-agnostic and the host owns the deployment shape. In particular there is NO `NODE_ENV=production`:
# these are dev workspaces, not prod servers.
#
# BUILD (from the repo root — only the entrypoint is copied, so the context stays tiny):
#     docker build -f backend/src/daemon/Dockerfile -t agent-workspace-base .
# This is also done for you by `pnpm daemon:build` (which then populates the daemon-build volume).
# =============================================================================

# Pinned to the repo's Node line (.nvmrc = 22.13). bookworm-slim is the Debian base.
ARG NODE_IMAGE=node:22.13-bookworm-slim

# The codex CLI on PATH at the SDK-matched version (agent shell convenience — the engines themselves
# resolve their binaries from the daemon's pinned SDK packages in the mounted build, not from PATH).
ARG CODEX_CLI_VERSION=0.137.0

FROM ${NODE_IMAGE} AS base

ENV DEBIAN_FRONTEND=noninteractive
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Playwright browsers baked at a stable system path so the agent's browser tooling resolves them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# System packages:
#  - git: the daemon owns git (clone/worktree/publish inside the sandbox).
#  - gh: GitHub CLI (PR surface alongside GithubApiService).
#  - curl/ca-certificates/gnupg/lsb-release: TLS + apt keys + the agent's `curl localhost` self-checks.
#  - rsync: used by the daemon-build step to copy the repo source into the build volume.
#  - iptables: dockerd REQUIRES it to program the inner bridge network (compose service networking).
#  - the FULL inner Docker (docker.com apt repo) for the privileged DinD — `docker compose up` PRIVATE
#    to the sandbox (the collision fix the whole feature exists for):
#      • docker-ce-cli + docker-compose-plugin — the CLI + `docker compose` (agent-facing).
#      • docker-ce + containerd.io           — the ENGINE: `dockerd` + the OCI runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      gh \
      curl \
      ca-certificates \
      gnupg \
      lsb-release \
      rsync \
      iptables \
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
      docker-ce \
      containerd.io \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack, pinned to the repo's packageManager (root package.json: pnpm@11.1.2). corepack
# bundled with node:22.13 carries stale npm signing keys → "Cannot find matching keyid" when it fetches
# pnpm. Upgrade corepack first so it has current keys (keeps signature verification ON), then activate.
RUN npm install --global corepack@latest \
    && corepack enable && corepack prepare pnpm@11.1.2 --activate

# The codex CLI on PATH at the SDK-matched version (agent shell convenience — see ARG note above).
ARG CODEX_CLI_VERSION
RUN npm install -g @openai/codex@${CODEX_CLI_VERSION} \
    && npm cache clean --force

# Bake Playwright + chromium and its OS deps (the agent drives a real browser in-sandbox). playwright is
# a TOOL the agent invokes in its own shell, so install the CLI globally; browsers land at
# PLAYWRIGHT_BROWSERS_PATH (/ms-playwright); `--with-deps` runs apt-get (it updates its own lists).
RUN npm install --global playwright \
    && playwright install --with-deps chromium

# The clone lands at WORKSPACE_ROOT (host injects /workspace/repo); the daemon is mounted at /daemon.
WORKDIR /workspace

# The privileged-DinD entrypoint: starts the inner dockerd, waits for its socket, then runs the MOUNTED
# daemon (DAEMON_ENTRY, host-injected) and forwards SIGTERM for clean shutdown. The container must run
# `--privileged` with a /var/lib/docker volume (the host's ContainerManagerService does both).
COPY backend/src/daemon/entrypoint.sh /usr/local/bin/daemon-entrypoint.sh
RUN chmod +x /usr/local/bin/daemon-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/daemon-entrypoint.sh"]
