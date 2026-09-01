# How many images to keep in the prompt, and at what resolution

Research date: 2026-09-01. Provider claims are from the Claude platform docs fetched that day and are
quoted inline with links. Repo claims were executed against the working tree, not read off.

## Conclusion

`context.imagesKept` should not exist. Its fallback of 2 was far too low and its maximum of 8 had no
basis in any provider limit — the API accepts 100 images per request on a 200k-context model — but
the deeper problem was the mechanism, not the number. Rolling per-image retirement buys 478 tokens of
cache read per step and costs up to 138,000 tokens of prefix re-write each time it fires, and it
fires precisely when the retired image sits furthest back and the tail behind it is longest.
Compaction already drops images for free. The only image limit worth enforcing is the one the API
punishes: twenty blocks per request.

Two defects were found while establishing the numbers, and both matter more than the tuning question
that prompted the investigation:

1. `imagesInContext` counts images across the whole transcript with no notion of the current turn, so
   attaching ten images to one message retires eight of them **before the first model step of the turn
   that attached them**. Executed, not inferred — see [The ten-image case](#the-ten-image-case).
2. `fitted()` caps only the long edge. The API caps the long edge **and** the visual-token count, and
   for ordinary screenshots the token cap is the binding one. `visualTokens` therefore over-reports by
   16–21% on exactly the large images the budget exists to control.

The resolution ceiling should not be lowered to 1280. It should not be a constant at all: the ceiling
is a property of the model, and the same screenshot costs 4,760 visual tokens on a high-resolution
tier model and 1,568 on a standard tier one.

## Q1 — provider ground truth

### Token cost is patch-based

> "Claude views images in patches instead of pixels. Each patch is a 28×28-pixel block of the image,
> referred to as a visual token. An image, therefore, costs `⌈width / 28⌉ × ⌈height / 28⌉` visual
> tokens."
>
> — [Vision](https://platform.claude.com/docs/en/build-with-claude/vision)

The in-repo `PATCH_EDGE = 28` and the formula in `visualTokens` are correct. The older `(w × h) / 750`
heuristic does not appear in the current documentation.

### There are two limits, and the token limit usually binds

| Resolution tier | Models | Max long edge | Max visual tokens |
| --- | --- | --- | --- |
| High-resolution | Claude 4.7 and later | 2576 px | 4784 |
| Standard | All other models | 1568 px | 1568 |

> "Claude finds the largest aspect-preserving size that satisfies both of the model's image limits …
> For nearly all photos and screenshots, the visual token limit is what determines the final size. The
> edge limit takes over only for elongated images such as panoramas or tall phone screenshots."
>
> — [Coordinates and bounding boxes](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates)

The documentation names the trap directly: a 1920×1080 screenshot resizes to 1456×819, **not** 1568×882.
A 1075×1520 A4 scan has both sides under 1568 px and is still resized to 924×1307, because
`39 × 55 = 2145` tokens exceeds the standard tier's 1568.

That page carries a reference implementation — binary search along the long edge, banker's rounding on
the short edge, with the edge test applied to the *padded* size (`⌈w/28⌉ × 28 ≤ maxEdge`). It is worth
porting verbatim rather than approximating. Ported and validated against the doc's own example, it
reproduces `resizedSize(1075, 1520) → (924, 1307)`.

Measured against the current `visualTokens`:

| Image | `visualTokens` says | Actual, high-res tier | Error | Actual, standard tier |
| --- | --- | --- | --- | --- |
| 6000×4000 photo | 5,704 | 2352×1568 = **4,704** | +21% | 1344×896 = 1,536 |
| 2576×1673 screenshot | 5,520 | 2380×1546 = **4,760** | +16% | 1372×891 = 1,568 |
| 3024×1964 (MBP full screen) | 5,520 | 2380×1546 = **4,760** | +16% | 1372×891 = 1,568 |
| 2000×1299 screenshot | 3,384 | 3,384 | 0% | 1372×891 = 1,568 |
| 900×900 synthetic | 1,089 | 1,089 | 0% | 1,089 |

The handoff's "settled facts" of 5,520 and 5,704 tokens per screenshot are inflated for this reason and
should not be carried forward.

### Padding

> "Claude then pads every image, resized or not, up to the next multiple of 28 pixels on the bottom and
> right edges."

Already implicit in the `⌈⌉` of the token formula; it matters only for coordinate work.

### How many images per request

> "The maximum number of images per message or request is: 20 per message on claude.ai. 100 per request
> on the API, for models with a 200k-token context window. 600 per request on the API, for all other
> models."

And the rule that actually constrains an agent loop:

> "If a single API request contains more than 20 images, a stricter per-image dimension limit applies to
> **every** image in that request. All `image` blocks in the request count toward this threshold,
> including images from earlier conversation turns that you resend and images nested inside
> `tool_result` content … To stay under the limit on all platforms, either resize each image so that
> neither dimension exceeds 2000 px, or keep the request to 20 or fewer image and document blocks."

This is a cliff, not a gradient: the 21st image retroactively degrades the other twenty. Because
tool-result images count, a `read-image`-heavy turn can cross it without the operator attaching
anything. Twenty total image blocks is therefore a real ceiling for a harness, well below the nominal
100.

### Hard limits

- Maximum dimensions 8000×8000 px. `MAX_API_EDGE = 8000` is correct.
- 10 MB base64 per image on the Claude API; 5 MB on Bedrock and Vertex. `MAX_INLINE_BYTES = 5 MB` is the
  conservative choice, not the API's own limit.
- Formats: JPEG, PNG, GIF, WebP. "Animations are unsupported, and only the first frame is used."

### Resizing locally saves no tokens

Confirmed and unchanged: token cost is computed on the size the API resizes to, so pre-resizing to the
ceiling saves upload bytes only. What pre-resizing *does* buy is determinism —
`transformations: {"oversized_image": "error"}` turns silent server-side resizing into a 400 naming the
exact target size, which is the mechanism to use if coordinates ever become load-bearing.

## Q2 — prompt caching

> "Images & Documents: Content blocks in the `messages.content` array, in user turns"
>
> — [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), "What can be cached"

Image blocks are cacheable. Invalidation is strictly prefix-based:

> "the cache follows the hierarchy: `tools` → `system` → `messages`. Changes at each level invalidate
> that level and all subsequent levels."

Multipliers: 5-minute cache write 1.25×, 1-hour write 2×, cache read 0.1×. Minimum cacheable prompt for
Opus 5 is 512 tokens. Maximum 4 breakpoints, lookback window 20 blocks — both matching
`CACHE_BREAKPOINT_BUDGET` and `CACHE_LOOKBACK_BLOCKS`.

### What retirement actually costs

Retiring an image rewrites the transcript *behind* the newest content, so it invalidates every cached
block after the retired image. At Opus 5's $5/MTok input price, with a 4,784-token image:

| Transcript after the retired image | One-time re-write | Break-even |
| --- | --- | --- |
| 5,000 tok | $0.03 | 12 steps |
| 20,000 tok | $0.12 | 48 steps |
| 50,000 tok | $0.29 | 120 steps |
| 120,000 tok | $0.69 | 288 steps |

Retirement saves `4784 × 0.1 = 478` tok-eq per step, or $0.0024. The invalidation is real but cheap;
the reason not to retire aggressively is not that retirement is expensive, it is that it **buys almost
nothing** while costing legibility.

The stronger argument is upstream: `compactedHistory` runs before `imagesInContext` in
`defaultRules` and drops covered messages outright, images included. Images already leave context at
compaction, at a point where the prefix is being rewritten regardless. A rolling per-image retirement
is a second mechanism solving a problem the first one already handles for free.

## The ten-image case

Executed against `imagesInContext({ keep: () => 2 })` with a single user message carrying ten image
parts:

```
"review these ten",
"[image dropped from context: shot-0.png · image/png 1024×768]",
… eight of these …
"IMAGE",
"IMAGE"
```

The rule computes `allowance = total - keep` over the entire transcript and spends it walking messages
front to back, so the allowance lands inside the message being submitted. There is no test covering
more than `keep` images in one message, so nothing locks in this behaviour.

`SaidImage[]` on the `user-said` event, `UserMessage.content`, and `saidContent` in
`messages-from-events` all handle N images without a cap. The composer appends without bound. The
assembly rule is the only place that destroys them.

## What other harnesses do

| Harness | Images retained | Resize before send | Crop / region read | Configurable |
| --- | --- | --- | --- | --- |
| [OpenCode](https://github.com/sst/opencode/blob/dev/packages/core/src/session/compaction.ts) | All, every turn. No image-specific eviction; only whole-history compaction drops them, leaving `[Attached image/png: name]` | Yes — Photon/WASM Lanczos3 to [2000×2000 px / 5 MB](https://github.com/sst/opencode/blob/dev/packages/core/src/image/photon.ts) | No | Yes — `attachment.image.{auto_resize,max_width,max_height,max_base64_bytes}` |
| [Aider](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py) | All, re-encoded and re-sent every request | None — raw bytes to a base64 data URL | No | No; `detail: high` is hardcoded |
| [Cline](https://github.com/cline/cline/blob/main/apps/vscode/src/core/prompts/responses.ts) | Whole-message sliding window, not image-aware | None | No | No |
| [Continue](https://github.com/continuedev/continue) | Prunes oldest whole messages; images counted as a flat 1024 tokens | Unverified | No | Unverified |
| Claude Code | Undocumented | Undocumented | Undocumented | Undocumented |
| pi.dev | Unverified | Unverified | Unverified | Unverified |

Two things stand out.

**No surveyed harness retires images by count.** Every one of them keeps images live until a
whole-history mechanism — compaction or a sliding window — drops the entire message. Atlas's
per-image rolling retirement is the anomaly, and OpenCode's post-compaction
`[Attached image/png: name]` is close to `withoutPixels` in spirit while firing only at compaction.
That is independent support for recommendation 1: let `compactedHistory` be the mechanism.

**No surveyed harness has a crop or region read.** Recommendation 7 is not catching up to the field;
it is ahead of it.

OpenCode's 2000 px default is worth noting because it coincides exactly with the dimension Anthropic
names for many-image requests, though OpenCode is multi-provider and may have arrived there by another
route.

### OpenAI's `detail`, for contrast

The tile-family models (gpt-4o, gpt-4.1, gpt-5.1) make `low` a flat price — 85 tokens regardless of
dimensions — which is the clean version of the "how much fidelity do you need" control. The
patch-family models (gpt-5.2 onward) reuse the name for a resize directive and the
[docs warn](https://developers.openai.com/api/docs/guides/images-vision) that "`low` does not always
use fewer tokens than `high`"; on gpt-5.4, `low` is the *larger* budget. The lesson for a per-read
detail hint (idea 3 in the handoff) is to express it as a token budget, not as an opaque quality name
that has already meant two incompatible things at one vendor.

## Adjacent defects found

- **Subagents receive no pixels.** `apps/tui/src/composition/app.tsx:564` calls `submissionOf` with
  `load: () => null` whenever a subagent view is focused, so every attached image degrades to a path
  line. Not a tuning knob — a capability gap.
- **Paste-time `sips -Z` conflicts with region-crop.** `apps/tui/src/ui/clipboard-image.ts:125-136`
  writes a copy into the conversation image directory and then shrinks *that copy*, so the operator's
  clipboard source is never mutated — the handoff's stated concern does not apply. The resize is still
  wrong: it saves zero tokens and permanently discards the resolution that `NativeImage.extract()`
  would need to send one pane of a four-pane screenshot at native size.
- **`describedSize` decodes base64 on every assembly** to recover dimensions that `SaidImage` already
  carries as `width`/`height`.

## What was landed

| Change | Commit |
| --- | --- |
| `projection.ts` holds the two-limit search and the tier table; `visualTokens` measures against both | `3e1ed33c` |
| Retirement fires at twenty image blocks rather than two; `context.imagesKept` removed | `792a07cb` |
| Paste-time `sips` gone; one delivery plan holding only the ceilings the API enforces | `d9508552` |
| Breakpoint placement around images pinned by test | `dfb5c043` |
| Estimator takes its tier from the model; dimensions ride the part instead of being decoded | `f4383f54` |
| A subagent is handed the pixels, through the steering queue as well as the append | `6b403209` |
| `read` takes a `region`, cut by a PNG decode rather than a shell-out | `c91b7197` |

A visual-token budget was **considered and dropped**. Once retirement fires only at the twenty-block
cliff, the budget has nothing left to price: the block count is what the API punishes, and the
context window is already governed by auto-compaction. A budget would have been a second limiter
tuned against a constraint that no longer binds. The count survived because the constraint it now
encodes is itself a count.

The newest-turn exemption was also dropped, for the same reason: with the limit at twenty, a
ten-image message is honoured without needing a special case. It would only matter for a message
carrying more than twenty images at once, where retiring the oldest is defensible anyway.

### What the measurements came to

- The estimator decoded every image's base64 on every count. Twenty resident images cost **310 ms
  per `countTokens`**, a call made each model step and again for every compaction preview. Carrying
  `width`/`height` on the part took it to **0 ms** for the same answer.
- A pane of `warp-desktop-2.png` (2576×1673) is **1,380 visual tokens against 4,760** for the frame,
  and arrives at native 1288×836 rather than downscaled to 2380×1546.

### The `sips` crop bug

`sips -c <h> <w> --cropOffset <top> <left>` returns the image **untouched, exit code 0** when
`top > 0`, `left == 0`, and `top + h` equals the image height exactly. Verified on macOS 15 against
a four-quadrant test image: `--cropOffset 200 0` on a 400×400 with `-c 200 200` gives back the whole
400×400, while `199 0`, `201 0`, `200 1` and `200 200` all crop correctly. Asking for one row of
overhang works around it but shifts the region up a pixel. That is why the crop decodes the PNG
instead, which also keeps the arithmetic exact and the tests pure.

## Still open

| # | Change | Rationale |
| --- | --- | --- |
| 1 | Crop a format that is not PNG | Declined by name today; JPEG needs a decoder, and gains less, since a photograph downscales gracefully |
| 2 | Let the TUI's own display path know the tier | `projection.ts` takes one and the loop passes it; the three display call sites still default |
| 3 | Consider the Files API for attachments | Upload once, reference by `file_id`; removes the resend-bytes-per-turn cost that paste-time resize was half-addressing |
| 4 | Verify pi.dev, and Claude Code's retention | Both unverified above rather than guessed |

Not recommended: **model-generated alt text on retirement.** The existing placeholder already carries
path, media type and dimensions, and the model can re-`read` the file. A real description would need to
be generated at attach time and stored on the event — `core` performs no I/O, so it cannot be produced
inside the rule — which is a per-image cost paid for a path most images will never take once
retirement becomes rare.

Not recommended: **lowering the ceiling to 1280.** The operator's objection stands. A dense four-pane
screenshot is already marginal at 2576; 1280 would make terminal text unreadable, and the token saving
is available more precisely through the budget in recommendation 2.
