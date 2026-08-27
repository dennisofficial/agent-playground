# Driving a raw AI SDK call with a Claude subscription OAuth token

Research date: 2026-08-25. Read from installed package source and the installed Claude Code 2.1.241
binary, then verified against live inference. The follow-up attribution experiment supersedes the
initial conclusion that Sonnet and Opus were unavailable to this subscription.

This is the kind of fact `CLAUDE.md`'s no-comments rule exempts: undocumented provider behaviour that
lives outside this repository and cannot drift when our code is refactored.

## The provider needs no replacement

`@ai-sdk/anthropic@4.0.41` supports bearer auth directly. Its provider factory chooses between two
mutually exclusive threads, and `x-api-key` is the _else_:

```ts
const authHeaders = options.authToken
  ? { Authorization: `Bearer ${options.authToken}` }
  : { 'x-api-key': loadApiKey({ apiKey: options.apiKey, environmentVariableName: 'ANTHROPIC_API_KEY', … }) }
```

Passing `authToken` means no API key is read, `ANTHROPIC_API_KEY` is never consulted, and `x-api-key`
is never sent. A hand-written `LanguageModelV4` against the Messages API is **not** required.

```ts
const anthropic = createAnthropic({
  authToken: accessToken,
  headers: { 'anthropic-beta': 'oauth-2025-04-20' },
})
```

Four mechanical facts, each read from the installed package:

- **Passing both `apiKey` and `authToken` throws** before any request is made.
- **The `authToken` JSDoc is wrong.** It claims a default from `ANTHROPIC_AUTH_TOKEN`. No such
  environment read exists in the code; the name appears only in the doc comment. Pass it explicitly.
- **A config-level `anthropic-beta` is merged, not clobbered.** The model unions the beta values from
  config headers, per-request headers, and the betas it computes itself for tools and caching, then
  re-emits one header. So the OAuth beta survives alongside any feature beta. The per-call alternative
  is `providerOptions.anthropic.anthropicBeta`.
- **A refreshed token needs no provider rebuild.** Headers are passed to the model as a _function_ and
  resolved per request, so a mutable settings object picks up a new token live. Rebuilding the provider
  per turn is also cheap and is the cleaner seam.

The user-agent cannot be fully controlled: the SDK and its provider-utils each _append_ their own
suffix. You can prepend via `headers['user-agent']` but only a custom `fetch` can strip the suffix.
The live isolation matrix established that Anthropic does not use it for subscription model routing.

## The header set

```http
POST https://api.anthropic.com/v1/messages
Authorization: Bearer <access_token>
anthropic-version: 2023-06-01
anthropic-beta: oauth-2025-04-20
content-type: application/json
```

The exact beta value `oauth-2025-04-20` comes from first-party reference text embedded in the Claude
Code binary, on a curl example against `/v1/messages`. The same binary carries that value as a module
constant beside the OAuth scope constants `user:inference`, `user:profile` and `org:create_api_key`.

**Correction, 2026-08-25: the beta header is not mandatory on `/v1/messages` for a claude.ai
subscription token.** An earlier draft of this document called it mandatory on that endpoint. Live
observation contradicts that: the same request succeeded with the header and without it. `anthropic-version`
_is_ mandatory — omitting it answers `400 invalid_request_error: "anthropic-version: header is required"`.
Keep sending the beta anyway: it costs nothing, the first-party example carries it, and the claim may
still hold for tokens issued by the platform OAuth CLI path, which is a different issuer.

The `anthropic-beta` value is also _not_ what gates the model. See "Verified live".

## Subscription attribution

Claude Code puts a line that looks like an HTTP header in the **first system block**. It is request
content, not an HTTP header:

```text
x-anthropic-billing-header: cc_version=<client-version>.<fingerprint>; cc_entrypoint=<client>;
```

Without that block, the tested subscription answered `429 rate_limit_error` for Sonnet and Opus. With
the block, the same token, model, headers, prompt, and minute answered `200`. Neither the Claude Code
user-agent nor its additional beta headers changed the refusal.

Claude Code 2.1.241 computes the three-character fingerprint as:

