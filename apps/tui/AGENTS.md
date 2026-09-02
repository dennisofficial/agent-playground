# apps/tui

## UI/UX

- Anything clickable must be hoverable: hovering it changes the background so the affordance is visible before the click.
- Reach for `useClickRegion` (`src/ui/hooks/use-click-region.ts`) — it wires press, hover tracking, and the `theme.hoverBg` wash in one hook.
