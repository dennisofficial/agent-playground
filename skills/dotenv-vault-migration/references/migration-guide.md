# Dotenv Vault To Dotenvx Migration Guide

This guide is generic. Apply it to any project that uses `dotenv-vault`, `.env.vault`, `DOTENV_KEY`, or `dotenv` config calls that include vault files.

As of 2026-05-13, `npm view @dotenvx/dotenvx version` returned `1.65.0`. Refresh this before version-specific work.

## 1. Inventory

Run searches from the repository root. Do not print env values.

```sh
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' \
  'dotenv-vault|\\.env\\.vault|DOTENV_KEY|dotenv/config|from .dotenv.|require\\(.dotenv'

rg --files -g '.env*' -g '.gitignore' -g '.dockerignore' -g '.easignore' \
  -g 'Dockerfile*' -g '*compose*.yml' -g '*compose*.yaml' -g '.github/workflows/**'

git ls-files '.env*' '**/.env*'
```

Classify every app/package that owns env files:

- Existing plaintext source files: `.env`, `.env.local`, `.env.personal`, environment-specific files.
- Existing vault files: `.env.vault`.
- Existing private key transport: `DOTENV_KEY`, GitHub secrets, Docker args, local shell exports.
- Runtime loading: package scripts, framework config files, bootstrap files, CLI scripts.
- Container and deployment paths: Dockerfiles, Compose files, CI workflows, Kubernetes/Helm, EAS, Cloud Run, or similar.

## 2. Tool-First Migration Check

The official docs may mention vault migration commands, but the installed CLI can differ. Check support before relying on them.

```sh
npm view @dotenvx/dotenvx version
npx @dotenvx/dotenvx@latest --version
npx @dotenvx/dotenvx@latest ext vault migrate --help
npx @dotenvx/dotenvx@latest vault migrate --help
```

Treat output containing `unknown command` as unsupported even if the command exits `0`.

If a migration command is supported:

1. Snapshot current env files outside git-tracked paths or through normal VCS status review.
2. Run the migration command in one app/package directory at a time.
3. Inspect filenames, key names, and ignore-rule changes without printing values.
4. Normalize output to this skill's defaults if needed: `.env.*.enc` files plus co-located `.env.keys`.
5. Continue with runtime, CI, and validation steps below.

If the command is unsupported or ambiguous, use the manual fallback.

## 3. Manual Fallback

Materialize plaintext source files locally:

- Prefer existing ignored plaintext files if they are current.
- Otherwise, use the old project commands such as `dotenv-vault pull development .env -y` only to produce local source files.
- Do not commit generated plaintext files.
- Do not paste file contents into the conversation or logs.

Create encrypted dotenvx files per app/package:

```sh
cp .env.local .env.local.enc
dotenvx encrypt -f .env.local.enc

cp .env .env.development.enc
dotenvx encrypt -f .env.development.enc
```

Use the repository's real environments. Common targets are:

- `.env.local.enc`
- `.env.development.enc`
- `.env.staging.enc`
- `.env.production.enc`

Keep `.env.keys` next to those files by default. This preserves ergonomic commands from the app directory without `-fk`.

After encryption, confirm key names:

```sh
dotenvx keypair -f .env.local.enc
dotenvx keypair -f .env.production.enc
```

Move the private key values into the deployment secret manager using the exact `DOTENV_PRIVATE_KEY*` names reported by dotenvx. Do not expose the values in chat or logs.

## 4. Replace Runtime Loading

Package scripts should inject env before the process starts:

```json
{
  "scripts": {
    "env:inject": "dotenvx run -f .env.local.enc -f .env.personal --ignore=MISSING_ENV_FILE -o --strict",
    "dev": "pnpm env:inject -- next dev",
    "build": "pnpm env:inject -- next build"
  }
}
```

Adjust command names to match the project. For production or CI, use the environment-specific encrypted file:

```sh
dotenvx run -f .env.production.enc --strict -- pnpm build
```

