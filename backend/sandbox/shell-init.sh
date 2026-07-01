# Sourced by every non-interactive agent bash via BASH_ENV (set in the sandbox Dockerfile). Activates fnm
# so the agent's build shells run the Node version the REPO pins (.nvmrc / .node-version), while the engine
# stays on the image's Node 22 (its launcher calls node by absolute path). Kept fast + idempotent: it runs
# on every command shell.
#
# Node versions live in the SHARED fnm store (FNM_DIR=/atlas-fnm, a host dir bound across all threads), so
# a pinned version is downloaded ONCE globally and reused. Errors are swallowed: a repo with no version
# file simply runs the image's base Node 22; a download hiccup falls back to it too.

# Put fnm on PATH + install the cd hook, then resolve + (download-and-cache if missing) the repo's pinned
# version in CWD. The SDK Bash tool starts shells in the worktree, so this resolves at shell startup.
eval "$(fnm env --use-on-cd --shell bash)" 2>/dev/null || true
fnm use --install-if-missing 2>/dev/null || true

# Ensure pnpm/yarn shims exist for whatever Node is now active (corepack shims are node-version-agnostic).
corepack enable 2>/dev/null || true

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
