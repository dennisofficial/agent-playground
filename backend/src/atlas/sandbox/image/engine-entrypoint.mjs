// src/atlas/engine/engine-core.ts
import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";

// src/atlas/engine/claude-auth.ts
function applyClaudeAuth(env, auth) {
  if (auth?.mode === "subscription") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    env.CLAUDE_CODE_OAUTH_TOKEN = auth.secret;
  } else if (auth?.mode === "api_key" && auth.apiKey) {
    env.ANTHROPIC_API_KEY = auth.apiKey;
  }
}

// src/atlas/engine/engine-home.ts
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function atlasEngineHomeDir(root, engine, sandboxKey) {
  const safeKey = sandboxKey.replace(/[^a-z0-9_-]/gi, "_") || "default";
  const dir = join(atlasAgentHomeBase(root), safeKey, engine);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function atlasAgentHomeBase(root) {
  return root ?? join(homedir(), ".agent-playground", "atlas-agent-home");
}

// src/atlas/engine/codex-auth-home.ts
import { mkdirSync as mkdirSync2, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
function ensureCodexAuthHome(root, sandboxKey, secret) {
  const safeKey = sandboxKey.replace(/[^a-z0-9_-]/gi, "_") || "default";
  const home = join2(atlasAgentHomeBase(root), safeKey, "codex-sub");
  mkdirSync2(home, { recursive: true });
  const authJson = secret.trim().startsWith("{") ? secret : JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: secret } });
  writeFileSync(join2(home, "auth.json"), authJson, { mode: 384 });
  return home;
}

// src/atlas/engine/engine.types.ts
var EngineAuthError = class extends Error {
  constructor(message, sessionId) {
    super(message);
    this.sessionId = sessionId;
    this.name = "EngineAuthError";
  }
  sessionId;
  /** Discriminator that survives a structuredClone / cross-process reconstruction. */
  isAuthError = true;
};
function isAuthErrorMessage(message) {
  return /\b401\b|not logged in|please run \/login|invalid[ _-]?api[ _-]?key|invalid x-api-key|authentication[ _]?error|\bunauthorized\b|oauth[^.]*\b(expired|invalid|revoked)\b|token[^.]*\b(expired|revoked)\b|permission_error/i.test(
    message
  );
}

