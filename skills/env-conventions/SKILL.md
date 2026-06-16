---
name: env-conventions
description: >-
  The user's house style for environment variables across their NestJS + Next.js
  pnpm-monorepo projects (mls-studio, cubix-infra, rs-crm-app, and any new repo
  built on the shared nestjs-core-essentials submodule). Use this skill whenever
  a task touches environment variables in ANY form — adding, renaming, or removing
  an env var; editing .env / .env.*.enc / .env.keys / .env.personal; dotenvx
  encrypt/decrypt/run/set/keys; the backend validation file (validation.ts,
  IEnvConfig, Joi schema, EnvService / BaseEnvService); the frontend env wrapper
  (src/lib/env.ts, @t3-oss/env-nextjs or env-core, NEXT_PUBLIC_* / EXPO_PUBLIC_*);
  the env:inject scripts; direnv / .envrc; or wiring env & secrets into Docker,
  docker-compose, Terraform, or Cloud Build / Cloud Run. Trigger this even when the
  user never says "dotenvx" or "convention" — any change to a config value that
  varies by environment, any "this env variable may be undefined" type error, or
  any new secret/credential should load this so the change matches the established
  pattern. For generic dotenvx tool mechanics/CLI, use the `dotenvx` skill; this
  skill is the house style layered on top of it.
---

# Environment variable conventions (house style)

These conventions hold across **mls-studio, cubix-infra, rs-crm-app** and any new
repo built on the shared `packages/nestjs-core-essentials` git submodule (a
NestJS backend + one or more Next.js apps + sometimes an Expo/RN app, in a pnpm
workspace). Match them exactly — consistency across these repos is the whole point.

For *how dotenvx the tool works* (CLI flags, keypair/rotate, library API), use the
separate `dotenvx` skill. This skill is the **house style** layered on top.

## The model in one breath

dotenvx, canonical posture: **commit encrypted `.env.<tier>.enc` per package; keep
the private `.env.keys` and a plaintext `.env.personal` overlay git-ignored.**
Locally you decrypt with `.env.keys`; in prod the private key comes from GCP Secret
Manager. The env file is the per-environment value store; `validation.ts` (backend)
and `src/lib/env.ts` (frontend) are the typed contracts that mirror it.

## File layout & naming (per package, NOT repo root)

Every deployable workspace (`backend`, `web`/`client`/`sites/*`, `mobile`,
`daemon`, `emails`, `infra/terraform/environments/*`) owns its own env files:

| File | Committed? | Role |
|---|---|---|
| `.env.local.enc` / `.env.staging.enc` / `.env.production.enc` (+ `.env.test.enc`) | ✅ tracked | dotenvx-encrypted values per tier; only the values are encrypted — **var names are plaintext** |
| `.env.keys` | ❌ git-ignored | private `DOTENV_PRIVATE_KEY_<TIER>_ENC` store; secret, local/Secret-Manager only |
| `.env.personal` | ❌ git-ignored | **plaintext** local-dev overrides, layered on top of `.env.local.enc` |
| `.env.example` | ✅ (where present) | keyless first-run reference (`cp .env.example .env.personal`) |

The `.enc` suffix is a deliberate house adaptation (canonical dotenvx encrypts
in-place keeping the bare name) — it makes "this file is encrypted" obvious. The
per-package `.gitignore` re-allows it with `!.env.*.enc`.

## Secret hygiene — non-negotiable

