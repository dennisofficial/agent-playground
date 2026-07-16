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
# ripgrep (rg), fd-find (fd), jq: the CLI tools the engine agents (Claude Code / Codex) reach for by
# default — both prefer `rg` for code search and `fd` for file discovery and fall back to slower
# `grep`/`find`/`sed` when they're missing; `jq` is their JSON-in-pipeline workhorse. Debian ships fd as
# `fdfind` (name clash with another package), so we add an `fd` symlink below so the agents find it by the
# name they actually invoke.
# postgresql-client (psql), wget, dnsutils (dig/nslookup), netcat-openbsd (nc), rsync, lsof, sqlite3, less:
# common db/unix utilities repos + agents assume exist but the slim base omits. Google Cloud SDK
# (gcloud/gsutil/bq + GKE auth plugin) is added from Google's apt repo below, alongside docker/gh — the
# prompt-kit installs it into ~/.local/bin every onboarding otherwise, so bake it once.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git iptables openssh-client procps direnv \
      python3 python3-venv python3-pip build-essential unzip xz-utils \
      ripgrep fd-find jq \
      postgresql-client wget dnsutils netcat-openbsd rsync lsof sqlite3 less \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
  # GitHub CLI (gh) from GitHub's official apt repo — Atlas OWNS the branch→PR lifecycle in-sandbox
  # (open/update PRs itself with its authenticated token); a system binary in /usr/bin, shadows nothing.
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  # Google Cloud SDK from Google's official apt repo. Its key is ASCII-armored, so dearmor it to a keyring
  # (download-then-dearmor — no `curl | gpg` pipe, so a bad fetch fails the build). The repo is multi-arch;
  # no arch= qualifier needed. `cloud-sdk main` provides gcloud/gsutil/bq + the GKE auth plugin.
  && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg -o /etc/apt/keyrings/cloud-google.asc \
  && gpg --dearmor --yes -o /etc/apt/keyrings/cloud-google.gpg /etc/apt/keyrings/cloud-google.asc \
  && rm /etc/apt/keyrings/cloud-google.asc \
  && chmod a+r /etc/apt/keyrings/cloud-google.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/cloud-google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
  && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin gh \
      google-cloud-cli google-cloud-cli-gke-gcloud-auth-plugin \
  # Debian's fd-find installs the binary as `fdfind`; expose it under `fd`, the name the agents invoke.
  && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# pnpm via a PINNED corepack (the agent's typical package manager). The node:22 base tag floats, and its
# bundled corepack — and, via fnm, older repo-pinned Nodes' bundled corepack — can be pre-0.31, which
# FAILS pnpm signature verification (npm rotated the signing keys corepack hardcoded; fixed in 0.31+).
# So we pin corepack explicitly instead of inheriting whatever the base ships. `--force` is required
# because corepack ships as a bundled npm dependency and npm won't overwrite its bin shims otherwise.
#
# We stamp the PINNED corepack's pnpm/yarn shims into a fixed dir and put that dir FIRST on PATH (ENV
# below + re-asserted in shell-init.sh AFTER fnm switches Node) so per-repo Node switching can never fall
# back to an old bundled corepack. NO pnpm version is seeded here: like fnm resolves each repo's OWN Node
# from .nvmrc with no baked default, corepack resolves each repo's OWN pnpm from its `packageManager`
# field (or its default when none), cached under the durable HOME's ~/.cache/node/corepack. The engine
# SDKs below install via plain `npm`, so this build no longer needs an activated pnpm.
RUN npm install -g npm@latest \
  && npm install -g corepack@0.34.6 --force \
  && mkdir -p /opt/corepack-shims \
  && /usr/local/bin/corepack enable --install-directory /opt/corepack-shims

