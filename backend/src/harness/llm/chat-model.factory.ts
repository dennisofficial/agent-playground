import { EnvService } from '@core/config/env/env.service';
import { ChatAnthropic } from '@langchain/anthropic';
import { Injectable } from '@nestjs/common';
import { CredentialContext } from '../llm-keys/credential-context';

const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_SMALL_MODEL = 'claude-haiku-4-5-20251001';

/**
 * The chat model's max output budget — the Anthropic API requires `max_tokens`, so this is NOT an
 * artificial cap, it's the model's actual output ceiling. 64K is Sonnet 4.6's / Haiku 4.5's max and
 * is ≤ the 128K ceiling on Opus/Fable, so it's safe for any `CHAT_MODEL`. A LOW value here truncates
 * long messages mid-sentence with `stop_reason:"max_tokens"` (the thinking summary shares this budget
 * too), so we run wide open — runaway generations are rare and the per-turn cost is bounded by what
 * the bot actually writes, not by this number.
 */
const CHAT_MAX_OUTPUT_TOKENS = 64000;

/**
 * Reusable Anthropic model builders, shared by the chat agents, the gate, and the reconcile passes.
 * (Ported from playground/src/model.ts, env reads moved onto EnvService.) Callers build lazily (on
 * first use), not at module top-level — ChatAnthropic's constructor throws if no key is resolvable,
 * and a top-level crash would beat the TUI's error rendering to the screen.
 *
 * Single-process multi-tenant: the API key comes from the per-turn CredentialContext (the active
 * workspace's key), NOT process.env — so one builder serves every workspace. Outside a turn scope
 * the context falls back to process.env (dev/TUI). `apiKey: undefined` is omitted so ChatAnthropic
 * still throws its actionable "missing key" error rather than receiving an empty string.
 */
@Injectable()
export class ChatModelFactory {
  constructor(
    private readonly env: EnvService,
    private readonly creds: CredentialContext,
  ) {}

  private apiKey(): string | undefined {
    return this.creds.anthropicKey();
  }

  /**
   * The model id that `buildModel()` uses — single source of truth so callers that need the
   * string (e.g. the LangGraph engine for cost attribution) don't have to re-read the env.
   */
  chatModelId(): string {
    return this.env.get('CHAT_MODEL') ?? DEFAULT_CHAT_MODEL;
  }

  /** The main chat model (one model for v0; per-role / multi-LLM config comes later). */
  buildModel(): ChatAnthropic {
    const temperature = this.env.get('CHAT_TEMPERATURE') ?? 1;
    return new ChatAnthropic({
      apiKey: this.apiKey(),
      model: this.env.get('CHAT_MODEL') ?? DEFAULT_CHAT_MODEL,
      betas: [
        'extended-cache-ttl-2025-04-11', // honor ttl:'1h'; without it 1h silently falls back to 5m
      ],
      thinking: { type: 'adaptive', display: 'summarized' },
      maxTokens: CHAT_MAX_OUTPUT_TOKENS,
      temperature,
    });
  }

  /**
   * Cheap, fast model for the response gate. The gate fires on EVERY message for EVERY bot, so it
   * sets the token floor — Haiku keeps the respond/ignore decision near-free. Returns a small
   * structured tool call (one-line reasoning + action + optional emoji) — still tiny.
   */
  buildGateModel(): ChatAnthropic {
    return new ChatAnthropic({
      apiKey: this.apiKey(),
      model: this.env.get('GATE_MODEL') ?? DEFAULT_SMALL_MODEL,
      maxTokens: 256,
      temperature: 0,
    });
  }

  /**
   * Cheap model for the post-turn RECONCILE passes (facts + tasks) — runs in the background after a
   * turn. Roomier than the gate: returns a structured call with facts[] / tasks[] arrays.
   */
  buildExtractModel(): ChatAnthropic {
    return new ChatAnthropic({
      apiKey: this.apiKey(),
      model: this.env.get('EXTRACT_MODEL') ?? DEFAULT_SMALL_MODEL,
      maxTokens: 512,
      temperature: 0,
    });
  }

  /**
   * Cheap model for the recursion-guard rolling-window check — fires on every bot-authored trigger
   * on the respond path. Returns a single boolean + one-line reasoning (tiny output). `GUARD_MODEL`
   * env var overrides; defaults to the same Haiku as gate/extract.
   */
  buildGuardModel(): ChatAnthropic {
    return new ChatAnthropic({
      apiKey: this.apiKey(),
      model: this.env.get('GUARD_MODEL') ?? DEFAULT_SMALL_MODEL,
      maxTokens: 128,
      temperature: 0,
    });
  }
}

/**
 * Debug aid: USD cost of one gate call, from the EXACT token counts the API returns. Haiku 4.5
 * pricing: $1.00/1M input, $5.00/1M output (verified against the Anthropic model catalog, 2026-06).
 */
export const GATE_PRICE_PER_MTOK = { input: 1.0, output: 5.0 } as const;
export const gateCostUsd = (
  inputTokens: number,
  outputTokens: number,
): number =>
  (inputTokens * GATE_PRICE_PER_MTOK.input +
    outputTokens * GATE_PRICE_PER_MTOK.output) /
  1_000_000;
