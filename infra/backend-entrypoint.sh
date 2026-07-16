#!/usr/bin/env bash
# backend-entrypoint.sh — minimal entrypoint for the Atlas backend container.
#
# Why minimal: the engine app bundle (engine-app.js + sourcemap) is handled
# in-process by the backend at boot time:
#   1. ensureEngineApp() (sandbox/bundle-engine.ts) mirrors the prebuilt
#      backend/sandbox/engine-app.js(+.map) to ENGINE_APP_BUNDLE_PATH /
#      ENGINE_APP_MAP_PATH when those host-resolvable paths are configured.
#   2. SandboxImageBuilder.ensureImage() builds atlas-sandbox:latest on the host
#      Docker daemon from backend/sandbox/ if the tag is absent.
# Both happen before the NestJS app starts accepting requests. No shell scripting
# or extra file copies are needed here.
#
# tini (PID 1) calls this script, which execs node so SIGTERM flows correctly:
#   tini → bash (this script) → dotenvx (replaced by exec) → node
# NestJS registers app.enableShutdownHooks() so SIGTERM triggers BeforeApplicationShutdown
# (the graceful drain described in the plan's Part A3).
#
# Secrets: the image bakes backend/.env.production.enc (ciphertext, safe to bake — see
# infra/README.md). dotenvx decrypts it into the process env at startup given
# DOTENV_PRIVATE_KEY_PRODUCTION_ENC, the one secret /srv/atlas/secrets/atlas.env holds on the box.
# `exec`'d so dotenvx replaces this shell and node replaces dotenvx in turn — tini still signals the
# final PID directly, same as the previous bare `exec node`.
set -euo pipefail

exec /srv/atlas/app/backend/node_modules/.bin/dotenvx run -f /srv/atlas/app/backend/.env.production.enc -- \
    node /srv/atlas/app/backend/dist/main
