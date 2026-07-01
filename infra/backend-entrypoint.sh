#!/usr/bin/env bash
# backend-entrypoint.sh — minimal entrypoint for the Atlas backend container.
#
# Why minimal: the engine bundle (engine-entrypoint.mjs) is handled entirely
# in-process by the backend at boot time:
#   1. bundleEngine() (sandbox/bundle-engine.ts) rebundles it via esbuild and
#      writes it to the fixed backend/sandbox/ build-context dir AND mirrors
#      it to ENGINE_BUNDLE_PATH (A8 from the plan).
#   2. SandboxImageBuilder.ensureImage() builds atlas-sandbox:latest on the host
#      Docker daemon from backend/sandbox/ if the tag is absent.
# Both happen before the NestJS app starts accepting requests. No shell scripting
# or extra file copies are needed here.
#
# tini (PID 1) calls this script, which execs node so SIGTERM flows correctly:
#   tini → bash (this script, replaced by exec) → node
# NestJS registers app.enableShutdownHooks() so SIGTERM triggers BeforeApplicationShutdown
# (the graceful drain described in the plan's Part A3).
set -euo pipefail

exec node /srv/atlas/app/backend/dist/main