# Pinned-corepack shims first, so `pnpm`/`yarn` always route through corepack@0.34.6 regardless of which
# Node fnm activates. Unlike the /home/atlas user-bin APPEND further down, this must PREPEND — it needs to
# shadow the pnpm/yarn shims fnm-selected Nodes carry. shell-init.sh re-prepends it after `fnm env`, which
# otherwise pushes the selected Node's bin (and its bundled corepack) ahead of this on every agent shell.
ENV PATH=/opt/corepack-shims:${PATH}

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
# absolute path); fnm only switches Node for the AGENT's build shells, activated via BASH_ENV. NO Node
# versions are baked: sandboxes have outbound egress, so shell-init.sh downloads the repo's pinned version
# on first use and caches it in the SHARED fnm store (FNM_DIR below, under /.atlas — engine-internal, like
# the pnpm store) — download-once-global. A repo with no version file just runs this image's base Node 22.
# Installed via fnm's official install script — latest release, arch detected internally. Download the
# script to a file first (like the toolbelt block below, NOT `curl | bash`: no pipefail here, so a bad URL
# on the left of a pipe would still succeed). --install-dir puts the binary at /usr/local/bin/fnm;
# --skip-shell because shell-init.sh activates fnm itself. chmod 0755 so host-uid turns (not just root) can
# exec it — the official script only chmods u+x. Smoke-test in the same layer so a broken install fails.
# To re-pull the newest fnm on an already-built image: `docker build --no-cache` or `docker rmi` (per the
# SandboxImageBuilder note) — an unchanged image's fnm layer is not refreshed automatically.
RUN curl -fsSL https://fnm.vercel.app/install -o /tmp/fnm-install.sh \
  && bash /tmp/fnm-install.sh --install-dir /usr/local/bin --skip-shell \
  && rm /tmp/fnm-install.sh \
  && chmod 0755 /usr/local/bin/fnm \
  && fnm --version

# Modern CLI toolbelt the engine agents (Claude Code / Codex) reach for beyond the rg/fd/jq in the apt
# block above — installed as pinned, arch-aware static binaries into /usr/local/bin (NOT apt: several
# aren't packaged for bookworm, and pinning keeps a turn reproducible like the SDK/fnm pins). musl builds
# are used where a tool ships them so they run regardless of the glibc base. None shadow a system binary
# (ast-grep's `sg` short alias is deliberately NOT installed — the base already has shadow-utils' `sg`).
#   ast-grep   syntax-aware structural search/rewrite    sd         ergonomic sed alternative
#   yq         YAML/TOML/JSON surgery (jq for YAML)       shfmt      shell formatter
#   shellcheck shell linter (catches bad commands early)  actionlint GitHub Actions workflow linter
#   difftastic (difft) syntax-aware structural diffs      delta      syntax-highlighting diff pager
#   watchexec  re-run a command on file changes           hyperfine  benchmarking   scc  code stats
ARG SHELLCHECK_VERSION=0.11.0
ARG SD_VERSION=1.1.0
ARG YQ_VERSION=4.53.3
ARG DIFFTASTIC_VERSION=0.69.0
ARG SHFMT_VERSION=3.13.1
ARG ACTIONLINT_VERSION=1.7.12
ARG WATCHEXEC_VERSION=2.5.1
ARG SCC_VERSION=3.7.0
ARG HYPERFINE_VERSION=1.20.0
ARG DELTA_VERSION=0.19.2
ARG ASTGREP_VERSION=0.44.0
RUN set -eu; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) rust=x86_64; scc=x86_64 ;; \
    arm64) rust=aarch64; scc=arm64 ;; \
    *) echo "unsupported arch for CLI toolbelt: $arch" >&2; exit 1 ;; \
  esac; \
  gh=https://github.com; \
  # download to a file (no curl|tar pipe, so a bad URL fails the build via curl -f) then pluck the binary
  tarbin() { u="$1"; f="$2"; shift 2; d="$(mktemp -d)"; curl -fsSL "$u" -o "$d/a"; tar -x"$f" -f "$d/a" -C "$d"; \
    for b in "$@"; do install -m0755 "$(find "$d" -type f -name "$b" | head -n1)" "/usr/local/bin/$b"; done; rm -rf "$d"; }; \
  rawbin() { curl -fsSL "$1" -o "/usr/local/bin/$2"; chmod 0755 "/usr/local/bin/$2"; }; \
  tarbin "$gh/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.${rust}.tar.gz" z shellcheck; \
  tarbin "$gh/chmln/sd/releases/download/v${SD_VERSION}/sd-v${SD_VERSION}-${rust}-unknown-linux-musl.tar.gz" z sd; \
  tarbin "$gh/Wilfred/difftastic/releases/download/${DIFFTASTIC_VERSION}/difft-${rust}-unknown-linux-gnu.tar.gz" z difft; \
  tarbin "$gh/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_${arch}.tar.gz" z actionlint; \
  tarbin "$gh/watchexec/watchexec/releases/download/v${WATCHEXEC_VERSION}/watchexec-${WATCHEXEC_VERSION}-${rust}-unknown-linux-musl.tar.xz" J watchexec; \
  tarbin "$gh/boyter/scc/releases/download/v${SCC_VERSION}/scc_Linux_${scc}.tar.gz" z scc; \
  tarbin "$gh/sharkdp/hyperfine/releases/download/v${HYPERFINE_VERSION}/hyperfine-v${HYPERFINE_VERSION}-${rust}-unknown-linux-gnu.tar.gz" z hyperfine; \
  tarbin "$gh/dandavison/delta/releases/download/${DELTA_VERSION}/delta-${DELTA_VERSION}-${rust}-unknown-linux-gnu.tar.gz" z delta; \
  rawbin "$gh/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${arch}" yq; \
  rawbin "$gh/mvdan/sh/releases/download/v${SHFMT_VERSION}/shfmt_v${SHFMT_VERSION}_linux_${arch}" shfmt; \
  d="$(mktemp -d)"; curl -fsSL "$gh/ast-grep/ast-grep/releases/download/${ASTGREP_VERSION}/app-${rust}-unknown-linux-gnu.zip" -o "$d/a.zip"; \
    unzip -q "$d/a.zip" -d "$d"; install -m0755 "$(find "$d" -type f -name ast-grep | head -n1)" /usr/local/bin/ast-grep; rm -rf "$d"; \
  # smoke-test: every binary must resolve + run on THIS arch, so a wrong asset fails the build not a turn
  shellcheck --version >/dev/null; sd --version >/dev/null; difft --version >/dev/null; \
  actionlint --version >/dev/null; watchexec --version >/dev/null; scc --version >/dev/null; \
  hyperfine --version >/dev/null; delta --version >/dev/null; yq --version >/dev/null; \
  shfmt --version >/dev/null; ast-grep --version >/dev/null

