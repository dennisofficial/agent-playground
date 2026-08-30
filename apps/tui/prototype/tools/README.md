# Tool-call rendering — the harness

**PROTOTYPE. Throwaway.** The design it was built to settle now lives in `src/`; what is left here is
a harness for looking at it.

Everything it draws is the real thing: `deriveTranscript`, `EntryView`, `ToolRunBlock`,
`store/tools/{classify,aggregate}`. This directory holds a sqlite reader, a clock that replays one
real run as if it were still happening, and two keys for the settings that have no UI yet.

Five earlier variants (shipped / legacy / ledger / margin / aggregate) were cut once the sixth won.
They are parked in `.scratch/tool-rendering/variants-cut/` if any is ever worth robbing.

## Running it

```
bun run proto:tools                     # busiest thread in ~/.atlas/dev.db
bun run proto:tools -- --list           # what else is in there
bun run proto:tools -- --thread=brn_…
bun run proto:tools -- --db=/path/to.db
bun run proto:tools -- --no-live        # drop the replayed in-flight run at the end
```

Run it from the repo root in a real terminal — `bun run --filter` and `turbo run` pipe the output,
which leaves stdin un-raw and sizes the renderer to a default rather than the window.

`m` cycles the tool gutter (dim / bare / rail / accent), `t` cycles thinking (shown / streaming only
/ hidden), `o` / `O` open or close everything, click a row to open it, wheel scrolls.

## Why it still exists

Two things a settled transcript cannot show, and no unit test can either:

- **A run in flight.** The streaming window and the height ratchet only happen while a turn runs, so
  the busiest real run in the thread is replayed on a clock, looping. Real commands, real output;
  only the timing is invented.
- **Density.** Whether a design is compact is a question about a nine-hundred-event thread, not about
  a fixture with three calls in it.

## Where the design lives now

| | |
| --- | --- |
| `src/store/tool-runs.ts` | calls and runs, with the tool's output still attached |
| `src/store/tools/classify.ts` | one call in, one `Classification` out |
| `src/store/tools/bash.ts` | what a shell line actually did |
| `src/store/tools/aggregate.ts` | classifications in, rows out — pure, so density is measurable |
| `src/ui/components/blocks/tool-run-block.tsx` | the three levels |
| `src/ui/components/blocks/tool-detail.tsx` | one renderer per shape of output |
| `src/ui/tool-marks.ts` | how loudly the gutter speaks |
| `src/ui/hooks/use-high-water.ts` | a live block grows and never shrinks |

## Two things still blocked by the data

- **`write` emits no patch.** 0 of 90 write results in the store carry a `diff` — only `path`,
  `created`, `bytes` — so a created file cannot show its content. `edit` does emit one.
- **The gutter style has no setting.** `EMark.Dim` is hard-coded as `SHIPPED_MARK`; `m` here is the
  only way to see the others.
