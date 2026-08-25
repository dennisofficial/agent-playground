// Codex-native types for the `codex app-server` JSON-RPC protocol. These model the wire shapes
// directly (they are NOT derived from any Atlas domain type) so this package stays extractable as a
// standalone submodule. Where the wire shape isn't fully nailed down, fields are left loose and every
// event carries a `raw` passthrough so nothing the server sends is ever silently dropped.

export type CodexEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// Friendly camelCase union for API ergonomics. The wire shape differs by call site (kebab-case
// string on thread/start, a discriminated `{type: ...}` object on turn/start) — see
// `toThreadSandbox`/`toTurnSandboxPolicy` in codex-client.ts for the translation.
export type CodexSandbox = 'readOnly' | 'workspaceWrite' | 'dangerFullAccess';

export type CodexImageDetail = 'auto' | 'low' | 'high' | 'original';

export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export type CodexTurnStatus = 'completed' | 'interrupted' | 'failed';

// Discriminated content items for turn/steer input. Only `text` is fully wired through this
// package's public API; the other variants are modeled openly enough to type-check for callers that
// build them by hand.
export type CodexInput =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; detail?: CodexImageDetail }
  | { type: 'localImage'; path: string; detail?: CodexImageDetail }
  | { type: 'skill'; [k: string]: unknown }
  | { type: 'mention'; [k: string]: unknown };

export type CodexThread = { id: string } & Record<string, unknown>;

export type CodexItem = { id: string; type: string } & Record<string, unknown>;

export type CodexApprovalKind = 'commandExecution' | 'fileChange' | 'permissions';

export type CodexApprovalRequest = {
  kind: CodexApprovalKind;
  threadId: string;
  turnId: string;
  itemId: string;
  raw: unknown;
};

export type CodexTokenUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

export type CodexTurnError = { message: string };

export type CodexTurnResult = {
  threadId: string;
  turnId: string;
  status: CodexTurnStatus;
  usage?: CodexTokenUsage;
  error?: CodexTurnError;
  authHomePath: string;
};

// One variant per app-server notification. `event.type` is a stable camelCase name; `raw` always
// holds the original notification params.
export type CodexEvent =
  | { type: 'turnStarted'; threadId: string; turnId: string; raw: unknown }
  | { type: 'itemStarted'; threadId: string; turnId: string; item: CodexItem; raw: unknown }
  | { type: 'itemCompleted'; threadId: string; turnId: string; item: CodexItem; raw: unknown }
  | { type: 'agentMessageDelta'; threadId: string; turnId: string; itemId: string; delta: string; raw: unknown }
  | { type: 'reasoningSummaryTextDelta'; threadId: string; turnId: string; itemId: string; delta: string; raw: unknown }
  | { type: 'reasoningTextDelta'; threadId: string; turnId: string; itemId: string; delta: string; raw: unknown }
  | { type: 'commandExecutionOutputDelta'; threadId: string; turnId: string; itemId: string; delta: string; raw: unknown }
  | { type: 'fileChangePatchUpdated'; threadId: string; turnId: string; itemId: string; raw: unknown }
  | { type: 'turnDiffUpdated'; threadId: string; turnId: string; raw: unknown }
  | { type: 'tokenUsageUpdated'; threadId: string; turnId: string; usage: CodexTokenUsage; raw: unknown }
  | {
      type: 'turnCompleted';
      threadId: string;
      turnId: string;
      status: CodexTurnStatus;
      usage?: CodexTokenUsage;
      error?: CodexTurnError;
      raw: unknown;
    }
  | { type: 'unknown'; method: string; raw: unknown };
