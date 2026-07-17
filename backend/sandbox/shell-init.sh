# Sourced by every non-interactive agent bash via BASH_ENV (set in the sandbox Dockerfile). Activates fnm
# so the agent's build shells run the Node version the REPO pins (.nvmrc / .node-version), while the engine
# stays on the image's Node 22 (its launcher calls node by absolute path). Kept fast + idempotent: it runs
# on every command shell.
#
# Node versions live in the SHARED fnm store (FNM_DIR=/.atlas/fnm, a host dir bound across all threads), so
# a pinned version is downloaded ONCE globally and reused. Errors are swallowed: a repo with no version
# file simply runs the image's base Node 22; a download hiccup falls back to it too.

# ENGINE-PROTECTION NICE GAP. The engine turn (node, nice 0) and the agent's build/test shells share ONE
# container. The engine is latency-sensitive but light — it mostly sleeps waiting on the model and just needs
# to be scheduled PROMPTLY when a Redis event or heartbeat is due. A heavy agent build (tsc/vitest/webpack
# workers) can otherwise pin every core and starve the engine's event loop long enough to miss its 5s
# heartbeat (see redis-engine-runner.ts TAIL_ALIVE_GRACE_CEILING_MS). Renice THIS shell (and thus every
# command it spawns — nice is inherited across fork) to a positive value, so under contention CFS lets the
# nice-0 engine preempt the agent's batch load on wakeup. A non-root user can only RAISE its own nice (lower
# priority), which is exactly what we want and needs no privilege/cgroup. Guarded + exported so nested agent
# shells (already nice-inherited) skip the redundant call; swallow errors so a missing renice never breaks a
# shell. ATLAS_AGENT_NICE is baked in the image (Dockerfile ENV, default 10) and overridable per-sandbox.
if [ -z "${ATLAS_NICE_APPLIED:-}" ]; then
  export ATLAS_NICE_APPLIED=1
  renice "${ATLAS_AGENT_NICE:-10}" -p "$$" >/dev/null 2>&1 || true
fi

# Put fnm on PATH + install the cd hook, then resolve + (download-and-cache if missing) the repo's pinned
# version in CWD. The SDK Bash tool starts shells in the worktree, so this resolves at shell startup.
eval "$(fnm env --use-on-cd --shell bash)" 2>/dev/null || true
# Redirect STDOUT too, not just stderr: `fnm use` prints "Using Node vX" to stdout, and because this file
# is sourced via BASH_ENV at the start of EVERY non-interactive bash, that line would otherwise be prepended
# to the stdout of every agent command — corrupting shell-composable CLIs whose output is piped (e.g.
# `atlas-tx cat <sid> | jq`, `rg foo "$(atlas-tx path <sid>)"`). The version switch is a filesystem/PATH
# side effect, unaffected by silencing the message.
fnm use --install-if-missing >/dev/null 2>&1 || true

# fnm just prepended the repo-selected Node's bin. Re-prepend the image-pinned corepack shims so `pnpm`/
# `yarn` route through corepack@0.34.6 (modern signing keys), NOT the selected Node's possibly-old bundled
# corepack (pre-0.31 fails pnpm signature verification). The shims are Node-version-agnostic launchers;
# corepack still resolves the repo's OWN pnpm version. The guard keeps PATH from growing across nested shells.
case ":$PATH:" in *":/opt/corepack-shims:"*) ;; *) export PATH="/opt/corepack-shims:$PATH" ;; esac

# direnv: honor the repo's own `.envrc` (e.g. gcloud CLOUDSDK_CONFIG → a persistent .gcloud mount). The
# SDK Bash tool runs one-shot `bash -c` (non-interactive, no prompt), so the usual prompt hook never fires
# — instead we ALLOW the trusted worktree's .envrc and apply its exports directly with `direnv export`.
#
# RECURSION GUARD IS LOAD-BEARING: `BASH_ENV` is set globally (image-wide), and `direnv export` itself
# forks a bash subprocess to evaluate `.envrc` — that subprocess ALSO inherits BASH_ENV, so without a
# guard it re-sources this file, calls `direnv export` again, forks again, forever (a fork bomb; verified
# live — a single shell start ballooned to 2800+ processes and killed the sandbox). Exporting the guard
# BEFORE calling direnv, so the inner subshell inherits it and skips this block entirely.
if [ -z "${ATLAS_DIRENV_GUARD:-}" ] && command -v direnv >/dev/null 2>&1 && [ -f "$PWD/.envrc" ]; then
  export ATLAS_DIRENV_GUARD=1
  direnv allow "$PWD" 2>/dev/null || true
  eval "$(direnv export bash 2>/dev/null)" || true
fi
