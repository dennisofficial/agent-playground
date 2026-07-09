---
id: agent-html-rendered-in-sandboxed-iframe
title: "Agent-authored HTML renders in a strict opaque-origin sandbox (self-contained only)"
status: proposed
tags: ["web", "security", "artifacts", "rendering"]
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: true
source_job: "90fedea8-a05f-4170-a211-5dae9c4f69c9"
source_decision: "d2"
supersedes: ["agent-html-rendered-in-sandboxed-iframe"]
superseded_by: null
governs_paths: ["web/src/features/job-workspace/**", "backend/src/app/surface/web-surface.controller.ts"]
last_reconciled: 2026-07-09T01:12:51.779Z
---
# Agent-authored HTML renders in a strict opaque-origin sandbox (self-contained only)

## Context

The operator console renders HTML/artifacts that Atlas agents author. That HTML can carry its own CSS/JS and (via untrusted-event lanes) isn't fully trusted. It is served from the SAME origin as the authenticated /web API, so anything that runs with a real same-origin context could call the API as the operator.

## Decision

Render agent HTML in an <iframe> with sandbox="allow-scripts" and NO allow-same-origin (opaque origin), AND enforce the same server-side with a `Content-Security-Policy: sandbox allow-scripts` response header on the serving route so isolation holds even on a top-level navigation. Its own inline CSS/JS run, but it cannot read the session cookie, call the API as the operator, or touch the parent DOM. Never add allow-same-origin on the API origin.

## Consequences

SELF-CONTAINED HTML (inline <style>/<script>) renders fully and safely. EXTERNAL relative sub-resources (a separate style.css/img/js) are fetched (200) but do NOT apply, because the opaque origin makes the same-URL asset cross-origin — proven by live browser validation, invisible to unit tests/curl. Multi-file bundles therefore require a SEPARATE cookie-less origin (then allow-same-origin is safe) — deferred as a follow-up. Any new HTML-rendering surface must use this posture, not dangerouslySetInnerHTML.

## Alternatives considered

allow-same-origin on the API origin (rejected: API-as-operator XSS). Sanitize+inline via DOMPurify (rejected: breaks full-page docs). Disable scripts (rejected: breaks interactive mockups). Separate physical artifact origin like claude.ai — the correct path for multi-file, tracked as follow-up.
