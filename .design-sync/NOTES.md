# design-sync notes — Atlas Design System

Project: **Atlas Design System** (`dda2eee5-bb8f-4b54-aca6-ea89e04a920f`) on claude.ai/design.
Synced 2026-07-01. Shape: `package` (off-envelope — see below).

## What this repo is (read first)

This is **not** a component-library package or a Storybook — it's the `web/` Next.js operator console. The synced design system is a hand-scoped slice:

- **6 source files** in `web/src/components/ui/` (`button, card, badges, brand, field, spinner`) → **13 exported components**.
- **Tokens** from `web/src/app/globals.css` (Tailwind v4 `:root` + `@theme inline`, the single "Daylight" theme).

Scope was chosen by the user: **UI primitives + tokens only.** Feature components under `web/src/features/*/components/` are deliberately out of scope.

## How the off-envelope build works

There is no `dist/` and no library entry, so two custom pieces bridge to the converter — both driven by `cfg.buildCmd` = `node .design-sync/prebuild.mjs`:

1. **Bundle entry barrel.** `prebuild.mjs` writes `web/.design-sync-build/entry.tsx`, a barrel re-exporting the 6 UI files. `--entry` points at it. **Why a barrel:** `resolvePackage` feeds `--entry` straight to `resolveDistEntry`, so a bare `--entry <one file>` ships only that file's exports (12/13 components would be missing from `window.AtlasDS`). The barrel lives under `web/` so `PKG_DIR` anchors to the web app (pkg name `web` is "generic" → `globalName` is forced to the explicit `AtlasDS`).
2. **Compiled stylesheet.** `globals.css` is a Tailwind v4 *source* (`@import "tailwindcss"`), not shippable CSS. `prebuild.mjs` runs `@tailwindcss/cli` (installed in `.ds-sync/`) on `.design-sync/tw-compile.css` → `web/.design-sync-build/styles.css` (= `cfg.cssEntry`). `tw-compile.css` `@import`s `globals.css`, `@source`s `web/src` + the previews dir (so used utilities get generated), and **supplies the `--f-*` font vars + loads the three brand fonts from Google Fonts** (next/font injects those at runtime in the app; they don't exist in `globals.css`). The remote `@import` is why validate prints `[FONT_REMOTE]` — expected, not a problem.

`srcDir: "src/components/ui"` scopes discovery to the 6 files. `tsconfig: tsconfig.json` resolves the `@/` aliases (`@/lib/cn`, `@/lib/api/status`). No provider needed — components read tokens from CSS vars only.

## Exact commands (first sync used these)

```
node .design-sync/prebuild.mjs   # = cfg.buildCmd — barrel + tailwind compile
node .ds-sync/package-build.mjs --config .design-sync/config.json \
  --node-modules web/node_modules --entry ./web/.design-sync-build/entry.tsx --out ./ds-bundle
node .ds-sync/package-validate.mjs ./ds-bundle
```

Node v22.13.1 (fnm; PATH warning is cosmetic). `--node-modules web/node_modules` (has react 19.2.7 + lucide-react).

## Playwright

Render check uses playwright imported from `.ds-sync/`. Installed **playwright@1.60.0** there — it pins chromium **1223**, already cached at `~/Library/Caches/ms-playwright/` (macOS path, NOT `~/.cache`). No browser download was needed.

## Grouping

Groups come from `cfg.docsMap` → category stubs in `.design-sync/groups/*.md` (frontmatter `category:`). Actions/Brand/Feedback/Forms/Status/Surfaces. `.prompt.md` bodies still synthesize from the `.d.ts` + preview examples.

## Known render warns (triaged clean)

- `[FONT_REMOTE]` (JetBrains Mono / Space Grotesk / Geist) — expected; fonts load from Google Fonts at runtime.
- `[GRID_OVERFLOW]` on BrandLockup + Card was fixed with `cfg.overrides.<n>.cardMode = "column"`. If it recurs, that's the remedy.

## Empty-pane gotcha (fixed 2026-07-01) — package shape needs cards registered

The `package`-shape upload ships a `_ds_needs_recompile` marker and expects the claude.ai/design **app-side self-check** to compile `_ds_manifest.json` into the pane's card index (and clear the flag). That self-check did NOT run — the marker stayed set on the remote → the Design System pane showed **"empty folder"** even though all 13 components + a well-formed `_ds_manifest.json` (13 cards, groups, 200 tokens) were uploaded and the project type was correct (`PROJECT_TYPE_DESIGN_SYSTEM`). It looked different from the other four DSes because those use the older hand-authored `preview/*.html` shape with cards registered directly.

**Fix applied:** explicitly registered the 13 cards via `DesignSync.register_assets` (finalize_plan → write_files the 13 `components/**/*.html` → register_assets), groups Actions/Brand/Feedback/Forms/Status/Surfaces, viewports 720x480 (900x700 for BrandLockup + Card). The client-side bundle (`_ds_bundle.js`) is already compiled, so cards render once indexed. Reversible via `unregister_assets`.

**On every re-sync, verify the pane is non-empty.** If the package-shape self-check still doesn't run (marker `_ds_needs_recompile` remains after upload), re-register the cards as above — do NOT assume the `@dsCard` auto-index worked. Longer-term alternative: rebuild Atlas in the proven `preview/*.html` shape the other DSes use.

## Re-sync risks / watch-list

- **Component set is hard-coded in three places.** Adding/removing a UI primitive means editing ALL of: `prebuild.mjs` `files[]`, `cfg.componentSrcMap`, `cfg.docsMap`. They don't self-discover.
- **Fonts are remote + hand-listed.** If `web/src/app/layout.tsx` changes the fonts/weights, mirror the change in `.design-sync/tw-compile.css` (the Google Fonts `@import` + the `--f-*` vars). Fully offline environments render fallback fonts.
- **Tailwind utility coverage is scan-bound.** The compiled CSS only contains utilities found in `web/src` + `.design-sync/previews` at build time. New preview classes need a rebuild (buildCmd reruns tailwind, so this is covered as long as buildCmd runs). Designs the agent builds should prefer `var(--*)` tokens for custom layout (documented in `conventions.md`).
- **Tokens track the app automatically** — `tw-compile.css` `@import`s the live `globals.css`, so a theme change in the app flows through on the next rebuild.
- **Guidelines:** `web/docs/repos-tab-design-brief.md` ships to `guidelines/` via the default `guidelinesGlob`. Intentional (it's design context). Narrow `cfg.guidelinesGlob` to drop it.
- The bundle inlines `lucide-react` (field.tsx Eye/EyeOff icons); React 19.2.7 is vendored into `_vendor/`.

## Re-sync procedure

Fetch the project's `_ds_sync.json` → `.design-sync/.cache/remote-sync.json`, re-copy `.ds-sync/` staged scripts, then:

```
node .ds-sync/resync.mjs --config .design-sync/config.json \
  --node-modules web/node_modules --entry ./web/.design-sync-build/entry.tsx \
  --out ./ds-bundle --remote .design-sync/.cache/remote-sync.json
```

On a fresh clone also re-run the `.ds-sync` dep install (`npm i esbuild ts-morph @types/react @tailwindcss/cli playwright@1.60.0`).
