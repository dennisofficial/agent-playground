# Backend gaps — thread workspace

What the **thread workspace** (navigator + Conversation + Phase) had to derive or placeholder because the
web API doesn't expose it yet. Everything else is wired to the real `org → repo → thread` API
(`messages`, `say`, `approve`, `pipeline`, `events`, repo list, create/delete).

The conversation, the approval gate, the pipeline section tree, create-thread, and open-from-anywhere are
all real. The gaps below are isolated and clearly labeled in the UI.

## 1. No status on the cross-org inbox → status seam is "prepared for realtime"
`GET /web/threads` returns `{ threadId, title, origin, createdAt, org, repo }` — **no status / no "needs
you"**. So the board, org rail, and sidebar can't show live status from the list alone.

- The UI is fully built to carry it: `src/lib/api/thread-status.ts` is a small external store, and the
  shell (sidebar dots + NEEDS YOU, board "Needs you" band, rail attention badges) reads it.
- **Today only the open thread populates it** (the workspace writes its real `/pipeline` status via
  `setThreadStatus`). When a realtime status feed lands, push into `setThreadStatus(threadId, …)` from that
  one source and every dot/badge lights up with no component changes.
- Also: the inbox can't distinguish `fix` from `feat` (only `origin === 'event'` is derivable), so bugfix
  threads read as `feat` on the board.

## 2. SSE is repo-scoped + keyed by surface `threadTs`, not `threadId`
`GET …/repos/:repoId/events` emits a frame for **every** thread in the repo, keyed by `channel=repoId` +
a surface `threadTs` — which doesn't map cleanly to the thread UUID the REST reads use. So
`src/lib/api/thread-events.ts` uses SSE purely as a **change-signal**: on any frame, debounced-refetch the
open thread's `messages` + `pipeline`. Cost: a sibling thread's activity also triggers a refetch (fine for
an operator console). A `threadId` on the frame (or a per-thread stream) would let us merge precisely.

## 3. No per-phase transcript / diff / logs
The Phase build view's **Transcript** tab shows the thread's live `build_event` relays as a stand-in; the
**Diff** and **Logs** tabs are labeled placeholders. Needs a phase read endpoint
(`…/threads/:threadId/phases/:id/{transcript,diff,logs}` or similar).

## 4. No plan.md / decision-record / section-plan content
- **plan.md** renders the approval card's `decisions` + `sections` **while the gate is open**. After
  approval the card becomes a verdict card, so the rich plan content isn't re-fetchable — the doc then
  falls back to the pipeline section briefs + a note that the decisions are locked.
- **decision-record.md** and **§ section plan** are placeholders. The pipeline exposes `decisionRecordId`
  but not the decisions or section plans. Needs a read endpoint for the locked decision record + section
  plans.

## 5. No op routes (resume / mark-ready / pause / revert)
Steering is done by **talking to the thread** (`say`) — "resume", "simplify the rest", etc. — which the
brain interprets. The explicit buttons for **Pause** / **Revert phase** (Phase view) and **Mark PR ready**
are disabled pending dedicated routes.

## 6. Branch / tracker not exposed
The navigator omits the git branch + tracker link — neither the inbox row nor `/pipeline` carries them.
Add `feature_branch` (+ any tracker ref) to the pipeline or thread read to light up the navigator header.
