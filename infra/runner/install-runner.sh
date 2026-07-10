#!/usr/bin/env bash
# install-runner.sh — Install N self-hosted GitHub Actions runners on the Atlas box.
#
# Run as root (or via sudo) on the production box. Installs the shared runner user, the
# systemd template unit, and N runner layouts at /opt/actions-runner-1 .. -N. Each layout
# is registered manually (one-time token per instance) and started as actions-runner@<i>.
#
#   sudo bash infra/runner/install-runner.sh [COUNT]     # COUNT defaults to 3
#
# After running, register EACH instance with its own fresh token, then enable it:
#   sudo -u gha-runner /opt/actions-runner-1/config.sh \
#       --url https://github.com/<owner>/<repo> \
#       --token <RUNNER_REGISTRATION_TOKEN> \
#       --name atlas-box-1 \
#       --labels self-hosted,atlas-box \
#       --unattended
#   systemctl enable --now actions-runner@1
#
# Each token is one-time, from: GitHub repo → Settings → Actions → Runners → New self-hosted runner
#
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────────
# Pinned + verified 2026-07-05: downloaded the release asset, confirmed its SHA-256 matched
# GitHub's published release-notes checksum, then computed this SHA-512 from that same verified file.
GHA_RUNNER_VERSION="2.335.1"
GHA_RUNNER_SHA512="6bea31dc8fd555054e1daf356e9a0707e4f1dde5bfac6bbf63e14ed56daa024fae6b8b58bb39dd6c5ff3e82e768004772444a942b44f8a8c9fe9fb893716211e"
GHA_RUNNER_ARCH="linux-x64"
GHA_RUNNER_USER="gha-runner"
# Number of parallel runner instances to lay out. All share the self-hosted,atlas-box
# label so any queued job lands on whichever instance is free. Override via argv[1].
GHA_RUNNER_COUNT="${1:-3}"

# Fail fast with a clear message if the checksum placeholder wasn't filled in — otherwise the script
# downloads ~100MB and then dies with a cryptic sha512sum mismatch.
if [[ "$GHA_RUNNER_SHA512" == CHANGEME* ]]; then
    echo "[install-runner] ERROR: set GHA_RUNNER_SHA512 to the SHA-512 from the runner release page first." >&2
    exit 1
fi

# ── Create unprivileged runner user (once) ────────────────────────────────────────
if ! id "$GHA_RUNNER_USER" &>/dev/null; then
    useradd --system --create-home --shell /bin/bash "$GHA_RUNNER_USER"
    echo "[install-runner] Created user: $GHA_RUNNER_USER"
fi

# Add to docker group so deploy.sh (and CI docker builds) can call docker.
# SECURITY NOTE: docker group membership is root-equivalent — see runner/README.md.
if ! groups "$GHA_RUNNER_USER" | grep -q docker; then
    usermod -aG docker "$GHA_RUNNER_USER"
    echo "[install-runner] Added $GHA_RUNNER_USER to docker group."
fi

# Give the runner user write access to /srv/atlas/state so deploy.sh can update state files.
chown -R "$GHA_RUNNER_USER:$GHA_RUNNER_USER" /srv/atlas/state 2>/dev/null || true

# ── Install systemd template unit (once) ──────────────────────────────────────────
echo "[install-runner] Installing systemd template unit ..."
cp "$(dirname "$0")/actions-runner@.service" /etc/systemd/system/actions-runner@.service
systemctl daemon-reload

# ── Download, verify, and extract N runner layouts ────────────────────────────────
RUNNER_TAR="actions-runner-${GHA_RUNNER_ARCH}-${GHA_RUNNER_VERSION}.tar.gz"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${GHA_RUNNER_VERSION}/${RUNNER_TAR}"

echo "[install-runner] Downloading runner v${GHA_RUNNER_VERSION} ..."
curl -fsSL "$RUNNER_URL" -o "/tmp/$RUNNER_TAR"

echo "[install-runner] Verifying checksum ..."
echo "${GHA_RUNNER_SHA512}  /tmp/${RUNNER_TAR}" | sha512sum --check

for i in $(seq 1 "$GHA_RUNNER_COUNT"); do
    RUNNER_HOME="/opt/actions-runner-$i"
    if [[ -f "$RUNNER_HOME/config.sh" ]]; then
        echo "[install-runner] Instance $i already laid out at $RUNNER_HOME — skipping extract."
        continue
    fi
    echo "[install-runner] Extracting instance $i to $RUNNER_HOME ..."
    mkdir -p "$RUNNER_HOME"
    tar xzf "/tmp/$RUNNER_TAR" -C "$RUNNER_HOME"
    chown -R "$GHA_RUNNER_USER:$GHA_RUNNER_USER" "$RUNNER_HOME"
done

rm "/tmp/$RUNNER_TAR"

echo ""
echo "=== Next steps (per instance 1..$GHA_RUNNER_COUNT) ==="
echo ""
echo "1. Register each runner with a fresh one-time token from the repo Runners page:"
echo "   sudo -u $GHA_RUNNER_USER /opt/actions-runner-<i>/config.sh \\"
echo "       --url https://github.com/<owner>/<repo> \\"    # TODO: replace <owner>/<repo>
echo "       --token <RUNNER_REGISTRATION_TOKEN> \\"
echo "       --name atlas-box-<i> \\"
echo "       --labels self-hosted,atlas-box \\"
echo "       --unattended"
echo ""
echo "2. Enable + start each instance:"
echo "   systemctl enable --now actions-runner@<i>"
echo "   (e.g. actions-runner@1 actions-runner@2 actions-runner@3)"
echo ""
echo "3. Verify:"
echo "   systemctl status 'actions-runner@*'"
echo "   journalctl -fu actions-runner@1"
