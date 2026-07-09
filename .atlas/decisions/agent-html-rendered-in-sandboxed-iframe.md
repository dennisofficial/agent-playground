---
id: agent-html-rendered-in-sandboxed-iframe
title: "Agent-authored HTML is rendered in a sandboxed, opaque-origin iframe"
status: proposed
tags: ["web", "security", "artifacts", "rendering"]
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: false
source_job: "90fedea8-a05f-4170-a211-5dae9c4f69c9"
source_decision: "d2"
supersedes: []
superseded_by: null
governs_paths: ["web/src/features/job-workspace/**"]
last_reconciled: 2026-07-08T20:48:59.359Z
---
# Agent-authored HTML is rendered in a sandboxed, opaque-origin iframe

## Context

The operator console renders files/artifacts that Atlas agents author (HTML mockups, reports). Agent-authored HTML can carry its own CSS and JS and, via the untrusted-event lanes, is not fully trusted. Rendering it inline in the app would expose the session cookie and the same-origin API to that markup.

## Decision

Any agent-authored HTML shown in the web console renders inside an <iframe> with sandbox="allow-scripts" and WITHOUT allow-same-origin, so the document executes in an opaque origin: its own CSS/JS run (faithful, interactive rendering) but it cannot read the operator's session cookie, call the Atlas API as the user, or touch the parent DOM. The isolation is ALSO enforced server-side: the route that serves the raw HTML sends `Content-Security-Policy: sandbox allow-scripts`, so the opaque-origin sandbox holds even if the URL is opened as a top-level navigation (not just inside the viewer's iframe). This mirrors Claude Artifacts' model (sandboxed iframe on a distinct origin). Inline sanitize-and-render is rejected because it breaks full-page documents; disabling scripts is rejected because it silently breaks interactive mockups.

## Consequences

New viewers that render HTML must use this sandbox posture (iframe sandbox + the CSP sandbox response header on the serving route), not dangerouslySetInnerHTML. Because there is no allow-same-origin, HTML cannot use APIs requiring a real origin.

IMPORTANT LIMITATION (found by live browser validation, not by unit tests/curl): because the sandbox gives the document an OPAQUE origin and the artifact is served from the SAME origin as the authenticated API, a document's EXTERNAL relative sub-resources (a separate `style.css`, images, JS files) are fetched (HTTP 200) but do NOT apply — a cross-origin/opaque-origin stylesheet is not rendered. So this posture fully supports SELF-CONTAINED HTML (inline `<style>`/`<script>`) but NOT multi-file bundles with external assets. Rendering multi-file bundles requires serving artifacts from a SEPARATE, cookie-less origin (then `allow-same-origin` is safe) — the Claude Artifacts model — tracked as a follow-up. Do NOT "fix" multi-file by adding `allow-same-origin` on the API origin: that reopens the exact API-as-operator XSS hole this decision closes.

## Alternatives considered

Sanitize + inline (DOMPurify) — breaks full-page mockups. Sandboxed iframe with scripts disabled — breaks interactive mockups. Serving from a separate physical domain (as claude.ai does) — heavier infra; opaque-origin sandbox achieves equivalent isolation here.
