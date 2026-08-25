# Hooks and DI spike findings

Source: `.spikes/hooks-di/` (gitignored). 46 passing tests, `tsc --noEmit` clean, model fully
stubbed. Bun 1.3.14, macOS arm64. Recorded 2026-08-24.

## The one-file property is real — but the glob buys it, not the container

Adding a hook costs one file and no edits elsewhere, enforced mechanically rather than asserted:

```ts
test('no file under src/ mentions the new hooks', () => {
  const mentions = sourceFiles(SRC_DIR).filter((file) =>
    NEW_HOOK_NAMES.some((name) => readFileSync(file, 'utf8').includes(name)))
  expect(mentions).toEqual([])
})
```

The mechanism is 18 lines of `Bun.Glob` + dynamic import, filtered by module namespace rather than a
global side-effect array (a global array is import-cache- and order-dependent and leaks hooks
between tests). Nest only resolves constructor dependencies, and has no multi-provider, so one is
emulated with `{ provide: HOOKS, useFactory: (...instances) => instances, inject: classes }`.

Two leaks past the one file: a hook needing a new config knob also edits the shared `HarnessConfig`
(fix: namespaced config slices keyed by hook name), and the compiled build needs a regenerated
manifest (below).

## Nest does not earn its weight — measured

| | |
| --- | --- |
| `import @nestjs/core + common + reflect-metadata` | **~50 ms every process start** |
| — `rxjs` alone, which the harness never uses | 17 ms |
| `reflect-metadata` alone | 0.8 ms |
| `NestFactory.createApplicationContext` (warm) | 0.87 ms median |
| glob discovery alone | 0.03 ms |
| hand-wiring 3 hooks + 3 tools with `new` | 0.04 ms |
| `node_modules` | 14.4 MB (rxjs alone 11 MB) |

The container is essentially free; the import is the entire bill, and for a TUI it is 50 ms of dead
time before the first frame on every launch. The strongest evidence sits inside the spike: its own
tests use no container at all — `new HookPipelineService([late, new RewriteEarly(), first])`.

Nest charges three module files (~92 lines) plus the vocabulary of `@Global`, `DynamicModule`,
`useExisting`, and a faked multi-provider, to resolve three constructors out of six injectables.

**Recommendation: tsyringe (~12 kB) + the same glob.** Identical one-file property, no module system,
no rxjs, no optional-peer bundling landmines. Do **not** hand-roll a container: constructor injection
by type means reading `design:paramtypes` plus `@Inject` overrides, which is precisely what those
libraries are. A plain registry only works if each hook hand-declares `static deps`, a per-hook edit.

Nest still wins on: dozens of providers, lifecycle hooks (`onModuleDestroy` for the SQLite store and
provider sessions), branch-scoped instances, and being already proven in Atlas.

## `bun build --compile`: three findings, one fatal

The binary was actually built and run, not reasoned about.

**(a) Nest's optional peers break the bundle outright.** `@nestjs/common` and `@nestjs/core`
`require()` packages that were never installed, and Bun resolves statically:

```
error: Could not resolve: "class-validator" / "class-transformer"
error: Could not resolve: "@nestjs/microservices" / "@nestjs/websockets/socket-module"
error: Could not resolve: "@nestjs/platform-express"
```

Eight `--external` flags fix it. Not a blocker, but nobody guesses it first time and each Nest
upgrade can add another. tsyringe has none of this.

**(b) Runtime glob discovery does not survive compilation.** The binary builds clean, then dies:

```
ENOENT: no such file or directory, open '/$bunfs/root/hooks/'
```

Nothing statically imports the hook files, so they are not in the bundle, and `Bun.Glob` is scanning
a virtual filesystem. **The one-file property and `--compile` are in direct tension.** Resolution: run
the same glob at *build* time and emit static imports, with the composition root reading the
decorator registry instead of the disk. A spec fails if the manifest drifts from the directory.
Compiled boot: 7.6 ms, ~40 ms total process. **This applies to any DI choice — it is a Bun bundling
fact, not a Nest one.**

