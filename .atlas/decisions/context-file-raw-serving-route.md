---
id: context-file-raw-serving-route
title: "Path-based raw route serves /context bucket files as raw bytes"
status: proposed
tags: ["backend", "web-surface", "api", "artifacts"]
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: false
source_job: "90fedea8-a05f-4170-a211-5dae9c4f69c9"
source_decision: "d4"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/surface/web-surface.controller.ts"]
last_reconciled: 2026-07-08T20:48:59.359Z
---
# Path-based raw route serves /context bucket files as raw bytes

## Context

The web console needed to render artifact HTML (and its relative assets) directly in the browser. The pre-existing raw endpoint (?path=) was scoped to the uploads/ bucket only and, being query-based, could not resolve a document's relative sub-resource URLs.

## Decision

There is a path-based route GET /web/orgs/:orgId/repos/:repoId/jobs/:jobId/context/raw/<bucket-relative-path> that streams one /context file (specs|generated|artifacts) as raw bytes with the correct Content-Type, guarded by OrgMembershipGuard and the shared resolveContextFilePath() bucket/traversal check. The file path lives in the URL PATH (not a query) precisely so an HTML document's relative references (style.css, images) resolve against the document URL and are fetched through the same route. The older ?path= raw endpoint stays uploads-only.

## Consequences

Future features that need to serve or preview /context files raw (other artifact types, downloads) should reuse this route rather than base64-inlining via the JSON context/file endpoint. Any new bucket must be added to resolveContextFilePath to be reachable.

## Alternatives considered

Extend the uploads-only ?path= endpoint (rejected: query-based, breaks relative-asset resolution). Base64 the content through the JSON endpoint (rejected: no origin for sub-resources, host-loop cost on large files).
