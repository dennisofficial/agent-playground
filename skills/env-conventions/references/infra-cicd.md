# Env in infrastructure & CI/CD

How environment values and the dotenvx private key flow through Docker, Terraform,
and Google Cloud Build / Cloud Run in these repos. Reference patterns from
cubix-infra and rs-crm-app (mls-studio is mid-bootstrap — see the note at the end).

## Principle

- `.env.*.enc` ship *into* the build/deploy context; `.env.keys` never does.
- The dotenvx **private key lives in GCP Secret Manager**. It is injected:
  - at **runtime** for NestJS backends (decrypt at container start), and
  - at **build time** for Next.js apps (because `NEXT_PUBLIC_*` is inlined into the bundle during `next build`, so runtime env can't change it).
- The key env var name is computed per environment: `DOTENV_PRIVATE_KEY_${upper(TIER)}_ENC`.

## Docker (multi-stage)

**Backend — decrypt at container start, no key baked into the image:**
```dockerfile
FROM node:22.13-alpine AS backend
ARG APP_ENV=production
RUN npm i -g pnpm @dotenvx/dotenvx           # match the repo's pinned version
ENV APP_ENV=$APP_ENV NODE_ENV=production TZ=UTC
# ... copy build + the encrypted env file ...
CMD ["sh","-c","dotenvx run --strict -f .env.${APP_ENV}.enc -- node dist/<svc>/main --enable-source-maps"]
```
Cloud Run supplies `DOTENV_PRIVATE_KEY_<TIER>_ENC` as an env var at runtime.

**Next.js site/client — decrypt at build time via a BuildKit secret:**
```dockerfile
ENV NEXT_PUBLIC_APP_ENV=$APP_ENV            # NEXT_PUBLIC_* must be set at build
RUN --mount=type=secret,id=dotenv_private_key \
    APP_ENV_KEY="$(printf '%s' "$APP_ENV" | tr '[:lower:]-' '[:upper:]_')" && \
    env "DOTENV_PRIVATE_KEY_${APP_ENV_KEY}_ENC=$(cat /run/secrets/dotenv_private_key)" \
      dotenvx run --strict -f .env.${APP_ENV}.enc -- pnpm build
```
The site runtime stage may re-install dotenvx and re-decrypt at start for server.js.

## docker-compose (local only)

Compose files hardcode **local-only plaintext** credentials inline under
`environment:` (e.g. `POSTGRES_PASSWORD: <app>_local`), with a comment that prod
creds come from Secret Manager. There is **no `env_file:`** and **no `.enc` mount**
in compose — local app processes get their env from `pnpm env:inject`, not compose.

## Terraform

Per-environment root is an npm package whose `terraform` script wraps the binary in
dotenvx:
```jsonc
// infra/terraform/environments/<tier>/package.json
"terraform": "dotenvx run -f .env.<tier>.enc -fk ../../.env.keys -- terraform",
"init": "pnpm terraform init", "plan": "pnpm terraform plan", "apply": "pnpm terraform apply"
```
Layout: `infra/terraform/{modules/, environments/<tier>/, .env.keys, terraform-readme.md}`.
Committed `.env.<tier>.enc` lives inside each env root. The decrypted env provides
`GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDFLARE_API_TOKEN`, and `TF_VAR_*`. The
terraform `.gitignore` commits `.enc` + lockfiles but excludes `.env.keys`,
`.credentials/`, `*.tfvars`, `.terraform/`. Do **not** add `--overload` here — TF-provided
env should stay authoritative.

## Cloud Build

**Backend** cloudbuild has no build secret; the gcloud deploy step overrides the
container command with the same dotenvx invocation:
```yaml
- --command=dotenvx
- --args=^|^run|--strict|-f|.env.${_APP_ENV}.enc|--|node|dist/<svc>/main
```
Migrations run `dotenvx run --strict -f .env.${_APP_ENV}.enc -- ... typeorm migration:run`.

**Next.js** cloudbuild pulls the key from Secret Manager at build time:
```yaml
# in the build step:
secretEnv: [DOTENV_PRIVATE_KEY]
args: [ ..., "--secret", "id=dotenv_private_key,env=DOTENV_PRIVATE_KEY" ]
availableSecrets:
  secretManager:
    - versionName: projects/$PROJECT_ID/secrets/${_DOTENV_PRIVATE_KEY_SECRET}/versions/latest
      env: DOTENV_PRIVATE_KEY
```

## Cloud Run (Terraform wires the key)

```hcl
# modules/cloud-run.tf
env {
  name = local.dotenv_private_key_env_name           # DOTENV_PRIVATE_KEY_<TIER>_ENC
  value_source { secret_key_ref { secret = each.value.dotenv_secret_id; version = "latest" } }
}
# modules/locals.tf
dotenv_private_key_env_name = "DOTENV_PRIVATE_KEY_${upper(local.dotenv_environment)}_ENC"
```
Deploy triggers select environment by branch regex: prod = `^main$`, non-prod =
`^staging$` (cubix) / `^dev$` (rs-crm).

## GitHub Actions (minimal)

Not the deploy engine. cubix has one build-only CI (placeholder env, no secrets);
rs-crm has one emails→Resend deploy that is the *only* GH-Actions consumer of a
dotenvx key (`DOTENV_PRIVATE_KEY: ${{ secrets.EMAILS_DOTENV_KEY }}`, GCP auth via
Workload Identity Federation). If a repo needs GH-Actions to decrypt, inject the
private key as a repo secret named `DOTENV_PRIVATE_KEY` (or `<SCOPE>_DOTENV_KEY`).

## .gcloudignore / .dockerignore

Same rule everywhere — ship encrypted env, exclude keys/plaintext:
```
.env
.env.*
!**/.env.*.enc
**/.env.keys
**/.env.personal
**/.env.local
**/.env.*.local
```

## mls-studio note

mls-studio is mid-bootstrap: **no Dockerfile, no cloudbuild.yaml, no terraform
`.enc`/`.env.keys` yet.** Its Cloud Build triggers are gated behind
`var.enable_cloud_build`, and its Terraform uses plain `terraform.tfvars` / `TF_VAR_*`
(no dotenvx wrapper) — the one place TF isn't dotenvx-wrapped. When building out its
deploy, mirror the cubix/rs-crm patterns above.
