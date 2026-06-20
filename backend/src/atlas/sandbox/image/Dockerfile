# Atlas v2 sandbox base image.
#
# A long-lived, privileged per-feature environment. PID 1 (sandbox-init.sh) starts an inner dockerd
# (DinD) and idles; the host drives engine turns via `docker exec` into it. glibc (Debian) base so the
# agent's builds + native modules behave like deployment. The engine CLIs + the compiled atlas engine
# entrypoint are layered on in D1 (kept last so app changes don't bust the heavy system layers).
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# System deps + Docker CE (dockerd + CLI + compose v2 + buildx) from Docker's official apt repo.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git iptables openssh-client procps \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (the agent's typical package manager).
RUN corepack enable && corepack prepare pnpm@latest --activate

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
RUN printf '#!/usr/bin/env bash\nexec node /usr/local/lib/atlas/engine-entrypoint.mjs "$@"\n' \
      > /usr/local/bin/atlas-engine-turn \
  && chmod +x /usr/local/bin/atlas-engine-turn

COPY sandbox-init.sh /usr/local/bin/sandbox-init.sh
RUN chmod +x /usr/local/bin/sandbox-init.sh

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/sandbox-init.sh"]