For Node config files that must load env during config evaluation, replace `dotenv` vault loading:

```js
import { config } from '@dotenvx/dotenvx'

const { parsed } = config({
  path: ['.env.local.enc', '.env.personal'],
  overload: true,
  ignore: ['MISSING_ENV_FILE'],
})
```

Use `envKeysFile` only when keys intentionally live outside the app directory. The default should be no `-fk` and no `envKeysFile`.

Remove old patterns:

- `dotenv-vault pull ...`
- `DOTENV_KEY`
- `path: ['.env.vault', ...]`
- `DOTENV_KEY: process.env.DOTENV_KEY`
- committed `.env.vault` files, once equivalent `.env.*.enc` files exist.

## 5. Docker And CI

Do not pass `DOTENV_KEY` or `DOTENV_PRIVATE_KEY*` through Docker `ARG` and then store it with `ENV`. That can leave secrets in image metadata or layers.

Prefer:

- Runtime secret injection from the platform for long-running containers.
- BuildKit secrets for build-time-only framework config:

```Dockerfile
# syntax=docker/dockerfile:1.7
RUN --mount=type=secret,id=dotenv_private_key \
  DOTENV_PRIVATE_KEY="$(cat /run/secrets/dotenv_private_key)" \
  dotenvx run -f .env.production.enc --strict -- pnpm build
```

GitHub Actions example:

```yaml
- uses: docker/build-push-action@v5
  with:
    secrets: |
      dotenv_private_key=${{ secrets.DOTENV_PRIVATE_KEY_PRODUCTION }}
```

For non-Docker CI commands:

```yaml
- run: npx @dotenvx/dotenvx run -f .env.production.enc --strict -- pnpm build
  env:
    DOTENV_PRIVATE_KEY_PRODUCTION: ${{ secrets.DOTENV_PRIVATE_KEY_PRODUCTION }}
```

When replacing old GitHub secrets, map:

- Old `DOTENV_KEY` / app-specific vault key secret.
- New exact `DOTENV_PRIVATE_KEY*` names from `dotenvx keypair -f <file>`.

## 6. Ignore Rules

Keep private and plaintext local files ignored:

```gitignore
.env
.env.local
.env.personal
.env.keys
```

Allow encrypted files:

```gitignore
!.env.*.enc
```

Remove vault allow-rules after migration:

```gitignore
!.env.vault
!**/.env.vault
```

Apply the same idea to `.dockerignore`, `.npmignore`, `.vercelignore`, `.easignore`, and platform-specific ignore files. Encrypted `.env.*.enc` files may be included only when the runtime or build path expects them and private keys are supplied separately.

## 7. Validation

Run dotenvx guard commands:

```sh
dotenvx ext precommit
dotenvx ext prebuild
```

Add a plaintext guard for tracked encrypted env files. This catches cases that `prebuild` can miss when Docker ignores env files:

```sh
git ls-files '*.enc' '**/*.enc' | while read -r file; do
  awk '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    /^DOTENV_PUBLIC_KEY/ { next }
    /encrypted:/ { next }
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      print FILENAME ":" NR ": plaintext assignment in encrypted env file: " $1
      failed=1
    }
    END { exit failed ? 1 : 0 }
  ' "$file" || exit 1
done
```

Run representative project commands through dotenvx:

```sh
pnpm env:inject -- node -e "console.log('env ok')"
pnpm env:inject -- pnpm build
docker compose config --quiet
```

Use project-specific commands and avoid printing loaded env.

## 8. Final Review Checklist

- No tracked plaintext env files except explicit test fixtures or examples.
- No tracked `.env.vault` files remain unless kept temporarily for migration.
- No `dotenv-vault` package scripts remain.
- No `DOTENV_KEY` references remain.
- No Docker `ARG` plus `ENV` secret persistence remains.
- `.env.keys` is ignored and never printed.
- `.env.*.enc` files are tracked and contain encrypted values for secrets.
- CI secrets use `DOTENV_PRIVATE_KEY*` names that match the encrypted files.