```ts
const selected = [message[4], message[7], message[20]].map((character) => character ?? '0').join('')

const fingerprint = sha256(`59cf53e54c78${selected}${clientVersion}`).slice(0, 3)
```

The salt `59cf53e54c78`, indices `4`, `7`, and `20`, SHA-256 algorithm, three-character truncation,
field order, and separators were recovered from the installed binary's bundled implementation. Atlas
uses `clientVersion=0.1.0` and `cc_entrypoint=atlas`; both values were verified live. The server does
not require Atlas to claim the Claude Code version or `sdk-cli` entrypoint.

The installed request was captured without a network proxy by starting a loopback HTTP recorder and
launching Claude Code with `ANTHROPIC_BASE_URL` pointed at it. The recorder redacted authorization and
returned a local `400`; nothing was forwarded. The captured Sonnet 5 request used:

```http
POST /v1/messages?beta=true
User-Agent: claude-cli/2.1.241 (external, sdk-cli)
x-app: cli
X-Claude-Code-Session-Id: <uuid>
anthropic-version: 2023-06-01
anthropic-beta: claude-code-20250219,oauth-2025-04-20,...
```

It also carried the attribution block, adaptive thinking, three system blocks, and 65 tools. Static
`strings` extraction independently confirmed the header builders and beta constants. Claude Code has
optional native `cch` attestation support, but no `cch` field appeared in the captured request and none
was needed by Atlas's successful calls.

The isolation matrix, with AI SDK retries disabled:

| Sonnet 5 request                               | Result |
| ---------------------------------------------- | ------ |
| OAuth transport only                           | `429`  |
| `claude-code-20250219` only                    | `429`  |
| `x-app: cli` only                              | `429`  |
| Claude Code user-agent only                    | `429`  |
| Complete captured HTTP header set              | `429`  |
| `/v1/messages?beta=true` plus complete headers | `429`  |
| Attribution system block only                  | `200`  |
| Complete captured transport plus attribution   | `200`  |

The attribution-only request also returned `200` for `claude-opus-5`. A real Atlas harness turn through
`createAnthropicOauthModel` returned `200` from Sonnet 5 after the adapter began injecting the block.

## Thinking is returned empty unless the request asks to see it

Observed 2026-08-26 against `claude-opus-5` on the subscription credential. With
`thinking: {type: "enabled", budget_tokens: N}` the response streams a `thinking` block whose
`thinking_delta` payloads are all `""`, followed by a real `signature_delta` and
`output_tokens_details.thinking_tokens: 34`. The model thought; the text was withheld.

`display` governs this. It defaults to `"omitted"` from Opus 4.7 onward, is only accepted alongside
`thinking: {type: "adaptive"}`, and `"summarized"` is what returns the text:

```json
"thinking": { "type": "adaptive", "display": "summarized" }
```

`adaptive` replaces the deprecated `enabled` plus `budget_tokens` from Sonnet 4.6 and Opus 4.6 onward,
and the depth control moves to `output_config.effort`. The direction does not commute: `claude-haiku-4-5`
answers `adaptive thinking is not supported on this model`. Which form a model takes is
`ModelEntry.thinkingControl`, and `anthropicThinkingOptions` maps it onto the request.

Because `adaptive` lets the model decide whether to think at all, a trivial prompt can come back with no
reasoning block whatsoever — that is not the same failure as an empty one, and a regression test has to
force real thinking to tell them apart.

## Verified live

Observed 2026-08-25 from `packages/harness/src/providers/__tests__/anthropic-live.spec.ts`, through
`@ai-sdk/anthropic@4.0.41`, our own `runTurn` loop, and the keychain credential port. The credential was
a `subscriptionType: "team"` claude.ai token carrying the scopes `user:inference`, `user:profile`,
`user:file_upload`, `user:mcp_servers`, `user:sessions:claude_code`.

**A claude.ai subscription token is entitled to `/v1/messages` on a raw third-party call.** The header
set above returned `200` and a real assistant reply. A real extended-thinking signature came back, was
stored in the durable event log under `providerOptions.anthropic.signature`, and was re-sent byte-for-byte
as a `thinking` block on the next turn's request, which Anthropic also answered `200`.

The first pass, before subscription attribution was understood, produced:

