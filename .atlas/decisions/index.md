# Decision ledger

_Generated — durable, cross-cutting decisions promoted from threads. Do not edit this index by hand;
it is regenerated on every promotion. Edit an individual decision file to propose a change._

| id | decision | status |
|----|----------|--------|
| [agent-html-rendered-in-sandboxed-iframe](agent-html-rendered-in-sandboxed-iframe.md) | Agent-authored HTML is rendered in a sandboxed, opaque-origin iframe | proposed |
| [approval-gate-version-pinned-retractable](approval-gate-version-pinned-retractable.md) | Plan approval is version-pinned and retractable — approve only the current draft of an awaiting_approval job | proposed |
| [context-file-raw-serving-route](context-file-raw-serving-route.md) | Path-based raw route serves /context bucket files as raw bytes | proposed |
| [github-pr-state-sync-silent-not-brain-pipeline](github-pr-state-sync-silent-not-brain-pipeline.md) | GitHub pull_request state syncs silently to DB columns, never through the job/brain pipeline | proposed |
| [github-two-webhook-endpoints](github-two-webhook-endpoints.md) | Two GitHub webhook endpoints by concern: /ingress/github (events→jobs) vs /webhooks/github (silent PR-state) | proposed |
| [github-webhook-autoregistration-per-repo](github-webhook-autoregistration-per-repo.md) | Atlas auto-registers per-repo GitHub webhooks; poll is the guaranteed backstop | proposed |
| [harness-projections-live-in-context-generated](harness-projections-live-in-context-generated.md) | Non-committed harness projections live in /context/generated, never the git worktree | proposed |
| [job-halt-lifecycle-invariant](job-halt-lifecycle-invariant.md) | A halted job is never auto-driven; halt clears only on budget-aware recovery | proposed |
| [job-status-phase-vs-halt](job-status-phase-vs-halt.md) | Job status is the pure build phase; failure/halt is a separate `halt` field | proposed |
| [live-turn-time-ordered-render](live-turn-time-ordered-render.md) | Live turn renders as one time-ordered stream; live blocks carry server emittedAt | proposed |
| [needs-you-halted-axis](needs-you-halted-axis.md) | Turn-stopping errors surface via a persisted `halted` flag, not by mutating job.status | proposed |
| [sandbox-submodule-repos-full-clone](sandbox-submodule-repos-full-clone.md) | Submodule repos get full-clone sandboxes, not linked worktrees | proposed |
| [ship-gate-driver-builds-only](ship-gate-driver-builds-only.md) | The ship-review gate and driver ship path apply to DRIVER builds only, never brain-owned direct builds | proposed |
| [streaming-turn-input-close-gate](streaming-turn-input-close-gate.md) | Streaming turns close their input/control channel only on a genuinely-completed result | proposed |
| [subagent-recovery-nudge-before-respawn](subagent-recovery-nudge-before-respawn.md) | Orchestrators nudge stalled/failed subagents instead of respawning | proposed |

_Last regenerated: 2026-07-09T10:42:58.436Z_
