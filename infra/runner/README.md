# Atlas self-hosted GitHub Actions runner

The deploy workflow (`deploy.yml`) runs on `[self-hosted, atlas-box]` — a runner
installed on the production OVH box.

## Setup

1. `sudo bash infra/runner/install-runner.sh` — creates the `gha-runner` user,
   downloads and verifies the runner binary, installs the systemd service.

2. Register the runner (one-time):
   ```
   sudo -u gha-runner /opt/actions-runner/config.sh \
       --url https://github.com/dennisofficial/ai-crew \
       --token <RUNNER_REGISTRATION_TOKEN> \
       --labels self-hosted,atlas-box \
       --unattended
   ```
   Get the registration token from:
   GitHub repo → Settings → Actions → Runners → New self-hosted runner

3. Start: `systemctl start actions-runner.service`

## Security caveats

**Read this section carefully before running the runner.**

### Docker socket = root-equivalent

The `gha-runner` user is in the `docker` group, which gives it unrestricted access
to `/var/run/docker.sock`. This is equivalent to root access on the host — any
workflow job running on this runner can mount host paths, exec into containers, and
escalate to root.

Mitigations in place:
- **Private repo only.** Only this repository's workflows can queue jobs on this
  runner. No public repos, no forked repos.
- **Protected GitHub Environment.** The `deploy.yml` workflow declares
  `environment: production`. In the GitHub repository settings, add a required
  reviewer for the `production` environment so no deploy runs without explicit
  human approval.
- **`main` branch only.** `deploy.yml` includes `if: github.ref == 'refs/heads/main'`
  so the deploy job never runs on PR branches or forks.
- **Never add this runner to a public repo.** If the repo is ever made public,
  remove the runner immediately — pull-request forks can run arbitrary code on it.

### Secrets

The runner itself does not have access to `/srv/atlas/secrets/atlas.env` — that
file is readable by the `atlas` user only. The `deploy.sh` script (run as
`gha-runner`) reads it only for POSTGRES_* vars needed by the migrator container.
If you want to tighten this further, source only the needed vars inline rather than
the full secrets file.

### GitHub Environment required reviewer

Set up a required reviewer in GitHub:
- Repo → Settings → Environments → New environment → Name: `production`
- Enable "Required reviewers" and add yourself (Dennis).
- This ensures every deploy — even from the CI workflow — requires your explicit
  approval before the deploy job runs on the box.