- **Never commit `.env.keys` or `.env.personal`.** Verify with `git ls-files | grep -i env` before committing — encrypted `.enc` should appear, keys/personal must not.
- Encrypted `.env.*.enc` **are** safe to commit (that's the point).
- The build/deploy context follows the same rule: `.gcloudignore` / `.dockerignore` re-include `!**/.env.*.enc` and re-exclude `**/.env.keys`, `**/.env.personal`, `**/.env.local`.

## Adding / changing / removing an env variable

This is the most common task. Do **all** the relevant steps — a var added to the
`.enc` but not the schema (or vice versa) is the usual bug.

1. **Decide the tier of need first** (this drives everything below):
   - Needed to boot in every environment → **`.required()`** (and a non-optional `IEnvConfig` field).
   - Has a sane fallback → **`.default(value)`** (still typed non-undefined — present at runtime).
   - Genuinely accessory (feature toggle, tuning knob, optional integration, fallback-having) → **`.optional()`** + a **`?:`** field.
   - Required only under a condition (prod-only, or when another var is set) → **`Joi.when(...)`**.
   - Default to required/`default`. Reserve `.optional()` for things you don't actually depend on — see the philosophy section for *why* this matters to the types.

2. **Backend — edit `backend/src/_core/config/env/validation.ts` in lockstep:** add the field to the `IEnvConfig` interface **and** the matching Joi rule, in the **same section, same relative order**. Keep `?:` ⇔ `.optional()` perfectly in sync (the interface optionality is the single source of truth for null-checking). Joi `.number()` coerces, so a numeric field is typed `number`.

3. **Write the values into the encrypted files — add the key MANUALLY first, then `set` the value.** Order matters: running `dotenvx set` on a key that **doesn't exist yet appends it to the bottom of the file**, which breaks the line-alignment with `validation.ts` and the other tiers. `dotenvx set` is only safe as an *in-place update of a line that already exists*. So for a **new** variable:
   1. **Manually insert the key at the correct line number** — the position that matches its place in `validation.ts` and the same line it occupies in the other tiers ("same line = same variable"). Add a placeholder line, e.g. `MY_VAR=` , at that exact spot in each `.env.<tier>.enc`.
   2. **Then encrypt the value in place** (this updates the existing line, keeping its position):
      ```bash
      dotenvx set MY_VAR "value" -f .env.staging.enc      # repeat per tier
      ```
   Setting an *encrypted* value only needs the public key (in the `.enc` header), so you don't need the private key to do this. The "same line = same variable" convention is documented in cubix/rs-crm `docs/ENVS.md` and enforced by rs-crm's `scripts/check-env-alignment.mjs`. For a value that only matters in local dev (e.g. local DB creds), put it in plaintext **`.env.personal`** instead — `.env.local.enc` legitimately omits vars supplied by `.env.personal`.

4. **Frontend (if applicable) — edit `src/lib/env.ts`:** add the key to the right bucket of `createEnv({ shared, server, client, runtimeEnv })` **and** to the `runtimeEnv` map (t3-env needs both). Browser-exposed vars must be `NEXT_PUBLIC_`-prefixed (web) / `EXPO_PUBLIC_`-prefixed (mobile) and go in `client`; everything else is `server`. Update `.env.example` if the repo has one.

5. **Consume it:** backend `this.env.get('MY_VAR')` (typed); frontend `import { env } from '@/lib/env'` then `env.MY_VAR`. Never read `process.env.X` directly in app code (the only sanctioned exception is `process.env.PORT` in `main.ts`, injected per-service by Cloud Run).

6. **Verify** the run still boots: `pnpm env:inject -- <cmd>` (backend) / `pnpm dev` / `pnpm build`. Validation runs at boot and fails fast if a required key is missing.

## Backend validation: typed, non-undefined env access (the core philosophy)

The reason for the whole validation layer is to **kill the `"this env variable may
be undefined"` type error** for vars you know are present. The machinery:

```ts
// packages/nestjs-core-essentials/src/env/env.service.ts
export abstract class BaseEnvService<T> extends ConfigService<T, true> {   // ← the `true`
  override get<K extends keyof T>(propertyPath: K): T[K] {
    return super.get(propertyPath as any, { infer: true }) as T[K];
  }
}
// backend/src/_core/config/env/env.service.ts
export class EnvService extends BaseEnvService<IEnvConfig> {}              // binds the type, nothing else
```

`@nestjs/config` types `get()` as `ValidatedResult<WasValidated, T> = WasValidated
extends true ? T : T | undefined`. Default `WasValidated = false` → `T | undefined`
(the error you hate). Extending `ConfigService<T, true>` flips it, so
`env.get('OPENAI_API_KEY')` is `string`, not `string | undefined`. `{ infer: true }`
makes it infer the value type from the key.

**Why required-by-default is not just taste — it's what keeps the types honest.**
`WasValidated = true` is a *promise* to the compiler that validation guarantees
presence. That promise is only sound if essential vars are `.required()`/`.default()`.
The safety valve: because `get()` returns `T[K]`, an **optional interface field
(`FOO?: string`) stays `string | undefined` even under `WasValidated = true`**, so
the compiler still forces a null-check on exactly the accessory vars where `undefined`
is real — while required vars stay clean. So: essential → required/default (clean
type); accessory → optional (`| undefined`, checked). Never put `.optional()` on
something you depend on — it makes the non-undefined typing lie.

Stack: **backend = Joi + `@nestjs/config`** (never zod here); register once per
app entrypoint via `EnvModule.forRoot({ envService: EnvService, validationSchema:
envConfigValidation })` (`global: true`, `ignoreEnvFile: true`); validation is
skipped when `NODE_ENV=test`.

## Frontend validation: t3-env + zod

- Web: `@t3-oss/env-nextjs`; mobile/Expo: `@t3-oss/env-core` (`clientPrefix: 'EXPO_PUBLIC_'`), both with **zod**.
- `createEnv({ shared, server, client, runtimeEnv })` enforces the server/client boundary so server-only secrets can never leak into the browser bundle.
- Validation fires when `env.ts` is first imported (build-time during `next build`, request-time on the server).

## Running locally + direnv

- Per-package script, byte-identical everywhere:
  ```jsonc
  "env:inject": "dotenvx run -f .env.local.enc -f .env.personal --ignore=MISSING_ENV_FILE -o --strict",
  "dev": "pnpm env:inject -- next dev"   // or: pnpm dev:env -- nest start api --watch
  ```
  `.env.local.enc` decrypts first; `.env.personal` overlays and **overrides** via `-o`; `--ignore=MISSING_ENV_FILE` makes the personal overlay optional; `--strict` fails fast.
- **`.envrc` (direnv) is gcloud-only** — it points `CLOUDSDK_CONFIG` + ADC at a repo-local `.gcloud/`. It deliberately does **not** bootstrap dotenvx; decryption lives entirely in the npm scripts. Don't add dotenvx logic to `.envrc`.
- Run everything through `pnpm --filter <pkg> <script>`.

## Hard-won rules / gotchas

- **Never set `NODE_ENV` in a dotenv file.** Next.js manages it; injecting `NODE_ENV=development` into a build breaks prerendering. It lives in the `shared` bucket of `env.ts`, sourced from `process.env.NODE_ENV`.
- **Keep schema ⇔ `.enc` ⇔ interface aligned.** Adding a key in one place and not the others is the #1 source of boot failures and `| undefined` surprises.
- **Tier naming must be consistent across dir / file / key.** Cautionary tale: rs-crm has an *orphaned* `DOTENV_PRIVATE_KEY_DEVELOPMENT_ENC` with no `.env.development.enc`, and a terraform dir named `dev/` holding a `.env.staging.enc` — a three-way `dev`/`staging`/`development` collision. Pick one tier name and use it for the dir, the file, and the key.
- **dotenvx version drifts between repos** (e.g. `^1.71` vs `^1.64` vs `^1.51`). When adding dotenvx to a new package, match the version already pinned elsewhere in that repo.

## Deploy: Docker / Terraform / Cloud Build / Cloud Run

The deploy engine is **Google Cloud Build** (Terraform-managed triggers), not
GitHub Actions. The private key enters via GCP Secret Manager — at **runtime** for
backends, at **build time** for Next.js. When touching any of that, read
[references/infra-cicd.md](references/infra-cicd.md) for the exact patterns
(multi-stage Dockerfile, BuildKit `--secret`, the terraform `dotenvx run --
terraform` wrapper, `availableSecrets`/`secretEnv`, and the gcloud/docker ignore
rules).