| Model                                          | Result                                       |
| ---------------------------------------------- | -------------------------------------------- |
| `claude-haiku-4-5-20251001`                    | `200`, real reply                            |
| `claude-sonnet-5`, no attribution              | `429` `rate_limit_error`, `message: "Error"` |
| `claude-opus-5`, no attribution                | `429` `rate_limit_error`, `message: "Error"` |
| `/v1/messages/count_tokens`, `claude-sonnet-5` | `200`                                        |

Those responses had no retry or rate-limit headers while the usage endpoint reported headroom. They
looked like entitlement failures but were actually missing-attribution failures. This is why provider
protocol errors must be isolated experimentally before being promoted into product policy. The AI SDK
also retries this misleading `429` by default, obscuring the original status and model.

After attribution was added, Sonnet 5 and Opus 5 both answered `200`. The installed Claude Code also
called canonical `claude-sonnet-5` successfully with the same account, independently confirming
entitlement. Haiku 4.5 remains the model used for the signed-thinking round-trip test; a trivial Sonnet
5 turn completed without emitting a reasoning block under the fixed-budget test configuration.

## Provenance, graded — this part matters

The distinction that decides how much the above is worth: **a header set observed on a token-refresh or
usage call proves nothing about whether inference accepts the token.**

| Claim                                                                   | Strength                           | Source                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| The provider sends `Bearer` via `authToken`, and merges the beta header | **Very high**                      | Installed package source, both branches and the merge path                       |
| The four headers, and the exact beta value                              | **High**                           | First-party reference text, on a `/v1/messages` example                          |
| That a **claude.ai subscription** token is entitled to `/v1/messages`   | **Verified**                       | Live `200` and a real reply, 2026-08-25. See "Verified live"                     |
| Subscription attribution controls Sonnet/Opus routing                   | **Verified**                       | Single-variable live matrix: `429` without the first system block, `200` with it |
| Atlas may identify its own version and entrypoint                       | **Verified**                       | `cc_version=0.1.0.<fingerprint>; cc_entrypoint=atlas;` returned `200`            |
| User-agent or extra beta flags lift the refusal                         | **False**                          | Complete captured HTTP header parity still returned `429` without attribution    |
| That the beta header is required on `/v1/messages`                      | **False for a subscription token** | Live `200` without it                                                            |

The first-party text concerns tokens from Anthropic's platform OAuth CLI, not specifically claude.ai
subscription tokens. Same transport contract, different issuing path. No first-party statement was found
that a subscription token is accepted on `/v1/messages` — the live call is what settled it, and it
settled transport compatibility today, not a supported contract.

**This repository contains no prior art for an inference call.** Every OAuth header in `deprecated/` is
on a refresh endpoint or the usage endpoint. The one supporting signal is that the login flow already
requests the `user:inference` scope, which is a necessary condition — worth asserting on the stored
token, and not sufficient on its own.

The earlier spike was later located in the neighboring `claude-code` working copy under
`scripts/oauth-vercel-ai-spike.ts`. It established bearer transport with the OAuth beta but did not
capture Claude Code's attribution block. The live Atlas matrix is the first artifact that isolates the
Sonnet/Opus routing requirement.

## What is still unverified

- Anthropic's supported surface for subscription credentials is still Claude Code and the Agent SDK. The
  live `200` establishes present-day transport compatibility, not an entitlement, and not a contract.
- Whether the attribution format, salt, or accepted client version changes in a future Claude Code/API
  release. The adapter concentrates that drift in one module and request-shape tests pin today's format.
- Whether Anthropic will enable native `cch` attestation for this account or require it later. Claude Code
  2.1.241 contains the implementation, but the captured live request did not carry it.
- **Endpoint drift.** The deprecated TUI used `platform.claude.com/v1/oauth/token` with authorization at
  `claude.com/cai/oauth/authorize`; the current binary carries a `claude.ai` client-metadata URL.
  Re-verify rather than copying the deprecated constants.

The provider adapter is the locality mechanism: the core message model, assembly pipeline, loop, and TUI
contain no Anthropic attribution concepts. A future Codex adapter can implement its own subscription
transport behind the same `LanguageModelV4` seam without sharing or branching on this protocol.