**(c) `--minify` silently destroys class names.** `WorkspaceBoundaryHook` becomes `RJ`. DI still works
(class references are the tokens), but everything name-derived degrades: the order tiebreak, the
`decidedBy` audit trail, deny reasons shown to the user, any config keyed by hook name. Either do not
minify, or make the decorator take an explicit `name`. Tool names are safe — they are strings on the
definition.

Contrary to the usual worry, decorators and `emitDecoratorMetadata` are fine: TypeScript 7.0.2
typechecks them, Bun transpiles them, and `design:paramtypes` survives into the binary.

## Conflict resolution: deny wins, and it is order-free

Every hook is consulted, nobody short-circuits, and a pure function resolves by severity
(`deny > ask > allow`), naming every dissenter so the UI can say who blocked what. Tested with the
same two hooks constructed in both orders.

**But the verdict is order-independent while input threading is order-dependent**, and that bit for
real: `WorkspaceBoundaryHook` canonicalises `path` to its realpath, which on macOS turns
`/var/folders/...` into `/private/var/...`, after which `ClaudeMdInjectionHook` failed to find memory
files **for every write** because its root was still the symlinked form. Two hooks, each correct
alone, silently disagreeing about what a path *is*. Only a test exercising write + injection together
caught it. **Any harness letting hooks rewrite tool input needs a stated normalisation contract.**

## A privilege-escalation shape, found and closed

An approval returning `editedInput` was **skipping every `BeforeTool` check** — a human could approve
`delete_path`, redirect it from a workspace file to `/etc/hosts`, and the boundary hook would never
see it. Edited input is now re-checked once, with `ask` treated as already-answered so it cannot
loop. The approval flow was trusting human-edited input more than model-proposed input, which is
backwards when the edit is the thing that changed.

## Ordering

Order matters in three places: the sequential folds (ordinary), `BeforeTool` input threading (the
trap above), and `OnChunk`, where returning `null` drops the chunk so later hooks never run —
**redaction must precede anything that logs or persists chunks**, which is a security constraint, not
a preference.

Expressed as an integer on the decorator with a name tiebreak so glob order can never leak into
behaviour. **The magic numbers are the weak part**: they work at three hooks and rot at thirty, where
two authors both pick 50 and an alphabetical tiebreak silently decides security policy. Replace the
bare integer with named stages (Guard | Policy | Observe) and keep numbers only for nudging within a
stage.

## `AfterTool => Event[]` is wrong in two ways

1. **Hooks cannot mint `Event`, only `EventDraft`** — `seq` is the log's core invariant. Independently
   found by the core-loop spike.
2. **The signature has no context, so dedup leaks into every hook.** "Load `CLAUDE.md` once" is a
   question about the log, but `(call, output)` cannot see it, so the hook had to inject the log.
   **Fix: make `append` idempotent on `(branchId, slot, key)`** — `context-loaded.key` already *is*
   the identity — and the hook goes back to stateless.

What hooks wanted and could not do: fail the turn or annul a tool result; see a batch (ten parallel
calls fire the hook ten times, wrong for anything reasoning over "the model just touched these six
files"); and know whether a tool mutates — the boundary hook had to inject the registry, so the
tool's `effect` should be on the call.

`OnChunk => Chunk | null` earned its keep: the redaction fixture drops a reasoning delta leaking an
API key in 16 lines.

A tool that throws is mapped to a `tool-result` carrying `{error}` with dispatch status `failed`,
not `denied` — *denied should mean policy said no, not that the disk was missing.*

## Other cracks

- **Discovery is process-global.** The decorator mutates a module-level map at import time, so
  decorating a fake hook inside a spec registers it for the life of the process. Namespace-filtered
  glob discovery immunises the normal path; the compiled path is safe only because the manifest
  controls what is imported.
- The spike's `assemble()` is a 37-line stub that does **not** preserve `providerOptions` on reasoning
  parts. The assembly spike owns that; do not read this file as a proposal.
