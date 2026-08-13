import type { HookCallbackMatcher, Options, Settings } from '@anthropic-ai/claude-agent-sdk';
import { atlasToolNames, atlasToolServer } from './atlas-tool-server.js';
import type { RunArgs } from './claude-engine.service.js';
import { NATIVE_TOOLS } from './native-tools.js';

/**
 * The post-tool hook, as the SDK wants it: a callback per matcher, returning `additionalContext` the
 * CLI appends to that tool's result before the next model request.
 *
 * `PostToolUse` rather than `Stop` or a steer because it is the one boundary where the agent is
 * already waiting and has not begun its next thought. No matcher, so it fires for every tool: what
 * Atlas has to say has nothing to do with which tool ran, and a filter here would be a second place
 * for the decision to live.
 */
function toolBoundaryHook(onToolBoundary: () => Promise<string | undefined>): HookCallbackMatcher {
  return {
    hooks: [
      async () => {
        const additionalContext = await onToolBoundary();
        if (additionalContext === undefined) return { continue: true };
        return {
          continue: true,
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
        };
      },
    ],
  };
}

/**
 * Everything Atlas asks of a Claude session, in one place.
 *
 * Pulled out of the service so it can be READ and tested without spawning anything: most of what is
 * here is policy the design argued about for a long time, and policy that only exists inside a
 * private method is policy nobody can assert.
 */
export function claudeOptions(args: RunArgs): Options {
  const tools = args.tools ?? [];
  return {
    ...(args.systemPrompt === undefined ? {} : { systemPrompt: args.systemPrompt }),
    cwd: args.cwd,
    model: args.model,
    ...(args.resume === undefined ? {} : { resume: args.resume }),
    // The live tail exists because of this flag — without it there are no deltas to render.
    includePartialMessages: true,
    // A delegate's prose stays in the delegate's own window. Left OFF deliberately: Atlas counts a
    // delegate's work rather than quoting it (`domain/delegates.ts`), and forwarding the full nested
    // conversation would put the context this thread paid to OFFLOAD back on its screen. Its tool
    // blocks arrive regardless — the SDK forwards those unconditionally — and are what the delegate
    // row is counted from.
    forwardSubagentText: false,
    // The one line a delegate row cannot derive: a periodic present-tense gist of what the subagent is
    // actually doing ("Analyzing the markdown layer"). The SDK produces it by forking the subagent's
    // own conversation, reusing its prompt cache, so it costs close to nothing — and without it a
    // long-running delegate is a tool count that says how BUSY it is and nothing about what it is on.
    agentProgressSummaries: true,
    thinking: { type: 'adaptive', display: 'summarized' },
    // Atlas allows everything it exposes. No approval card, no permission mode, no `waiting` run
    // state — restriction is done by what EXISTS, never by refusing at call time.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // `tools` is the restriction lever and `allowedTools` is NOT — the latter only auto-approves,
    // so a short `allowedTools` with `tools` unset leaves every other native tool present and merely
    // asking. Everything outside this list is absent from the model's context. See `native-tools.ts`
    // for the rule that decides membership.
    tools: [...NATIVE_TOOLS],
    allowedTools: [...NATIVE_TOOLS, ...atlasToolNames(tools)],
    // In-process, with handlers closed directly over the live services. No IPC and no bridge: the
    // agent is a child of the process that owns the database, so a tool call is a function call.
    ...(tools.length === 0 ? {} : { mcpServers: { atlas: atlasToolServer(tools) } }),
    ...(args.onToolBoundary === undefined
      ? {}
      : { hooks: { PostToolUse: [toolBoundaryHook(args.onToolBoundary)] } }),
    // The 1M window is DELIBERATELY OFF, pending one live turn to prove it is accepted.
    //
    // The meter no longer blocks it — that was the original objection and ticket 13 fixed it, since
    // `ctx` now draws against the rotation BUDGET rather than the window (a million-token window
    // used to render a 200K session as `20%` green). Atlas's own arithmetic is unaffected either
    // way: `budgetFor` caps against the window and `resolveContextLimit` already treats the Opus
    // class as a million.
    //
    // What stops it is the blast radius of being wrong. The SDK's own doc string scopes this beta
    // to Sonnet 4/4.5, it is forwarded verbatim to the CLI as `--betas`, and an unrecognised beta
    // fails the REQUEST — so if opus-5 rejects it, every turn in the app dies rather than one
    // feature degrading. That is not a thing to enable unattended and discover in the morning.
    //
    // To turn it on: uncomment, run ONE turn, and confirm it comes back. Reverting is deleting the
    // line again.
    // betas: ['context-1m-2025-08-07'],
    // Rotation owns context, so SDK auto-compaction is off OUTRIGHT. Compaction can only compress
    // where a hand-off can externalise into `context/`, and a faithful summary carries a poisoned
    // trajectory forward — degradation is unreliability, not lost aptitude. Two mechanisms racing
    // for the same moment is worse than either alone.
    //
    // A JSON STRING, not the object the type also admits: the SDK flattens this option with
    // `String(value)` unless the `sandbox` option is also set, so an object arrives at the CLI as
    // the literal `[object Object]` and the setting is silently lost. MEASURED on 0.3.220; the
    // CLI's own help says "a settings JSON file or a JSON string".
    settings: JSON.stringify({ autoCompactEnabled: false } satisfies Settings),
    // Explicit for stability rather than rescue: omitting this already loads every source on
    // 0.3.220. `user` resolves to Atlas's own `CLAUDE_CONFIG_DIR`, never the human's `~/.claude`.
    settingSources: ['user', 'project'],
    skills: 'all',
    env: { ...process.env, ...args.env },
  };
}
