import { toCallId, type EventDraft } from '@dltech/atlas-core'

// Thread brn_55fd05fb ("Migration v3 validation"), 2026-09-03/04, kimi-k3-fast: the provider numbers
// tool calls per request, so with 180 bash calls in context every new bash call arrived as bash_181 —
// colliding with the settled port probe below and stalling every turn until the model was switched.
export const COLLISION_TRANSCRIPT: EventDraft[] = [
  {
    type: "user-said",
    text: "drop the stack"
  },
  {
    type: "assistant-said",
    parts: [
      {
        type: "reasoning",
        text: "Dennis says \"drop the stack\" — kill the five background shells. Simple: shell_kill each."
      },
      {
        type: "text",
        text: "Dropping all five processes."
      }
    ]
  },
  {
    type: "tool-called",
    callId: toCallId('bash_181'),
    name: "bash",
    input: {
      command: "for p in 3000 3001 3024 3333 3334; do printf \"%s: \" $p; lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1, $2}' | sort -u | tr '\\n' ' '; echo \"free\" ; done",
      description: "Verify all stack ports are free"
    },
    ordinal: 0
  },
  {
    type: "tool-result",
    callId: toCallId('bash_181'),
    name: "bash",
    output: {
      command: "for p in 3000 3001 3024 3333 3334; do printf \"%s: \" $p; lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1, $2}' | sort -u | tr '\\n' ' '; echo \"free\" ; done",
      description: "Verify all stack ports are free",
      exitCode: 0,
      stdout: "3000: free\n3001: free\n3024: free\n3333: free\n3334: free\n",
      stderr: "",
      truncated: false,
      "timedOut": false
    },
    "modelText": "3000: free\n3001: free\n3024: free\n3333: free\n3334: free"
  },
  {
    type: "assistant-said",
    parts: [
      {
        type: "reasoning",
        text: "#353: no failing/pending checks, mergeable. Merge, then clean up the platform-entitlements worktree + DB, then final summary."
      },
      {
        type: "text",
        text: "Green and mergeable. Merging #353 and cleaning up the last worktree."
      }
    ]
  },
  {
    type: "tool-called",
    callId: toCallId('bash_181'),
    name: "bash",
    input: {
      command: "gh pr merge 353 --squash 2>&1 | tail -2; gh pr view 353 --json state -q .state && git worktree remove .claude/worktrees/platform-entitlements && git branch -D dennis/platform-entitlement-checker && git worktree prune && echo removed; cd packages/db && url=$(../../node_modules/.bin/dotenvx get DATABASE_URL -f .env.local.enc --strict 2>/dev/null) && MGMT_URL=$(printf '%s' \"$url\" | perl -pe 's{^(postgres(?:ql)?://[^/]+/)[^?]*(\\?.*)?$}{${1}postgres$2};') DB=compdev_platform_entitlements bun -e '\n  import { Client } from \"pg\";\n  const db = process.env.DB;\n  if (!/^compdev_[a-z0-9_]+$/.test(db)) throw new Error(`refusing to drop ${db}`);\n  const c = new Client({ connectionString: process.env.MGMT_URL });\n  await c.connect();\n  await c.query(`DROP DATABASE IF EXISTS \"${db}\"`);\n  await c.end();\n  console.log(\"dropped\", db);\n'",
      description: "Merge #353, remove its worktree, branch, and database"
    },
    ordinal: 0
  },
  {
    type: "user-said",
    text: "Anything else left in this session?"
  },
  {
    type: "assistant-said",
    parts: [
      {
        type: "reasoning",
        text: "Dennis asks \"Anything else left in this session?\" — I was about to merge #353 and clean up. Also there's the memory index note: \"Mint a loca…"
      },
      {
        type: "text",
        text: "Yes — the #353 merge and cleanup were mid-flight when you asked, and there are two leftovers beyond it. Let me finish."
      }
    ]
  },
  {
    type: "tool-called",
    callId: toCallId('bash_181'),
    name: "bash",
    input: {
      command: "gh pr merge 353 --squash 2>&1 | tail -2; gh pr view 353 --json state -q .state",
      description: "Squash-merge #353"
    },
    ordinal: 0
  },
  {
    type: "user-said",
    text: "How many PR's are you managing?"
  },
  {
    type: "assistant-said",
    parts: [
      {
        type: "reasoning",
        text: "Dennis asks: \"How many PR's are you managing?\" — simple answer: three. #352 and #354 are merged, #353 was green and mergeable and I was abou…"
      },
      {
        type: "text",
        text: "Three — all from this session's sweep findings, all green:\n\n- **#352** — org gates fail closed (the redirect loop): **merged**, worktree cle…"
      }
    ]
  },
  {
    type: "tool-called",
    callId: toCallId('bash_181'),
    name: "bash",
    input: {
      command: "gh pr merge 353 --squash 2>&1 | tail -2; gh pr view 353 --json state -q .state",
      description: "Squash-merge #353"
    },
    ordinal: 0
  }
]
