# Atlas Design System — how to build with it

Atlas is the operator console for a coding-agent orchestrator. One light theme ("Daylight"), a warm-grey canvas with a burnt-amber accent, a restrained/desaturated status palette, and a three-font system. Components are imported from `window.AtlasDS.*`.

## Setup — no wrapper needed

There is **no provider or theme context**. Every component reads its color, radius, and font from CSS custom properties defined on `:root` and shipped in `styles.css` (which `@import`s `_ds_bundle.css` — the tokens — and the brand webfonts). Render a component and it is already themed. Do not wrap the tree in anything.

## Styling idiom — tokens first, then the mapped utilities

Style your **own** layout with the CSS variable tokens; they are always present in `styles.css` and are the guaranteed on-brand surface. The library also ships the Tailwind v4 utility classes it uses (each maps 1:1 to a token), so `className="bg-surface text-dim rounded-md"` works for the vocabulary below — but for anything the components don't already use, reach for the `var(--*)` token, not an invented utility class.

**Surfaces:** `--bg` (page canvas) · `--panel` / `--surface` (white cards) · `--surface-2` / `--surface-3` (subtle fills) — utilities `bg-panel` `bg-surface` `bg-surface-2`.
**Borders:** `--border` (hairline) · `--border-2` (stronger) · `--hair` — utilities `border-border` `border-border-2`.
**Text:** `--text` (primary) · `--dim` (secondary/labels) · `--muted` · `--faint` (tertiary) — utilities `text-text` `text-dim` `text-faint`.
**Accent (burnt amber):** `--accent` · `--accent-2` (gradient end) · `--accent-soft` (10% tint) · `--accent-line` (hairline) — utilities `text-accent` `bg-accent-soft`. The primary Button already renders the `--accent → --accent-2` gradient.
**Status palette (desaturated, meaning-bearing — don't recolor):** `--accent` running/active · `--blue` planning & review · `--green` done · `--red` failed · `--slate` needs-you / awaiting-approval · `--faint` paused. Prefer the status components (`StatusPill`, `StatusDot`, `StatusPie`) over hand-coloring.
**Radius / shadow:** `--r` (7px, `rounded-md`) · `--r-sm` · `--r-lg` (`rounded-lg`) · `--shadow-card` (the Card elevation).
**Fonts:** body is **Geist** (default). `font-disp` = **Space Grotesk** (the ATLAS wordmark / display). `font-mono` = **JetBrains Mono** (labels, captions, badges, code).

## Where the truth lives

Read `styles.css` and its `@import`ed `_ds_bundle.css` for the full token set (200 vars) before styling. Each component has a `<Name>.prompt.md` with its props and real usage examples — read it before composing.

## Components

`Button` · `Card` · `Field` · `PasswordField` · `StrengthMeter` (forms) · `Spinner` · `BrandLockup` · `GoogleG` (brand) · `StatusPill` · `StatusDot` · `StatusPie` · `KindBadge` · `Dot` (status).

## Idiomatic snippet

```jsx
const { Card, StatusPill, Button } = window.AtlasDS;

<Card style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
    <span style={{ fontWeight: 600, color: 'var(--text)' }}>Add /health endpoint</span>
    <StatusPill status="awaiting_approval" />
  </div>
  <p style={{ fontSize: 13, color: 'var(--dim)', margin: 0 }}>
    Expose a version + uptime probe so the orchestrator can verify a green build.
  </p>
  <div style={{ display: 'flex', gap: 8 }}>
    <Button variant="primary">Approve plan</Button>
    <Button variant="ghost">Cancel</Button>
  </div>
</Card>
```
