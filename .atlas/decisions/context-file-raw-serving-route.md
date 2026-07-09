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
supersedes: ["context-file-raw-serving-route"]
superseded_by: null
governs_paths: ["backend/src/app/surface/web-surface.controller.ts"]
last_reconciled: 2026-07-09T01:12:51.779Z
---
# Path-based raw route serves /context bucket files as raw bytes

## Context

Rendering artifact HTML (and giving the browser real URLs for a document's sub-resources) needed a way to serve /context files as raw bytes with correct Content-Type. The pre-existing raw endpoint was uploads-only and query-based (which can't resolve relative sub-resource URLs).

## Decision

GET /web/orgs/:orgId/repos/:repoId/jobs/:jobId/context/raw/<bucket-relative-path> streams one /context file (specs|generated|artifacts) as raw bytes with the correct Content-Type, guarded by OrgMembershipGuard + the shared resolveContextFilePath bucket/traversal check. The file path lives in the URL PATH (not ?path=) so relative references resolve against the document URL. The older ?path= raw endpoint stays uploads-only.

## Consequences

Future features needing to serve/preview /context files raw (other artifact types, downloads, or a future separate-origin artifact host) should reuse this route rather than base64-inlining via the JSON endpoint. New buckets must be added to resolveContextFilePath to be reachable.

## Alternatives considered

Extend the uploads-only ?path= endpoint (rejected: query-based breaks relative-asset resolution). Base64 via the JSON endpoint (rejected: no origin for sub-resources, host-loop cost on large files).
