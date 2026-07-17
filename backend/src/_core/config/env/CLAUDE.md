This is the TYPED env contract read through `EnvService` (`env.get`).

Two rules:

1. Env vars are for things that genuinely differ per environment (hosts, connection details) or
   are secrets. Constant tuning knobs — timeouts, dedup windows, resource limits — are the same in
   every environment and belong in code as named constants, NOT here.
2. Vars are REQUIRED by default (that is the point of validating — fail fast at boot). Reserve
   `.optional()` for a value that legitimately diverges between local and prod (e.g. Postgres SSL
   off locally, on in prod) or gates a dev-only feature. A `.default()` still counts as present.
   Vars read only via raw `process.env` (never `env.get`) are intentionally NOT declared here — they are
   not part of the typed contract: logger toggles ENABLE*COLOR / ENABLE_TIMESTAMP, the CI build stamp
   GIT_SHA, and the Langfuse SDK keys LANGFUSE*\* (consumed by @langfuse/otel directly). @nestjs/config
   runs with allowUnknown, so they may still be present in the env files.
