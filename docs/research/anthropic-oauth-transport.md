# Driving a raw AI SDK call with a Claude subscription OAuth token

Research date: 2026-08-25. Read from installed source and from first-party reference text embedded in
the Claude Code binary. **No live call had been made at the time of writing** — see "What is still
unverified".

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

**The beta header is mandatory on `/v1/messages` specifically.** Some Anthropic endpoints accept an
OAuth token without it; this one does not. That is stated in first-party reference text embedded in the
Claude Code binary, on a curl example against `/v1/messages`, which is also where the exact value
`oauth-2025-04-20` comes from. The same binary carries that value as a module constant beside the OAuth
scope constants `user:inference`, `user:profile` and `org:create_api_key`.

## Provenance, graded — this part matters

The distinction that decides how much the above is worth: **a header set observed on a token-refresh or
usage call proves nothing about whether inference accepts the token.**

| Claim | Strength | Source |
| --- | --- | --- |
| The provider sends `Bearer` via `authToken`, and merges the beta header | **Very high** | Installed package source, both branches and the merge path |
| The four headers, and the exact beta value | **High** | First-party reference text, on a `/v1/messages` example |
| That a **claude.ai subscription** token is entitled to `/v1/messages` | **Medium** | Inferred. See below |

The first-party text concerns tokens from Anthropic's platform OAuth CLI, not specifically claude.ai
subscription tokens. Same transport contract, different issuing path. No first-party statement was found
that a subscription token is accepted on `/v1/messages`.

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

- **Whether a subscription token is entitled to `/v1/messages` today.** Anthropic's supported surface
  for subscription credentials is Claude Code and the Agent SDK. A raw third-party loop depends on
  current OAuth behaviour and is not a supported contract. This is present-day transport compatibility,
  not an entitlement.
- Whether any user-agent or system-prompt identity gate applies. The first-party curl example sends no
  user-agent and is presented as working, which is mild evidence against a UA gate.
- **Endpoint drift.** The deprecated TUI used `platform.claude.com/v1/oauth/token` with authorization at
  `claude.com/cai/oauth/authorize`; the current binary carries a `claude.ai` client-metadata URL.
  Re-verify rather than copying the deprecated constants.
- What additional headers Claude Code sends on its own inference path. Closing this needs either a
  `strings` dump of the installed binary or a live request through a proxy, and neither was done.

A 401 will surface a missing header immediately, so the practical risk of building against the set above
is low. The live test is what converts "high confidence" into "verified".
