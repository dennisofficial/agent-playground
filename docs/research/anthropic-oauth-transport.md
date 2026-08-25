# Driving a raw AI SDK call with a Claude subscription OAuth token

Research date: 2026-08-25. Read from installed source and from first-party reference text embedded in
the Claude Code binary. **Verified live on 2026-08-25** — see "Verified live" below; the sections after
it were written before any call had been made and are corrected there where observation disagreed.

This is the kind of fact `CLAUDE.md`'s no-comments rule exempts: undocumented provider behaviour that
lives outside this repository and cannot drift when our code is refactored.

## The provider needs no replacement

`@ai-sdk/anthropic@4.0.41` supports bearer auth directly. Its provider factory chooses between two
mutually exclusive branches, and `x-api-key` is the *else*:

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
- **A refreshed token needs no provider rebuild.** Headers are passed to the model as a *function* and
  resolved per request, so a mutable settings object picks up a new token live. Rebuilding the provider
  per turn is also cheap and is the cleaner seam.

The user-agent cannot be fully controlled: the SDK and its provider-utils each *append* their own
suffix. You can prepend via `headers['user-agent']` but only a custom `fetch` can strip the suffix.
This matters only if Anthropic gates on user-agent.

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
*is* mandatory — omitting it answers `400 invalid_request_error: "anthropic-version: header is required"`.
Keep sending the beta anyway: it costs nothing, the first-party example carries it, and the claim may
still hold for tokens issued by the platform OAuth CLI path, which is a different issuer.

The `anthropic-beta` value is also *not* what gates the model. See "Verified live".

## Verified live

Observed 2026-08-25 from `packages/harness/src/providers/__tests__/anthropic-live.spec.ts`, through
`@ai-sdk/anthropic@4.0.41`, our own `runTurn` loop, and the keychain credential port. The credential was
a `subscriptionType: "team"` claude.ai token carrying the scopes `user:inference`, `user:profile`,
`user:file_upload`, `user:mcp_servers`, `user:sessions:claude_code`.

**A claude.ai subscription token is entitled to `/v1/messages` on a raw third-party call.** The header
set above returned `200` and a real assistant reply. A real extended-thinking signature came back, was
stored in the durable event log under `providerOptions.anthropic.signature`, and was re-sent byte-for-byte
as a `thinking` block on the next turn's request, which Anthropic also answered `200`.

**Entitlement is per model, not per endpoint — and refusal arrives as `429`, not `401` or `403`.** In the
same session, with the same credential and the same headers:

| Model | Result |
| --- | --- |
| `claude-haiku-4-5-20251001` | `200`, real reply |
| `claude-sonnet-5` | `429` `rate_limit_error`, `message: "Error"` |
| `claude-opus-5` | `429` `rate_limit_error`, `message: "Error"` |
| `/v1/messages/count_tokens`, `claude-sonnet-5` | `200` |

The `429` responses carried **no `retry-after` and no `anthropic-ratelimit-*` headers**, and
`GET /api/oauth/usage` reported the five-hour window at 82%, the seven-day window at 16%, and extra usage
enabled with credits remaining — so this was not an ordinary quota exhaustion, and **the response alone
cannot be told apart from one.** Treat a `429` from this path as "this model is not available to this
credential right now" rather than as a retryable rate limit.

Two consequences for our code:

- **The AI SDK retries a `429` three times before giving up**, so a per-model refusal costs about seven
  seconds and surfaces as `AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError: Error`.
  That message names neither the status nor the model, which makes it a bad first thing for a user to see.
- Whether an identity gate (`user-agent: claude-cli/…`, `x-app: cli`, the Claude Code system prompt, or
  the `claude-code-20250219` beta) lifts the per-model refusal was **deliberately not tested**. Sending
  those from a third-party harness is claiming to be the first-party client, which is a decision about
  Anthropic's terms rather than a transport detail. Nothing in `packages/harness` sends them.

## Provenance, graded — this part matters

The distinction that decides how much the above is worth: **a header set observed on a token-refresh or
usage call proves nothing about whether inference accepts the token.**

| Claim | Strength | Source |
| --- | --- | --- |
| The provider sends `Bearer` via `authToken`, and merges the beta header | **Very high** | Installed package source, both branches and the merge path |
| The four headers, and the exact beta value | **High** | First-party reference text, on a `/v1/messages` example |
| That a **claude.ai subscription** token is entitled to `/v1/messages` | **Verified** | Live `200` and a real reply, 2026-08-25. See "Verified live" |
| That every model is available to that token | **False** | `claude-sonnet-5` and `claude-opus-5` answered `429` while `claude-haiku-4-5-20251001` answered `200` |
| That the beta header is required on `/v1/messages` | **False for a subscription token** | Live `200` without it |

The first-party text concerns tokens from Anthropic's platform OAuth CLI, not specifically claude.ai
subscription tokens. Same transport contract, different issuing path. No first-party statement was found
that a subscription token is accepted on `/v1/messages` — the live call is what settled it, and it
settled transport compatibility today, not a supported contract.

**This repository contains no prior art for an inference call.** Every OAuth header in `deprecated/` is
on a refresh endpoint or the usage endpoint. The one supporting signal is that the login flow already
requests the `user:inference` scope, which is a necessary condition — worth asserting on the stored
token, and not sufficient on its own.

**`docs/research/harness-framework-choice.md` asserts that a spike made real Anthropic calls with
subscription identities and that the AI SDK passed. That spike's code is not in this repository** — no
`createAnthropic` call exists anywhere in the tree or in git history, and the earlier draft of that same
document records the Codex header set in detail while recording no Anthropic header set at all. The work
may well have happened outside this repo, but within it that table is an uncorroborated prose assertion
and the header set it passed with was never written down. Do not treat it as verification.

## What is still unverified

- **Why `claude-sonnet-5` and `claude-opus-5` answer `429` while `claude-haiku-4-5-20251001` answers
  `200`.** Observed, not explained. A per-model entitlement, a per-model quota, and a plan-tier gate all
  look identical from the response. Re-measure before designing around it, and note that the account's
  usage windows had headroom at the time.
- Whether any user-agent or system-prompt identity gate applies, and whether it is what separates those
  two outcomes. Not tested, on purpose — see the last bullet of "Verified live".
- Anthropic's supported surface for subscription credentials is still Claude Code and the Agent SDK. The
  live `200` establishes present-day transport compatibility, not an entitlement, and not a contract.
- **Endpoint drift.** The deprecated TUI used `platform.claude.com/v1/oauth/token` with authorization at
  `claude.com/cai/oauth/authorize`; the current binary carries a `claude.ai` client-metadata URL.
  Re-verify rather than copying the deprecated constants.
- What additional headers Claude Code sends on its own inference path. Closing this needs either a
  `strings` dump of the installed binary or a live request through a proxy, and neither was done.

A 401 will surface a missing header immediately, so the practical risk of building against the set above
is low. The live test is what converts "high confidence" into "verified".
