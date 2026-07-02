# Atlas v2 sandbox base image.
#
# A long-lived, privileged per-feature environment. PID 1 (sandbox-init.sh) starts an inner dockerd
# (DinD) and idles; the host drives engine turns via `docker exec` into it. glibc (Debian) base so the
# agent's builds + native modules behave like deployment. The engine CLIs + the compiled atlas engine
# entrypoint are layered on in D1 (kept last so app changes don't bust the heavy system layers).
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# No TTY is ever attached to engine execs — signal non-interactive to CLIs that prompt instead of
# isatty-checking (npx's install confirm, git spawning $EDITOR, pip prompts, credential asks). CI stays
# UNSET on purpose: it flips pnpm/yarn to frozen-lockfile installs and some builds to warnings-as-errors,
# which breaks the agent's edit-package.json-then-install loop.
# TERM: docker exec without -t leaves it unset, so `clear`/`tput` in repo scripts exit non-zero and
# short-circuit && chains (e.g. tsup --onSuccess 'clear && node dist/main.js' builds but never boots).
# xterm, not dumb — dumb has no clear capability so `clear` still fails.
ENV TERM=xterm \
    GIT_TERMINAL_PROMPT=0 \
    GIT_EDITOR=true \
    EDITOR=true \
    PAGER=cat \
    GIT_PAGER=cat \
    npm_config_yes=true \
    PIP_NO_INPUT=1

# System deps + Docker CE (dockerd + CLI + compose v2 + buildx) from Docker's official apt repo.
# Also: python3 + a C/C++ toolchain (build-essential) so the agent's repos can run Python build steps and
# compile native node modules (node-gyp); unzip is needed to unpack the fnm release.
# direnv: honor a repo's own `.envrc` (e.g. `CLOUDSDK_CONFIG=./.gcloud`) so Atlas boots the app exactly
# how the repo is set up locally. shell-init.sh evaluates it for each non-interactive agent shell.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git iptables openssh-client procps direnv \
      python3 python3-venv python3-pip build-essential unzip \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (the agent's typical package manager). `corepack prepare pnpm@10 --activate` seeds a
# cached version so THIS image build (installing the engine SDKs below) doesn't need network egress — it
# does NOT force pnpm@10 on agent repos at runtime: like fnm resolves each repo's OWN Node version from
# .nvmrc with no baked default, corepack resolves each repo's OWN pnpm version from its `packageManager`
# field, or whatever's current if the repo declares none. A repo that needs a specific pnpm (e.g. because
# an old Node major it pins can't run a newer pnpm) is responsible for declaring that in its own
# `packageManager` field, same as it owns its own Node pin.
RUN corepack enable && corepack prepare pnpm@10 --activate

# Pin pnpm's content-addressable store to the shared system cache (SandboxManager binds a host dir here —
# see CONTAINER_PNPM_STORE) instead of leaving it unset — regardless of which pnpm version a repo resolves
# to. Left unset, pnpm falls back to its own per-disk default, which (even with a durable `HOME`) still
# lands a LIVE store inside `/workspace` if `/workspace` is a separate device from wherever that default
# points — which is what once got a ~1.7 GB `.pnpm-store/` swept into a commit by `git add -A`. Two
# mechanisms are needed because `storeDir` config moved between pnpm majors (verified live against both):
#   - pnpm 10.x and earlier read the classic npm-style env var.
#   - pnpm 11.x dropped store-dir from `.npmrc`/env vars — it now needs `pnpm-workspace.yaml` (per-project,
#     not usable here) or its global `~/.config/pnpm/config.yaml`. `HOME` is a PER-REPO bind (see
#     CONTAINER_HOME below), so anything baked under it gets shadowed at container-create — hence
#     redirecting XDG_CONFIG_HOME to a path no bind ever shadows and baking the config there.
ENV npm_config_store_dir=/.atlas/pnpm-store
ENV XDG_CONFIG_HOME=/etc/atlas/xdg-config
RUN mkdir -p /etc/atlas/xdg-config/pnpm \
  && printf 'storeDir: /.atlas/pnpm-store\n' > /etc/atlas/xdg-config/pnpm/config.yaml

# fnm — per-repo Node version switching from the repo's own .nvmrc / .node-version. The ENGINE itself
# stays pinned to this image's Node 22 (see the atlas-engine-turn launcher below, which calls node by
# absolute path); fnm only switches Node for the AGENT's build shells, activated via BASH_ENV. Install
# is architecture-aware (the build sets no --platform). NO Node versions are baked: sandboxes have
# outbound egress, so shell-init.sh downloads the repo's pinned version on first use and caches it in the
# SHARED fnm store (FNM_DIR below, under /.atlas — engine-internal, like the pnpm store) —
# download-once-global. A repo with no version file just runs this image's base Node 22.
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

# atlas-svc: the in-sandbox process supervisor (run/logs/ps/stop) the agent drives via Bash to bring dev
# servers up on demand. Markers + logs live under the durable agent home (/.atlas/supervisor).
COPY atlas-svc /usr/local/bin/atlas-svc
RUN chmod +x /usr/local/bin/atlas-svc

# Shared cross-thread fnm store (one host dir bound here by SandboxManager — see CONTAINER_FNM_STORE) +
# activate fnm in every non-interactive agent bash via BASH_ENV. Set LAST so the build's own RUN steps
# above are not affected by shell-init.sh.
ENV FNM_DIR=/.atlas/fnm
ENV BASH_ENV=/etc/atlas/shell-init.sh
COPY shell-init.sh /etc/atlas/shell-init.sh

# Durable agent HOME (SandboxManager binds a PER-REPO host dir here — see CONTAINER_HOME). Turns exec as the
# host uid:gid (not root), so without an explicit HOME a tool's "default" config/cred/install path is
# undefined; setting it makes `~/.config/gcloud`, `~/.local/bin`, etc. well-defined AND persistent across
# resets/jobs. The user bin dirs are APPENDED to PATH (never prepended): a durably-installed binary can only
# ADD a tool, never SHADOW a system one (git/curl/…) — that anti-shadow ordering is load-bearing.
ENV HOME=/home/atlas
ENV PATH=${PATH}:/home/atlas/.local/bin:/home/atlas/bin
RUN mkdir -p /home/atlas/.local/bin /home/atlas/bin

# Build-context hash (set by SandboxImageBuilder over the static context files), baked as a label so the
# host can tell a matching image from a stale one and rebuild ONLY when the image definition changed —
# instead of skipping forever on tag-exists or rebuilding on every boot. Trivial trailing metadata layer.
ARG ATLAS_CONTEXT_HASH=dev
LABEL atlas.context-hash=$ATLAS_CONTEXT_HASH

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/sandbox-init.sh"]
