---
id: github-webhook-autoregistration-per-repo
title: "Atlas auto-registers per-repo GitHub webhooks; poll is the guaranteed backstop"
status: proposed
tags: ["github", "webhooks", "onboarding", "infrastructure"]
decided_on: 2026-07-09
authored_by: atlas
confirmed_by_operator: true
source_job: "e4157897-a980-477b-b0e1-31e023cd60e5"
source_decision: "d4"
supersedes: []
superseded_by: null
governs_paths: []
last_reconciled: 2026-07-09T01:08:56.332Z
---
# Atlas auto-registers per-repo GitHub webhooks; poll is the guaranteed backstop

## Context

Webhook delivery previously depended on a human manually configuring each repo's hook, so the whole fast path (and even CI-failure routing) could be silently dormant. The connecting PAT spans many GitHub orgs with no 1:1 Atlas→org mapping, and repos may be user-owned (no org-level hooks).

## Decision

Atlas auto-registers webhooks PER-REPO (POST /repos/{owner}/{repo}/hooks) on connect/revalidate plus a one-time boot backfill for access_ok repos, idempotent by matching config.url and ALWAYS re-PATCHing the secret (GitHub hides the stored secret, so a URL match can't prove the secret is current). Registration is SKIPPED when BACKEND_HOST is unset/localhost/non-public-https (e.g. local runs) — a hook there would be dead. It degrades gracefully (a persisted checklist warning) when the PAT lacks admin:repo_hook. The 30-min poll (pollPrClosures + GitStateReconciler) is retained UNCHANGED as the guaranteed pull backstop; webhooks are a best-effort accelerator, never the sole sync path.

## Consequences

Every future sync signal must keep a poll-based backstop — never rely on webhook delivery alone. Local/non-public deployments run on the poll only. The hook's config.secret must always equal GITHUB_WEBHOOK_SECRET or every delivery fails HMAC.

## Alternatives considered

Org-level webhooks (rejected — needs org-admin + a 1:1 org mapping Atlas doesn't have; fails for user-owned repos). Keep manual configuration (rejected — dormant delivery). Store a webhook_id column for idempotency (rejected — config.url matching needs no migration).
