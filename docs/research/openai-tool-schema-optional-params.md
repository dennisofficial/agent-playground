# OpenAI tool schemas: how optional parameters are represented

Research date: 2026-09-05. Question: GPT models (gpt-5-codex etc.) always supply values for
optional tool parameters instead of omitting them — model behavior or schema definition?

## 1. How OpenAI's own Codex CLI defines tool schemas

Source: github.com/openai/codex, cloned at main (commit 6af3454), `codex-rs/`.

Codex builds tool specs as `ResponsesApiTool` structs with an explicit `strict` flag. Across all
built-in tool handlers: **37 `strict: false`, 1 `strict: true`** (the `true` is a test stub in
`extension_tools.rs`). Real tools — exec_command, write_stdin, request_permissions, update_plan,
get_context_remaining — all ship `strict: false`.

Genuinely optional parameters are represented the classic JSON Schema way: **listed in
`properties` but omitted from `required`**, with `additionalProperties: false`. The optionality
is carried by the parameter *description* ("Defaults to …", "omit to use …"), not by the type
system.

`codex-rs/core/src/tools/handlers/shell_spec.rs:35-113` — the exec_command tool:

```rust
let mut properties = BTreeMap::from([
    ("cmd".to_string(), JsonSchema::string(Some("Shell command to execute.".to_string()))),
    ("workdir".to_string(), JsonSchema::string(Some(
        "Working directory for the command. Defaults to the turn cwd.".to_string()))),
    ("tty".to_string(), JsonSchema::boolean(Some(
        "True allocates a PTY for the command; false or omitted uses plain pipes.".to_string()))),
    ("yield_time_ms".to_string(), JsonSchema::number(Some(yield_time_ms_description.to_string()))),
    ("max_output_tokens".to_string(), JsonSchema::number(Some(
        "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.".to_string()))),
]);
// ...
ToolSpec::Function(ResponsesApiTool {
    name: "exec_command".to_string(),
    // ...
    strict: false,
    parameters: JsonSchema::object(
        properties,
        Some(vec!["cmd".to_string()]),   // <- ONLY "cmd" is required
        Some(false.into()),              // <- additionalProperties: false
    ),
    // ...
})
```

The `yield_time_ms` description literally instructs omission: "For ordinary commands, omit this
parameter to use the 10000 ms default."

`codex-rs/core/src/tools/handlers/plan_spec.rs:7-58` — update_plan: `explanation` is a property
("Optional explanation for this plan update.") but `required` is only `["plan"]`. `strict: false`.

`codex-rs/core/src/tools/handlers/get_context_remaining_spec.rs:10-19` — even a zero-parameter
tool sends `strict: false`.

Where codex *does* use `"type": ["string", "null"]` null-unions is in **output schemas**
(`output_schema`), not input parameters — e.g.
`codex-rs/core/src/tools/handlers/multi_agents_spec.rs:395-400`:

```json
"nickname": { "type": ["string", "null"], "description": "..." },
"required": ["agent_id", "nickname"],
```

Output schemas follow the strict-mode convention (key always present, null when absent) because
codex sets `output_schema_strict: true` on structured outputs
(`codex-rs/core/src/client_common.rs:49`).

The shared `JsonSchema` type (`codex-rs/tools/src/json_schema/types.rs:10-14`) explicitly mirrors
the Structured Outputs subset, and `required` is `Option<Vec<String>>` — omitted entirely when
there are no required keys.

apply_patch is a FREEFORM tool (Lark grammar, `codex-rs/core/src/tools/handlers/apply_patch_spec.rs`),
no JSON parameters at all.

## 2. OpenAI's documented strict-mode schema rules

From https://developers.openai.com/api/docs/guides/function-calling (Strict mode section), verbatim:

> Setting `strict` to `true` will ensure function calls reliably adhere to the function schema,
> instead of being best effort. We recommend always enabling strict mode.
>
> Under the hood, strict mode works by leveraging our structured outputs feature and therefore
> introduces a couple requirements:
>
> 1. `additionalProperties` must be set to `false` for each object in the `parameters`.
> 1. All fields in `properties` must be marked as `required`.
>
> You can denote optional fields by adding `null` as a `type` option (see example below).