# Cloud & infra CLIs the engine agents reach for during onboarding + builds. gcloud (+ gsutil/bq/GKE auth
# plugin) is apt-installed in the system-deps block above; the rest are pinned, arch-aware binary downloads
# (same download-to-file + smoke-test house pattern as the toolbelt). The prompt-kit drives terraform
# (`init`/`validate`/`plan`) and the Stripe CLI directly; aws v2 + kubectl + helm cover cloud-native repos.
# These are FLOORS — a repo needing another version installs it into the durable HOME (~/.local/bin) per the
# onboarding prompt. Bump: terraform via HashiCorp releases, kubectl via dl.k8s.io/release/stable.txt, helm
# + stripe via their GitHub latest; aws v2 tracks the vendor's latest (unversioned installer URL).
ARG TERRAFORM_VERSION=1.15.7
ARG KUBECTL_VERSION=v1.36.2
ARG HELM_VERSION=v4.2.2
ARG STRIPE_VERSION=1.43.6
RUN set -eu; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) stripe_arch=x86_64; aws_arch=x86_64 ;; \
    arm64) stripe_arch=arm64;  aws_arch=aarch64 ;; \
    *) echo "unsupported arch for cloud CLIs: $arch" >&2; exit 1 ;; \
  esac; \
  # terraform — single binary in a zip (amd64/arm64)
  d="$(mktemp -d)"; curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${arch}.zip" -o "$d/tf.zip"; \
    unzip -q "$d/tf.zip" -d "$d"; install -m0755 "$d/terraform" /usr/local/bin/terraform; rm -rf "$d"; \
  # kubectl — single binary (amd64/arm64)
  curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" -o /usr/local/bin/kubectl; chmod 0755 /usr/local/bin/kubectl; \
  # helm — tarball, binary under linux-<arch>/ (amd64/arm64)
  d="$(mktemp -d)"; curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz" -o "$d/helm.tgz"; \
    tar -xzf "$d/helm.tgz" -C "$d"; install -m0755 "$d/linux-${arch}/helm" /usr/local/bin/helm; rm -rf "$d"; \
  # stripe CLI — tarball (x86_64/arm64 naming), contains `stripe`
  d="$(mktemp -d)"; curl -fsSL "https://github.com/stripe/stripe-cli/releases/download/v${STRIPE_VERSION}/stripe_${STRIPE_VERSION}_linux_${stripe_arch}.tar.gz" -o "$d/stripe.tgz"; \
    tar -xzf "$d/stripe.tgz" -C "$d"; install -m0755 "$d/stripe" /usr/local/bin/stripe; rm -rf "$d"; \
  # aws cli v2 — official zip installer (x86_64/aarch64); installs under /usr/local/aws-cli + /usr/local/bin symlinks
  d="$(mktemp -d)"; curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o "$d/aws.zip"; \
    unzip -q "$d/aws.zip" -d "$d"; "$d/aws/install" --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli; rm -rf "$d"; \
  # smoke-test: every CLI (incl. the apt-installed gcloud) resolves + runs on THIS arch
  terraform version >/dev/null; kubectl version --client >/dev/null; helm version >/dev/null; \
  stripe version >/dev/null; aws --version >/dev/null; gcloud --version >/dev/null

