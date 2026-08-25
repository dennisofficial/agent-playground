# Atlas self-hosted GitHub Actions runners

Both **CI** (`ci.yml`) and **deploy** (`deploy.yml`) run on `[self-hosted, atlas-box]` —
a pool of runner instances installed on the production OVH box. Any queued job lands on
whichever instance is free, so `typecheck` + `unit-tests` run in parallel and CI doesn't
serialize behind deploys.

## Setup

1. `sudo bash infra/runner/install-runner.sh [COUNT]` — creates the `gha-runner` user,
   installs the systemd template unit, downloads + verifies the runner binary, and lays
   out `COUNT` runner instances at `/opt/actions-runner-1 .. -N` (`COUNT` defaults to 3).

2. Register each instance (one-time — each needs its own fresh token):
   ```
   sudo -u gha-runner /opt/actions-runner-<i>/config.sh \
       --url https://github.com/<owner>/<repo> \
       --token <RUNNER_REGISTRATION_TOKEN> \
       --name atlas-box-<i> \
       --labels self-hosted,atlas-box \
       --unattended
   ```
   Get each token from: GitHub repo → Settings → Actions → Runners → New self-hosted runner.

3. Enable + start each instance:
   ```
   systemctl enable --now actions-runner@1 actions-runner@2 actions-runner@3
   ```

4. Verify: `systemctl status 'actions-runner@*'` (all `active (running)`) and confirm 3
   idle `atlas-box` runners on the repo Runners page.

## Security caveats

**Read this section carefully before running the runners.**

### Docker socket = root-equivalent

The `gha-runner` user is in the `docker` group, which gives unrestricted access to
`/var/run/docker.sock` — equivalent to root on the host. Any job on these runners can
mount host paths, exec into containers, and escalate to root.

### CI now runs on `pull_request` — PR code executes on the production box

Previously only the `main`-only, reviewer-gated `deploy.yml` ran here. Now `ci.yml`
(`changes` / `typecheck` / `unit-tests` / `ci-gate` / `build-images`) also runs on these
runners, including on **`pull_request`**. That means PR code runs on the production box
with root-equivalent Docker access.

Mitigations in place:
- **Private repo only.** Only this repository's workflows can queue jobs on these
  runners. No public repos, no forked-repo PRs.
- **Never make the repo public with runners attached.** If the repo is ever made public,
  **remove the runners immediately** — fork PRs would run arbitrary code on prod.
- **`main` branch only for deploy.** `deploy.yml` includes
  `if: github.ref == 'refs/heads/main'`, so the deploy job never runs on PR branches.
- **Protected `production` GitHub Environment.** `deploy.yml` declares
  `environment: production` with a required reviewer, so no deploy runs without explicit
  human approval. Note: this reviewer gate applies to **deploy only** — CI jobs are not
  reviewer-gated.

### Secrets

The runners do not have access to `/srv/atlas/secrets/atlas.env` — that file is readable
by the `atlas` user only. `deploy.sh` (run as `gha-runner`) reads it only for the
POSTGRES_* vars the migrator container needs. CI jobs need no app secrets — only GHCR
access via the auto-provided `GITHUB_TOKEN`.

## Notes

- **Shared runners, uniform full checkouts.** CI and deploy share the `atlas-box`
  runner pool and the same per-repo `_work/<repo>/<repo>` checkout dir (self-hosted
  runners reuse `_work` between jobs). Both must therefore do a **full** checkout —
  `deploy.yml` used to sparse-checkout `infra/` only, but `actions/checkout@v4` does not
  clear a leftover sparse cone, so a sparse deploy would pin the tree and break the next
  CI job's `.github/actions` resolution. Deploy now does a full checkout too. If a runner
  ever gets stuck with a stale sparse cone, clear it once per runner:
  `sudo -u gha-runner git -C /opt/actions-runner-<i>/_work/<repo>/<repo> sparse-checkout disable`.
- **Rollout order:** provision + prove the runners healthy (`systemctl restart
  actions-runner@1` reconnects; a real deploy still succeeds) **before** relying on them
  for CI, and keep at least one `atlas-box` runner online throughout any migration so
  `deploy.yml` is never left without a runner.
- **Sizing:** N runners means up to N concurrent heavy jobs (Docker builds + test runs)
  competing with the live service for the box's CPU/RAM. Drop the count if memory
  pressure appears.