// src/atlas/engine/engine-core.ts
var NOOP_LOGGER = { warn: () => void 0 };
var WORKER_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];
var PLAN_TOOLS = [...WORKER_TOOLS, "ExitPlanMode"];
var REVIEW_TOOLS = ["Read", "Glob", "Grep", "Bash"];
var AUTO_APPROVE = ["Read", "Glob", "Grep"];
function isInsideRoot(path, root) {
  const r = resolvePath(root);
  const p = resolvePath(root, path);
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
}
function gitCommonDir(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || void 0;
  } catch {
    return void 0;
  }
}
var EngineCore = class {
  constructor(claudeSdk, codexSdk, cfg, logger = NOOP_LOGGER) {
    this.claudeSdk = claudeSdk;
    this.codexSdk = codexSdk;
    this.cfg = cfg;
    this.logger = logger;
  }
  claudeSdk;
  codexSdk;
  cfg;
  logger;
  // One Codex client per (auth, sandbox) — each funds its own runs from its own home.
  codexClients = /* @__PURE__ */ new Map();
  homeRoot() {
    return this.cfg.homeRoot;
  }
  /** Resolve the run's auth: an explicit `args.auth` wins; otherwise derive from config. */
  resolveAuth(engine, explicit) {
    if (explicit) return explicit;
    const mode = this.cfg.authMode ?? "api_key";
    if (mode === "subscription") {
      if (engine === "claude") {
        const secret = this.cfg.claudeOauthToken;
        if (secret) return { mode: "subscription", secret };
        this.logger.warn(
          "ATLAS_ENGINE_AUTH_MODE=subscription but ATLAS_CLAUDE_OAUTH_TOKEN unset \u2014 falling back to api_key"
        );
      }
    }
    return { mode: "api_key", ...this.cfg.anthropicApiKey ? { apiKey: this.cfg.anthropicApiKey } : {} };
  }
  async run(args) {
    return args.engine === "codex" ? this.runCodex(args) : this.runClaude(args);
  }
  // ── Claude ────────────────────────────────────────────────────────────────────────────────────
  async runClaude(args) {
    const { task, cwd, systemPrompt, sandboxKey, sessionId, mode, onEvent, signal } = args;
    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
    const auth = this.resolveAuth("claude", args.auth);
    const model = args.model ?? this.cfg.workerModel;
    const claudeConfigDir = atlasEngineHomeDir(this.homeRoot(), "claude", sandboxKey);
    const planMode = mode === "plan";
    const readOnly = mode !== "execute";
    let capturedPlan = "";
    const subprocessEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir
    };
    applyClaudeAuth(subprocessEnv, auth);
    const options = {
      cwd,
      systemPrompt,
      // No skills: settingSources [] means NO on-disk config files are read (full isolation).
      settingSources: [],
      tools: planMode ? PLAN_TOOLS : readOnly ? REVIEW_TOOLS : WORKER_TOOLS,
      allowedTools: AUTO_APPROVE,
      canUseTool: makeCanUseTool(readOnly, cwd, (plan) => {
        capturedPlan = plan;
      }),
      permissionMode: planMode ? "plan" : "default",
      // Suppress the SDK's default "Co-Authored-By: Claude" attribution.
      settings: { attribution: { commit: "", pr: "" } },
      abortController,
      env: subprocessEnv,
      ...sessionId ? { resume: sessionId } : {},
      ...model ? { model } : {}
    };
    let result = "";
    let resolvedSession = sessionId;
    let usage;
    try {
      for await (const message of this.claudeSdk.query({ prompt: task, options })) {
        if (message.type === "system" && message.subtype === "init") {
          resolvedSession = message.session_id;
          if (resolvedSession) onEvent?.({ kind: "session", sessionId: resolvedSession });
        } else if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text) onEvent?.({ kind: "text", text: block.text });
            else if (block.type === "tool_use" && block.name)
              onEvent?.({ kind: "tool", name: block.name });
          }
        } else if (message.type === "result") {
          resolvedSession = message.session_id;
          if (message.subtype === "success") {
            result = message.result;
            usage = extractClaudeUsage(message, model);
          } else {
            throw new Error(`Claude engine ended: ${message.subtype}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(msg)) throw new EngineAuthError(msg, resolvedSession);
      throw err;
    }
    const planText = planMode && capturedPlan || void 0;
    const summary = planText || result || "(no summary)";
    onEvent?.({ kind: "result", text: summary });
    return {
      result: summary,
      sessionId: resolvedSession,
      ...planText ? { planText } : {},
      ...usage ? { usage } : {}
    };
  }
  // ── Codex ─────────────────────────────────────────────────────────────────────────────────────
  getCodex(sandboxKey, auth) {
    const root = this.homeRoot();
    const subscription = auth.mode === "subscription" ? auth : void 0;
    const apiKey = auth.mode === "api_key" ? auth.apiKey : void 0;
    const codexHome = subscription ? ensureCodexAuthHome(root, sandboxKey, subscription.secret) : atlasEngineHomeDir(root, "codex", sandboxKey);
    const cacheKey = subscription ? `sub:${sandboxKey}` : `${apiKey ?? "ambient"}:${sandboxKey}`;
    let client = this.codexClients.get(cacheKey);
    if (!client) {
      const env = { ...process.env, CODEX_HOME: codexHome };
      client = subscription ? new this.codexSdk.Codex({ env }) : new this.codexSdk.Codex(apiKey ? { apiKey, env } : { env });
      this.codexClients.set(cacheKey, client);
    }
    return client;
  }
  codexThreadOptions(cwd, model, readOnly) {
    const gitDir = readOnly ? void 0 : gitCommonDir(cwd);
    return {
      workingDirectory: cwd,
      // Codex's read-only sandbox is how BOTH read-only modes (plan, review) are enforced; execute
      // gets workspace-write (writes confined to the worktree).
      sandboxMode: readOnly ? "read-only" : "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      webSearchMode: "live",
      ...gitDir ? { additionalDirectories: [gitDir] } : {},
      ...model ? { model } : {}
    };
  }
  async runCodex(args) {
    const { task, cwd, systemPrompt, sandboxKey, sessionId, mode, onEvent, signal } = args;
    const auth = this.resolveAuth("codex", args.auth);
    const model = args.model ?? this.cfg.codexModel;
    const readOnly = mode !== "execute";
    const client = this.getCodex(sandboxKey, auth);
    const opts = this.codexThreadOptions(cwd, model, readOnly);
    const thread = sessionId ? client.resumeThread(sessionId, opts) : client.startThread(opts);
    const input = sessionId ? task : `${systemPrompt}

---

Task: ${task}`;
    let result = "";
    let resolvedSession = sessionId;
    let accInput = 0;
    let accCached = 0;
    let accOutput = 0;
    let accReasoning = 0;
    let usageSeen = false;
    const { events } = await thread.runStreamed(input, { signal });
    try {
      for await (const event of events) {
        switch (event.type) {
          case "thread.started":
            resolvedSession = event.thread_id;
            if (resolvedSession) onEvent?.({ kind: "session", sessionId: resolvedSession });
            break;
          case "item.completed": {
            const item = event.item;
            switch (item.type) {
              case "agent_message":
                onEvent?.({ kind: "text", text: item.text });
                result = item.text;
                break;
              case "reasoning":
                onEvent?.({ kind: "text", text: item.text });
                break;
              case "command_execution":
                onEvent?.({ kind: "tool", name: "bash", detail: item.command });
                break;
              case "file_change":
                onEvent?.({
                  kind: "tool",
                  name: "edit",
                  detail: item.changes.map((c) => `${c.kind} ${c.path}`).join(", ")
                });
                break;
              case "web_search":
                onEvent?.({ kind: "tool", name: "web_search", detail: item.query });
                break;
              case "error":
                onEvent?.({ kind: "text", text: `error: ${item.message}` });
                break;
            }
            break;
          }
          case "turn.completed": {
            const u = event.usage;
            accInput += u.input_tokens ?? 0;
            accCached += u.cached_input_tokens ?? 0;
            accOutput += u.output_tokens ?? 0;
            accReasoning += u.reasoning_output_tokens ?? 0;
            usageSeen = true;
            break;
          }
          case "turn.failed":
            throw new Error(event.error.message);
          case "error":
            throw new Error(event.message);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(msg)) throw new EngineAuthError(msg, resolvedSession);
      throw err;
    }
    const summary = result || "(no summary)";
    onEvent?.({ kind: "result", text: summary });
    const usage = usageSeen ? {
      inputTokens: accInput,
      outputTokens: accOutput,
      ...accCached > 0 ? { cacheReadTokens: accCached } : {},
      ...accReasoning > 0 ? { reasoningTokens: accReasoning } : {},
      ...model ? { model } : {}
    } : void 0;
    return {
      result: summary,
      sessionId: resolvedSession ?? thread.id ?? void 0,
      ...usage ? { usage } : {}
    };
  }
};
function makeCanUseTool(readOnly, root, onPlan) {
  return async (toolName, input) => {
    if (toolName === "ExitPlanMode") {
      if (typeof input.plan === "string") onPlan(input.plan);
      return { behavior: "deny", message: "Plan recorded \u2014 ending the planning turn." };
    }
    if (readOnly && (toolName === "Write" || toolName === "Edit")) {
      return { behavior: "deny", message: "This is a read-only turn \u2014 no file writes." };
    }
    if (toolName === "Write" || toolName === "Edit") {
      const path = typeof input.file_path === "string" ? input.file_path : "";
      if (path && !isInsideRoot(path, root)) {
        return { behavior: "deny", message: `Write outside the worktree is not allowed: ${path}` };
      }
    }
    return { behavior: "allow", updatedInput: input };
  };
}
function extractClaudeUsage(message, model) {
  const u = message.usage;
  if (!u) return void 0;
  const costUsd = message.total_cost_usd;
  const modelUsage = message.modelUsage;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const inputTokens = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
  const usedModel = (modelUsage ? Object.keys(modelUsage)[0] : void 0) ?? model;
  return {
    inputTokens,
    ...u.output_tokens !== void 0 ? { outputTokens: u.output_tokens } : {},
    ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
    ...costUsd !== void 0 ? { costUsd } : {},
    ...usedModel ? { model: usedModel } : {}
  };
}

// src/atlas/sandbox/image/engine-entrypoint.ts
function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}
`);
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function main() {
  const raw = await readStdin();
  if (!raw.trim()) throw new Error("engine-entrypoint: empty turn spec on stdin");
  const spec = JSON.parse(raw);
  const claudeSdk = await import("@anthropic-ai/claude-agent-sdk");
  const codexSdk = await import("@openai/codex-sdk");
  const cfg = {
    homeRoot: process.env.ATLAS_AGENT_HOME_ROOT ?? process.env.AGENT_HOME_ROOT,
    authMode: process.env.ATLAS_ENGINE_AUTH_MODE,
    claudeOauthToken: process.env.ATLAS_CLAUDE_OAUTH_TOKEN,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    workerModel: process.env.ATLAS_WORKER_MODEL ?? process.env.WORKER_MODEL,
    codexModel: process.env.ATLAS_CODEX_MODEL ?? process.env.CODEX_MODEL
  };
  const core = new EngineCore(claudeSdk, codexSdk, cfg, {
    warn: (m) => process.stderr.write(`[engine-core] ${m}
`)
  });
  const result = await core.run({
    ...spec,
    onEvent: (e) => emit({ t: "event", e })
  });
  emit({ t: "final", r: result });
}
main().catch((err) => {
  const e = err;
  emit({
    t: "error",
    message: err instanceof Error ? err.stack ?? err.message : String(err),
    ...e?.isAuthError ? { auth: true } : {},
    ...typeof e?.sessionId === "string" ? { sessionId: e.sessionId } : {}
  });
  process.exitCode = 1;
});
