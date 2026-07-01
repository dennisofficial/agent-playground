# Atlas v2 sandbox base image.
#
# A long-lived, privileged per-feature environment. PID 1 (sandbox-init.sh) starts an inner dockerd
# (DinD) and idles; the host drives engine turns via `docker exec` into it. glibc (Debian) base so the
# agent's builds + native modules behave like deployment. The engine CLIs + the compiled atlas engine
# entrypoint are layered on in D1 (kept last so app changes don't bust the heavy system layers).
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# System deps + Docker CE (dockerd + CLI + compose v2 + buildx) from Docker's official apt repo.
# Also: python3 + a C/C++ toolchain (build-essential) so the agent's repos can run Python build steps and
# compile native node modules (node-gyp); unzip is needed to unpack the fnm release.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git iptables openssh-client procps \
      python3 python3-venv python3-pip build-essential unzip \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (the agent's typical package manager). Pinned to pnpm@10, NOT @latest: a repo can pin
# any Node major via fnm (below), and pnpm@11 requires Node >=22.13 (it imports the node:sqlite builtin) so
# it CRASHES on Node 20. pnpm@10 runs on every seeded major (20/22). A repo that needs a different pnpm
# pins it via its own `packageManager` field, which corepack honors (needs egress for an uncached version).
RUN corepack enable && corepack prepare pnpm@10 --activate

# fnm — per-repo Node version switching from the repo's own .nvmrc / .node-version. The ENGINE itself
# stays pinned to this image's Node 22 (see the atlas-engine-turn launcher below, which calls node by
# absolute path); fnm only switches Node for the AGENT's build shells, activated via BASH_ENV. Install
# is architecture-aware (the build sets no --platform). NO Node versions are baked: sandboxes have
# outbound egress, so shell-init.sh downloads the repo's pinned version on first use and caches it in the
# SHARED fnm store (FNM_DIR below) — download-once-global, like the pnpm store. A repo with no version
# file just runs this image's base Node 22.
ARG FNM_VERSION=v1.38.1
RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
       amd64) fnm_artifact=fnm-linux ;; \
       arm64) fnm_artifact=fnm-arm64 ;; \
       *) echo "unsupported arch for fnm: $arch" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/Schniz/fnm/releases/download/${FNM_VERSION}/${fnm_artifact}.zip" -o /tmp/fnm.zip \
  && unzip -q /tmp/fnm.zip -d /usr/local/bin \
  && chmod +x /usr/local/bin/fnm \
  && rm /tmp/fnm.zip

# Engine runtime: the two SDKs (each ships its native CLI via a per-platform package) + the bundled
# atlas engine entrypoint. Pinned to match the host so a turn behaves identically (keep in sync; D5
# may promote these to build args). The host passes secrets as exec env, never baked here.
ARG CLAUDE_SDK_VERSION=0.3.168
ARG CODEX_SDK_VERSION=0.137.0
RUN mkdir -p /usr/local/lib/atlas \
  && cd /usr/local/lib/atlas \
  && printf '{"name":"atlas-engine-runtime","private":true}\n' > package.json \
  && pnpm add "@anthropic-ai/claude-agent-sdk@${CLAUDE_SDK_VERSION}" "@openai/codex-sdk@${CODEX_SDK_VERSION}"
COPY engine-entrypoint.mjs /usr/local/lib/atlas/engine-entrypoint.mjs
# Pin the engine to THIS image's Node 22 by absolute path — fnm rewrites PATH for the agent's build
# shells, so calling `node` unqualified here would risk launching the engine under a repo-pinned Node.
RUN printf '#!/usr/bin/env bash\nexec /usr/local/bin/node /usr/local/lib/atlas/engine-entrypoint.mjs "$@"\n' \
      > /usr/local/bin/atlas-engine-turn \
  && chmod +x /usr/local/bin/atlas-engine-turn

COPY sandbox-init.sh /usr/local/bin/sandbox-init.sh
RUN chmod +x /usr/local/bin/sandbox-init.sh

# Shared cross-thread fnm store (one host dir bound here by SandboxManager — see CONTAINER_FNM_STORE) +
# activate fnm in every non-interactive agent bash via BASH_ENV. Set LAST so the build's own RUN steps
# above are not affected by shell-init.sh.
ENV FNM_DIR=/atlas-fnm
ENV BASH_ENV=/etc/atlas/shell-init.sh
COPY shell-init.sh /etc/atlas/shell-init.sh

# Build-context hash (set by SandboxImageBuilder over the static context files), baked as a label so the
# host can tell a matching image from a stale one and rebuild ONLY when the image definition changed —
# instead of skipping forever on tag-exists or rebuilding on every boot. Trivial trailing metadata layer.
ARG ATLAS_CONTEXT_HASH=dev
LABEL atlas.context-hash=$ATLAS_CONTEXT_HASH

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/sandbox-init.sh"]