# LSP toolchain: the in-sandbox `atlas-lsp-ts` MCP server (registered per-turn by the engine entrypoint)
# is atlas-lsp-server.mjs — our OWN MCP server that drives typescript-language-server DIRECTLY over LSP,
# giving the agent POSITION-based rename_symbol/references/definition/hover/diagnostics (see ADR 0004).
# typescript-language-server prefers a repo's OWN `typescript` (resolved from its node_modules) when
# present; the global `typescript` here is only the fallback for a repo that doesn't declare one — same
# "repo owns its own version, image just provides a floor" pattern as fnm/corepack above.
ARG TYPESCRIPT_VERSION=6.0.3
ARG TS_LANGUAGE_SERVER_VERSION=5.3.0
RUN npm install -g "typescript@${TYPESCRIPT_VERSION}" "typescript-language-server@${TS_LANGUAGE_SERVER_VERSION}" \
  && typescript-language-server --version >/dev/null

# Playwright + chromium (browser binary + its OS shared libs) baked so atlas-probe and every UI-validation
# run resolve a browser INSTANTLY on a cold box — the per-onboarding `npx playwright install --with-deps`
# stopgap (ticket #19) is retired by this layer. Installed into a dedicated lib dir (same pattern as the
# engine runtime at /usr/local/lib/atlas) rather than the Node global, so atlas-probe resolves it via
# createRequire with no global NODE_PATH leaking into repo builds. PLAYWRIGHT_BROWSERS_PATH points the
# browser at a system dir so root + the host-exec user resolve the same binary — but it is set ONLY inside
# this build RUN (not a persistent ENV): a baked ENV would leak into a connected repo's OWN Playwright,
# forcing it to resolve browsers from this root-owned dir and breaking its `playwright install` with
# EACCES. atlas-probe re-sets this env at runtime (see its header) before it requires playwright, so repo
# builds keep the default user-writable cache (~/.cache/ms-playwright). Pinned to the current Playwright
# release line (1.61.x). --with-deps apt-installs the OS libs (libglib/libcairo/libcups/libgbm/fonts) the
# slim base omits. The final smoke test actually LAUNCHES headless chromium (not just resolves the module)
# so a missing shared lib fails the build, not a turn.
ARG PLAYWRIGHT_VERSION=1.61.1
RUN export PLAYWRIGHT_BROWSERS_PATH=/usr/lib/playwright \
  && mkdir -p /usr/local/lib/atlas-probe \
  && cd /usr/local/lib/atlas-probe \
  && printf '{"name":"atlas-probe-runtime","private":true}\n' > package.json \
  && npm install "playwright@${PLAYWRIGHT_VERSION}" \
  && ./node_modules/.bin/playwright install --with-deps chromium \
  && ./node_modules/.bin/playwright --version >/dev/null \
  && node -e "const{chromium}=require('/usr/local/lib/atlas-probe/node_modules/playwright');chromium.launch({headless:true,args:['--no-sandbox']}).then(b=>b.close()).then(()=>console.log('chromium launch OK')).catch(e=>{console.error(e);process.exit(1)})" \
  && rm -rf /var/lib/apt/lists/*

# atlas-lsp-server — our direct LSP-client MCP server (spawned via node by the engine for `atlas-lsp-ts`).
# It speaks MCP to the SDK and LSP to typescript-language-server, re-rooting the server at the nearest
# tsconfig.json of each tool call's target file. Replaced mcp-language-server (whose name-based
# references/definition were unreliable) — see ADR 0004 addendum + the script's own header.
COPY atlas-lsp-server.mjs /usr/local/lib/atlas/atlas-lsp-server.mjs
RUN node --check /usr/local/lib/atlas/atlas-lsp-server.mjs

# Trust every worktree for ALL users (system-level → covers both root, which runs sandbox-init.sh as PID 1,
# and the host-uid exec user that owns the bind-mounted worktree). Without this, in-sandbox git reports
# "detected dubious ownership" whenever root and the host-uid user touch the same worktree. Sandboxes are
# single-tenant throwaways, so a blanket safe.directory is fine here (never do this on a shared host).
RUN git config --system --add safe.directory '*'

# Engine runtime: the two SDKs (each ships its native CLI via a per-platform package) + the bundled
# atlas engine entrypoint. Pinned to match the host so a turn behaves identically (keep in sync; D5
# may promote these to build args). The host passes secrets as exec env, never baked here.
ARG CLAUDE_SDK_VERSION=0.3.201
ARG CODEX_SDK_VERSION=0.137.0
# Installed with plain `npm` (not pnpm): an isolated two-package install into a standalone package.json,
# consumed only by ESM `import` from the .mjs bundles below — a flat node_modules resolves identically and
# more forgivingly than pnpm's symlink layout, and it keeps this build free of any activated-pnpm ordering.
RUN mkdir -p /usr/local/lib/atlas \
  && cd /usr/local/lib/atlas \
  && printf '{"name":"atlas-engine-runtime","private":true}\n' > package.json \
  && npm install "@anthropic-ai/claude-agent-sdk@${CLAUDE_SDK_VERSION}" "@openai/codex-sdk@${CODEX_SDK_VERSION}"
COPY engine-entrypoint.mjs /usr/local/lib/atlas/engine-entrypoint.mjs
# The new webpacked engine app is baked as a build-only artifact for now (not yet exec'd — turn execution
# over Redis Streams lands in a later thread; see atlas-engine-turn below, still pointed at the old,
# fully-functional esbuild entrypoint until that thread's validation gate passes).
COPY engine-app.js /usr/local/lib/atlas/engine-app.js
COPY engine-app.js.map /usr/local/lib/atlas/engine-app.js.map
# The Codex MCP tool-bridge server (spawned by codex via config.toml). Baked as a fallback; the host
# bind-mounts the live re-bundled copy over it, same hot-reload contract as engine-entrypoint.mjs.
COPY mcp-bridge-server.mjs /usr/local/lib/atlas/mcp-bridge-server.mjs
# The persistent MCP hub (launched by sandbox-init.sh). Baked as a fallback; the host bind-mounts the live
# re-bundled copy over it, same hot-reload contract as engine-entrypoint.mjs.
COPY mcp-hub-server.mjs /usr/local/lib/atlas/mcp-hub-server.mjs
RUN node --check /usr/local/lib/atlas/mcp-hub-server.mjs
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

# atlas-tx: the in-sandbox transcript reader (sessions/path/cat/show/grep) the agent — and an autonomous
# halt/completion wake — drives via Bash to read a build/brain lane's raw JSONL under /.atlas. Read-only.
COPY atlas-tx /usr/local/bin/atlas-tx
RUN chmod +x /usr/local/bin/atlas-tx

# atlas-probe: the browser-grade accessibility probe the agent drives via Bash — loads a preview URL in
# baked headless chromium and returns a structured verdict + blocker classification (dns/bind_ip/port/
# dev_origin/cors/api_base_url/cookie/blank). Resolves the baked playwright above via createRequire.
COPY atlas-probe /usr/local/bin/atlas-probe
RUN chmod +x /usr/local/bin/atlas-probe \
  && node --check /usr/local/bin/atlas-probe

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
