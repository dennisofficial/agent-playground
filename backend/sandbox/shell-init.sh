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
