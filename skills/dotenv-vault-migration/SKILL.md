---
name: dotenv-vault-migration
description: Use this skill when migrating a project from dotenv-vault to dotenvx, including `.env.vault`, `DOTENV_KEY`, `dotenv-vault pull`, `dotenv` config with vault files, Docker or CI build args carrying vault keys, and conversion to `@dotenvx/dotenvx` encrypted `.env.*.enc` files with co-located `.env.keys`.
---

# Dotenv Vault Migration

## Workflow

1. Inventory before editing. Search for `.env.vault`, `DOTENV_KEY`, `dotenv-vault`, `dotenv.config`, Docker build args, CI secrets, ignore rules, and all `.env*` files. Never print env values.
2. Check dotenvx support. Run `dotenvx --version` or `npx @dotenvx/dotenvx@latest --version`, then try `dotenvx ext vault migrate --help` and `dotenvx vault migrate --help`. Treat `unknown command` as unsupported even if the process exits `0`.
3. Prefer the tool-first path when the installed CLI exposes a vault migration command. Snapshot env files first, run the migration, then validate output before changing runtime code.
4. Use the manual fallback when the migration command is missing, unclear, or produces unsafe output. Start from existing pulled plaintext env files or use the old `dotenv-vault pull` commands only to materialize source files locally.
5. Standardize on tracked encrypted files named `.env.local.enc`, `.env.development.enc`, `.env.staging.enc`, and `.env.production.enc` as applicable. Keep private keys in co-located `.env.keys` files so app-local dotenvx commands do not need `-fk`.
6. Replace runtime vault loading with either `dotenvx run -f ... -- <command>` or `@dotenvx/dotenvx` config for Node build-time config files.
7. Validate with dotenvx guard commands, a plaintext scan for tracked `*.enc` files, and project-specific build/dev commands.

## Safety Rules

- Do not display or summarize secret values, decrypted env files, `.env.keys`, `DOTENV_KEY`, or `DOTENV_PRIVATE_KEY*`.
- Do not commit `.env.keys`, plaintext `.env`, `.env.local`, `.env.personal`, or migration scratch files.
- Do not pass `DOTENV_PRIVATE_KEY*` or old `DOTENV_KEY` through Docker `ARG` plus `ENV`; prefer runtime secrets or BuildKit secrets for build-only needs.
- Preserve user-created local overrides such as `.env.personal`.
- Remove `.env.vault` allow-rules from `.gitignore`, `.dockerignore`, `.easignore`, and similar files only after the migration no longer needs vault files.

## Defaults

- Encrypted file convention: `.env.*.enc`.
- Key location: co-located `.env.keys` in each app/package directory.
- Local command shape: `dotenvx run -f .env.local.enc -f .env.personal --ignore=MISSING_ENV_FILE -o --strict -- <command>`.
- Deployment secret shape: use the exact `DOTENV_PRIVATE_KEY*` names reported by `dotenvx keypair -f <file>`.

## Reference

Read `references/migration-guide.md` for the complete migration procedure, CLI-support checks, manual fallback steps, CI/Docker guidance, and validation commands.
