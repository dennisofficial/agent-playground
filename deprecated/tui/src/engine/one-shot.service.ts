import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  CLAUDE_AGENT_SDK,
  type ClaudeAgentSdk,
} from "./claude-sdk.provider.js";

export type AskArgs = {
  prompt: string;
  systemPrompt: string;
  model: string;
  /** Nothing is read or written, but the SDK still runs somewhere — the job's tree, for tidiness. */
  cwd: string;
  /** Credential injection, exactly as a turn's — see `EngineHomeService`. */
  env: Record<string, string>;
  /** A stuck subprocess must not outlive its answer. Default: half a minute. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * One question, one answer, no conversation — the model as a function.
 *
 * This is NOT a turn and deliberately shares nothing with one: no session row, no normalisation, no
 * raw tape, no transcript, no tools, and no settings from disk. A turn is a thing Atlas manages; an
 * ask is a string the harness needed and could not compute itself. Naming a job is the first of
 * them, and the isolation is what makes it safe to run beside a live turn.
 *
 * It lives in `engine/` for the rule that matters: SDK calls are made here and nowhere else.
 */
@Injectable()
export class ClaudeOneShotService {
  private readonly logger = new Logger(ClaudeOneShotService.name);

  constructor(@Inject(CLAUDE_AGENT_SDK) private readonly sdk: ClaudeAgentSdk) {}

  /**
   * `undefined` for anything that is not a clean answer — a crash, a timeout, a refusal, an empty
   * reply. Every caller of an ask has a fallback by construction (it asked for a nicety), so failure
   * is a value rather than a throw, and nothing upstream needs a try/catch.
   *
   * NOT `async`, and that is load-bearing: `sdk.query()` spawns synchronously, so calling this
   * inside `EngineHomeService.claim` puts the spawn inside the credential critical section, exactly
   * as a turn does. An `async` method here would return at the first await and let the next turn
   * rewrite the credentials file underneath the spawning process.
   */
  ask(args: AskArgs): Promise<string | undefined> {
    const abort = new AbortController();
    const handle = this.sdk.query({
      prompt: args.prompt,
      options: oneShotOptions(args, abort),
    });
    const timer = setTimeout(
      () => abort.abort(),
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return this.collect(handle).finally(() => clearTimeout(timer));
  }

  private async collect(handle: Query): Promise<string | undefined> {
    try {
      for await (const message of handle) {
        // The result frame carries the final text, so nothing has to be assembled from assistant
        // blocks: one turn, one answer, and the frame that reports it also reports whether it failed.
        if (message.type !== "result") continue;
        if (message.subtype !== "success") return undefined;
        const text = message.result.trim();
        return text.length === 0 ? undefined : text;
      }
      return undefined;
    } catch (error) {
      // Warn, never error: nothing broke that the caller cannot do without.
      this.logger.warn(`one-shot ask failed: ${String(error)}`);
      return undefined;
    }
  }
}

/**
 * The opposite policy to `claudeOptions`, on purpose. A turn is given the whole harness; an ask is
 * given nothing it does not need: no built-in tools, no filesystem settings (so no CLAUDE.md, whose
 * project instructions would be pure noise in a titling prompt), no skills, no thinking, and one
 * turn — a second one would mean the model started a conversation nobody is listening to.
 */
function oneShotOptions(args: AskArgs, abort: AbortController): Options {
  return {
    systemPrompt: args.systemPrompt,
    cwd: args.cwd,
    model: args.model,
    tools: [],
    settingSources: [],
    skills: [],
    thinking: { type: "disabled" },
    maxTurns: 1,
    abortController: abort,
    env: { ...process.env, ...args.env },
  };
}