The doc's own strict-mode example:

```json
"units": {
    "type": ["string", "null"],
    "enum": ["celsius", "fahrenheit"],
},
...
"required": ["location", "units"],
"additionalProperties": false
```

From https://developers.openai.com/api/docs/guides/structured-outputs ("All fields must be
required"), verbatim:

> To use Structured Outputs, all fields or function parameters must be specified as `required`.

> Although all fields must be required (and the model will return a value for each parameter),
> it is possible to emulate an optional parameter by using a union type with `null`.

The doc's example of that emulation (weather tool):

```json
"unit": {
    "type": ["string", "null"],
    "description": "The unit to return the temperature in",
    "enum": ["F", "C"]
},
...
"additionalProperties": false,
"required": ["location", "unit"]
```

## 3. Responses API vs Chat Completions — the critical default difference

Same function-calling guide, verbatim:

> If you send `strict: true` and your schema does not meet the requirements above, the request
> will be rejected with details about the missing constraints. If you omit `strict`, the default
> depends on the API: **Responses requests will attempt to normalize your schema into strict mode
> when possible, and will fall back to non-strict, best-effort function calling if the schema
> cannot be made compatible with strict mode.** When fallback happens, the response tool will show
> `strict: false`. Chat Completions requests remain non-strict by default. To opt out of strict
> mode in Responses and keep non-strict, best-effort function calling, explicitly set
> `strict: false`.

Implication: on the Responses API, a schema with a partial `required` list gets **normalized into
strict mode** server-side unless `strict: false` is explicit — meaning all properties become
required and the model is constrained to emit a value for every key. That is exactly the observed
behavior (`offset: 0, limit: 2000`, inapplicable `region` always filled).

Corroborating reports of models mishandling optional args:
- community.openai.com/t/o1-o3-series-cannot-handle-optional-args-in-function-calling/1110558
- github.com/openai/openai-agents-python/issues/43

## 4. Vercel AI SDK behavior

The AI SDK does **not** default tools to strict mode. `strict?: boolean` is an optional field on
the provider tool spec with no default
(`packages/provider/src/language-model/v4/language-model-v4-function-tool.ts:40-47`, vercel/ai):

```ts
/**
 * Strict mode setting for the tool.
 * Providers that support strict mode will use this setting to determine
 * how the input should be generated. Strict mode will always produce
 * valid inputs, but it might limit what input schemas are supported.
 */
strict?: boolean;
```

The OpenAI provider only sends `strict` when the tool sets it:

- Responses: `packages/openai/src/responses/openai-responses-prepare-tools.ts:620` —
  `...(tool.strict != null ? { strict: tool.strict } : {})`
- Chat: `packages/openai/src/chat/openai-chat-prepare-tools.ts:42` — same pattern.

So with `strict` unset, the API-side default applies: **Responses → server normalizes the schema
into strict mode when possible** (all params effectively required); Chat Completions → non-strict.

## Bottom line

OpenAI's own tooling (Codex CLI) represents a genuinely optional parameter by listing it in
`properties`, omitting it from `required`, setting `additionalProperties: false`, and sending the
tool with **`strict: false`** — optionality lives in the `required` list and in the description
prose ("Defaults to …", "omit to …"), never in nullable type unions on input. The
all-required-plus-null-union pattern is OpenAI's documented convention **only for strict mode**
(and for structured outputs generally), where the model is expected to return a value for every
key.

The observed "model always fills optional params" is therefore primarily a **schema/strict-mode
thing, not pure model whim**: if tools go out with `strict` unset on the Responses API (the AI
SDK default), OpenAI normalizes the schema into strict mode, every property becomes required, and
constrained decoding guarantees a value for each key. Codex's explicit `strict: false` everywhere
is the countermeasure — it is what lets the model actually omit optional parameters.
