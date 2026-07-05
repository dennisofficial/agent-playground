#!/usr/bin/env bash
# install-runner.sh — Install a self-hosted GitHub Actions runner on the Atlas box.
#
# Run as root (or via sudo) on the production box.
# After running this script, configure the runner token:
#   sudo -u gha-runner /opt/actions-runner/config.sh \
#       --url https://github.com/<owner>/<repo> \
#       --token <RUNNER_REGISTRATION_TOKEN> \
#       --labels self-hosted,atlas-box \
#       --unattended
#
# The runner token is a one-time token from:
#   GitHub repo → Settings → Actions → Runners → New self-hosted runner
#
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────────
# Pinned + verified 2026-07-05: downloaded the release asset, confirmed its SHA-256 matched
# GitHub's published release-notes checksum, then computed this SHA-512 from that same verified file.
GHA_RUNNER_VERSION="2.335.1"
GHA_RUNNER_SHA512="6bea31dc8fd555054e1daf356e9a0707e4f1dde5bfac6bbf63e14ed56daa024fae6b8b58bb39dd6c5ff3e82e768004772444a942b44f8a8c9fe9fb893716211e"
GHA_RUNNER_ARCH="linux-x64"
GHA_RUNNER_USER="gha-runner"
GHA_RUNNER_HOME="/opt/actions-runner"

# Fail fast with a clear message if the checksum placeholder wasn't filled in — otherwise the script
# downloads ~100MB and then dies with a cryptic sha512sum mismatch.
if [[ "$GHA_RUNNER_SHA512" == CHANGEME* ]]; then
    echo "[install-runner] ERROR: set GHA_RUNNER_SHA512 to the SHA-512 from the runner release page first." >&2
    exit 1
fi

# ── Create unprivileged runner user ──────────────────────────────────────────────
if ! id "$GHA_RUNNER_USER" &>/dev/null; then
    useradd --system --create-home --shell /bin/bash "$GHA_RUNNER_USER"
    echo "[install-runner] Created user: $GHA_RUNNER_USER"
fi

# Add to docker group so deploy.sh can call docker compose / docker run.
# SECURITY NOTE: docker group membership is root-equivalent — see runner/README.md.
if ! groups "$GHA_RUNNER_USER" | grep -q docker; then
    usermod -aG docker "$GHA_RUNNER_USER"
    echo "[install-runner] Added $GHA_RUNNER_USER to docker group."
fi

# Give the runner user write access to /srv/atlas so deploy.sh can update state files.
chown -R "$GHA_RUNNER_USER:$GHA_RUNNER_USER" /srv/atlas/state 2>/dev/null || true

# ── Download and verify runner ───────────────────────────────────────────────────
RUNNER_TAR="actions-runner-${GHA_RUNNER_ARCH}-${GHA_RUNNER_VERSION}.tar.gz"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${GHA_RUNNER_VERSION}/${RUNNER_TAR}"

mkdir -p "$GHA_RUNNER_HOME"
chown "$GHA_RUNNER_USER:$GHA_RUNNER_USER" "$GHA_RUNNER_HOME"

echo "[install-runner] Downloading runner v${GHA_RUNNER_VERSION} ..."
curl -fsSL "$RUNNER_URL" -o "/tmp/$RUNNER_TAR"

echo "[install-runner] Verifying checksum ..."
echo "${GHA_RUNNER_SHA512}  /tmp/${RUNNER_TAR}" | sha512sum --check

echo "[install-runner] Extracting to $GHA_RUNNER_HOME ..."
tar xzf "/tmp/$RUNNER_TAR" -C "$GHA_RUNNER_HOME"
chown -R "$GHA_RUNNER_USER:$GHA_RUNNER_USER" "$GHA_RUNNER_HOME"
rm "/tmp/$RUNNER_TAR"

# ── Install systemd service ──────────────────────────────────────────────────────
echo "[install-runner] Installing systemd service ..."
cp "$(dirname "$0")/actions-runner.service" /etc/systemd/system/actions-runner.service
systemctl daemon-reload
systemctl enable actions-runner.service

echo ""
echo "=== Next steps ==="
echo ""
echo "1. Register the runner with your GitHub repo (one-time token):"
echo "   sudo -u $GHA_RUNNER_USER $GHA_RUNNER_HOME/config.sh \\"
echo "       --url https://github.com/<owner>/<repo> \\"    # TODO: replace <owner>/<repo>
echo "       --token <RUNNER_REGISTRATION_TOKEN> \\"
echo "       --labels self-hosted,atlas-box \\"
echo "       --unattended"
echo ""
echo "2. Start the service:"
echo "   systemctl start actions-runner.service"
echo ""
echo "3. Verify:"
echo "   systemctl status actions-runner.service"
echo "   journalctl -fu actions-runner.service"
