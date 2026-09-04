# Path handling in opencode and pi file tools

Research date: 2026-09-04. Question: how do the opencode and pi coding-agent harnesses handle
filesystem paths in their read/write/edit tools — schema contract, resolution anchor, tool
description prose, working-directory model, and related context-engineering details.

Both upstream repositories have been renamed/transfered, and GitHub redirects the old names:

- `sst/opencode` → `anomalyco/opencode`, default branch `dev`, HEAD `5cf9f517cfec3ef68d3e68a12a6a4b3163947f44`.
  Note: the current `dev` branch is an Effect-Schema rewrite of the tools — the older zod-based
  implementations the question anticipated are gone from this branch. Semantics are unchanged.
- `badlogic/pi-mono` → `earendil-works/pi`, default branch `main`, HEAD `17de82d7bea18a6589677a9761baabc2060c9efb`.
  The coding agent lives at `packages/coding-agent` (tools under `src/core/tools/`).

All permalinks below pin those SHAs.

## opencode

Base URL: `https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44`

### 1. Schema: both relative and absolute accepted

The schema types `filePath` as a plain string; nothing rejects a relative path. The parameter
*description* says "absolute", but that is prose, not validation.

read — [packages/opencode/src/tool/read.ts#L28-L36](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/read.ts#L28-L36):

```ts
export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file or directory to read" }),
  offset: Schema.optional(NonNegativeInt).annotate({ ... }),
  limit: Schema.optional(NonNegativeInt).annotate({ ... }),
})
```

write — [packages/opencode/src/tool/write.ts#L20-L25](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/write.ts#L20-L25):

```ts
export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})
```

edit — [packages/opencode/src/tool/edit.ts#L47-L56](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/edit.ts#L47-L56):

```ts
export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  oldString: Schema.String.annotate({ description: "The text to replace" }),
  ...
})
```

### 2. Relative paths resolve against the instance directory, inside `execute`

All three tools absolutize as the first step of execution, against `instance.directory` — the
directory the opencode instance was opened with, not `process.cwd()` and not any bash cd state.

read — [read.ts#L234-L237](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/read.ts#L234-L237):

```ts
let filepath = params.filePath
if (!path.isAbsolute(filepath)) {
  filepath = path.resolve(instance.directory, filepath)
}
```

write — [write.ts#L41-L43](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/write.ts#L41-L43) and edit —
[edit.ts#L80-L82](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/edit.ts#L80-L82):

```ts
const filepath = path.isAbsolute(params.filePath)
  ? params.filePath
  : path.join(instance.directory, params.filePath)
```

`instance.directory` comes from `InstanceContext` ([packages/opencode/src/project/instance-context.ts#L5-L9](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/project/instance-context.ts#L5-L9)),
which is loaded per directory by the InstanceStore and canonicalized with a realpath-based
`FSUtil.resolve` at load time ([packages/opencode/src/project/instance-store.ts#L108-L118](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/project/instance-store.ts#L108-L118);
the store cache is keyed by that resolved directory). The context also carries `worktree` (the git
worktree root, or `"/"` for non-git global projects — [packages/opencode/src/project/project.ts#L217](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/project/project.ts#L217)).

### 3. Tool descriptions say "absolute" — and contradict the code

read.txt — [packages/opencode/src/tool/read.txt#L4](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/read.txt#L4):

> `- The filePath parameter should be an absolute path.`

write.txt ([packages/opencode/src/tool/write.txt](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/write.txt))
and edit.txt ([packages/opencode/src/tool/edit.txt](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/edit.txt))
say nothing about paths at all; the write schema annotation "(must be absolute, not relative)" is
the strongest statement, and the executor quietly accepts relative paths anyway. So the contract is:
soft "please send absolute" prose over a permissive executor that fixes up relative input.

### 4. Fixed per-instance anchor; bash gets a per-call `workdir`, no cd tracking

The anchor is fixed for the life of an instance (server mode runs multiple instances keyed by
directory, but each is immutable once loaded). The bash/shell tool spawns a **fresh shell per call**
with an explicit `cwd` — there is no persistent shell and no cd tracking across calls
([packages/opencode/src/tool/shell.ts#L293-L310](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/shell.ts#L293-L310)).
Instead it takes a `workdir` parameter, resolved against the same instance directory
([shell.ts#L610-L614](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/shell.ts#L610-L614)):

```ts
const cwd = params.workdir
  ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
  : instanceCtx.directory
```

The bash description steers the model away from cd
([packages/opencode/src/tool/shell/prompt.ts#L260-L261](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/shell/prompt.ts#L260-L261)
and [#L112](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/shell/prompt.ts#L112)):

> `All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.`

So file tools and bash share one fixed anchor (`instance.directory`); `workdir` moves the shell for
one call only, and file tools never see that movement.

### 5. Other notable context-engineering details

- **External-directory permission gate.** Every read/write/edit (and bash, via AST path scanning)
  calls `assertExternalDirectoryEffect`: if the resolved path is outside both `instance.directory`
  and `instance.worktree` (`containsPath`), the user is asked for an `external_directory`
  permission ([packages/opencode/src/tool/external-directory.ts#L15-L45](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/external-directory.ts#L15-L45),
  [instance-context.ts#L18-L24](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/project/instance-context.ts#L18-L24)).
  Read can bypass it with `ctx.extra["bypassCwdCheck"]` ([read.ts#L250-L253](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/read.ts#L250-L253)).
- **Permissions key on worktree-relative paths.** The permission ask uses
  `patterns: [path.relative(instance.worktree, filepath)]` (e.g. [write.ts#L54-L62](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/write.ts#L54-L62)),
  so what the user approves is displayed relative to the worktree.
- **Edit locking is keyed on the canonical path.** Per-file semaphores use
  `FSUtil.resolve(filePath)`, which realpaths (symlink-resolving) with an ENOENT fallback
  ([edit.ts#L35-L45](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/edit.ts#L35-L45),
  [packages/core/src/fs-util.ts#L247-L255](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/core/src/fs-util.ts#L247-L255)).
  The path used for actual I/O is *not* canonicalized — only the lock key is.
- **No read-before-write enforcement.** write.txt claims "This tool will fail if you did not read
  the file first" and edit.txt claims "You must use your `Read` tool at least once... This tool will
  error", but neither write.ts nor edit.ts contains such a check at this SHA, and a repository code
  search for the old `FileTime` tracking mechanism finds nothing. The claim is prose-only in the
  current dev branch.
- **Truncation.** read caps at 2000 lines / 2000 chars per line / 50 KB with actionable
  continuation notices ([read.ts#L13-L17](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/read.ts#L13-L17));
  a generic wrapper truncates every tool's output and spills overflow to a file
  ([packages/opencode/src/tool/tool.ts#L131-L144](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/tool.ts#L131-L144)).
- **Edit resilience.** edit runs nine fallback replacers (line-trimmed, block-anchor with
  Levenshtein similarity, whitespace/indentation/escape normalized, etc.) before failing
  ([edit.ts#L682-L729](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/edit.ts#L682-L729)).

## pi

Base URL: `https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb`

### 1. Schema: both relative and absolute accepted — and said so

TypeBox schemas, and unlike opencode the parameter description states the permissiveness plainly.

read — [packages/coding-agent/src/core/tools/read.ts#L15-L19](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/read.ts#L15-L19):

```ts
const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});
```

write — [packages/coding-agent/src/core/tools/write.ts#L12-L15](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/write.ts#L12-L15):
`path: Type.String({ description: "Path to the file to write (relative or absolute)" })`

edit — [packages/coding-agent/src/core/tools/edit.ts#L33-L42](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/edit.ts#L33-L42):
`path: Type.String({ description: "Path to the file to edit (relative or absolute)" })`

### 2. Relative paths resolve against the session cwd, inside `execute`

Every file tool resolves `resolveToCwd(path, ctx?.cwd || cwd)`: the per-call `ExtensionContext.cwd`
wins, falling back to the `cwd` captured when the tool definition was created. Both are the same
session cwd in practice.

- read — [read.ts#L101](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/read.ts#L101):
  `const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);`
- write — [write.ts#L66](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/write.ts#L66):
  `const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);`
- edit — [edit.ts#L162](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/edit.ts#L162):
  `const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);`

`resolveToCwd` ([packages/coding-agent/src/core/tools/path-utils.ts#L48-L50](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/path-utils.ts#L48-L50))
delegates to `resolvePath` ([packages/coding-agent/src/utils/paths.ts#L102-L106](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/utils/paths.ts#L102-L106)):

```ts
export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}
```

The `ctx.cwd` value is `ExtensionRunner.cwd` ([packages/coding-agent/src/core/extensions/runner.ts#L740-L742](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/extensions/runner.ts#L740-L742)),
constructed with the AgentSession's `_cwd`, which is set once in the constructor and never reassigned
([packages/coding-agent/src/core/agent-session.ts#L391](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/agent-session.ts#L391)).
The SessionManager persists it in the session header
([packages/coding-agent/src/core/session-manager.ts#L877](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/session-manager.ts#L877)).

### 3. Tool descriptions say little about paths

read description ([read.ts#L74](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/read.ts#L74)):

> `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`

write description ([write.ts#L53-L54](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/write.ts#L53-L54)):

> `Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.`

edit description ([edit.ts#L152-L153](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/edit.ts#L152-L153)):

> `Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. ...`

None of the three tool descriptions mention absolute vs relative; that guidance lives only in the
parameter descriptions ("(relative or absolute)"). The system prompt does carry the cwd itself
(`buildSystemPrompt` gets `cwd` — [agent-session.ts#L1089](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/agent-session.ts#L1089)),
so the model knows what "relative" means.

### 4. Session cwd is fixed per session but can be *rebound* on resume; bash shares it

Within a session the anchor is immutable — SessionManager has no cwd setter. But pi supports
**changing the effective cwd when resuming or importing a session** via `cwdOverride`
([packages/coding-agent/src/core/agent-session-runtime.ts#L210-L215](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/agent-session-runtime.ts#L210-L215)),
guarded by `assertSessionCwdExists` ([packages/coding-agent/src/core/session-cwd.ts#L54-L59](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/session-cwd.ts#L54-L59)).
Crucially, all cwd-bound services — tool definitions, resource loader, extension runner — are
recreated when that happens
([packages/coding-agent/src/core/agent-session-services.ts#L31-L35](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/agent-session-services.ts#L31-L35):
"These services are recreated whenever the effective session cwd changes").

The bash tool has **no `workdir` parameter** (schema is just `command` + `timeout` —
[bash.ts#L38-L41](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/bash.ts#L38-L41))
and spawns a fresh subprocess per call with `cwd: ctx?.cwd || cwd`
([bash.ts#L248-L254](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/bash.ts#L248-L254),
[bash.ts#L95-L96](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/bash.ts#L95-L96)).
Its description says only "Execute a bash command in the current working directory..."
([bash.ts#L235](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/bash.ts#L235)).
A `cd` inside a command therefore affects only that subprocess. File tools and bash always share
the single session-cwd anchor.

### 5. Other notable context-engineering details

- **Aggressive input normalization before resolution.** `normalizePath`
  ([utils/paths.ts#L75-L100](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/utils/paths.ts#L75-L100))
  strips a leading `@` (pi's CLI @file convention), expands `~`, converts `file://` URLs, maps
  unicode space variants to plain spaces, and rewrites Git Bash/MSYS/Cygwin drive paths on Windows.
  The file tools opt into `@`-stripping and unicode-space normalization via `resolveToCwd`.
- **macOS filename fallback on read.** `resolveReadPathAsync`
  ([path-utils.ts#L86-L118](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/path-utils.ts#L86-L118))
  retries the resolved path in NFD-normalized, narrow-no-break-space (screenshot "AM/PM"), and
  curly-quote variants before giving up — aimed at pasted screenshot filenames.
- **Write/edit serialization keyed on canonical path.** `withFileMutationQueue` realpaths the
  target (ENOENT fallback to the unresolved path) and serializes mutations per key
  ([packages/coding-agent/src/core/tools/file-mutation-queue.ts#L16-L26](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/file-mutation-queue.ts#L16-L26)).
  As in opencode, the I/O path itself is not canonicalized — only the queue key.
- **No path sandbox in the tools.** No external-directory check, no permission hook in read/write/
  edit; any absolute path is writable. (Trust/gating lives elsewhere, e.g. project trust.)
- **No read-before-write enforcement** anywhere in edit/write; `getFileRevision` exists in
  utils/paths.ts but is used only for config/auth-store freshness, not edit gating.
- **Model-input leniency.** edit's `prepareArguments` repairs common malformed calls — `edits` sent
  as a JSON string, or a single `{oldText,newText}` object instead of an array
  ([edit.ts#L104-L135](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/edit.ts#L104-L135)).
- **Truncation.** 2000 lines / 50 KB for both read and bash output
  ([packages/coding-agent/src/core/tools/truncate.ts#L11-L12](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/truncate.ts#L11-L12));
  read's truncation notices embed a concrete next step, including a bash `sed` fallback when a
  single line exceeds the byte cap ([read.ts#L153-L167](https://github.com/earendil-works/pi/blob/17de82d7bea18a6589677a9761baabc2060c9efb/packages/coding-agent/src/core/tools/read.ts#L153-L167)).
  Bash truncation spills full output to a temp file and returns its path.

## Implications for Atlas

Atlas currently hard-rejects relative paths in the read/edit/write zod schemas, while a Guard-stage
hook was designed to absolutize them against a movable project directory — and validation runs
before the hook, so relative paths die before the hook can fix them. Against these two reference
harnesses:

1. **Both harnesses accept relative paths at the schema layer and resolve inside `execute`.**
   Neither puts path absoluteness in validation. Atlas's zod-level rejection is stricter than both
   references; the natural fix is to make the schema permissive (plain string) and absolutize in the
   executor — or absolutize in a pre-validation transform — rather than reject. A Guard hook that
   runs after validation can never fill this role; the ordering itself has to change.
2. **Prose and enforcement are separate levers, and opencode exploits that.** opencode's descriptions
   say "absolute" while the executor accepts relative — models overwhelmingly comply with the prose,
   and the permissive executor rescues the remainder without an error round-trip. pi goes the other
   way and documents "(relative or absolute)" openly. Either works; hard schema rejection is the one
   option neither harness chose. (Atlas memory: prefer prose and teaching refusals over detectors.)
3. **One anchor, shared by file tools and shell — and it does not move mid-session in either
   harness.** opencode pins an instance directory (bash `workdir` moves one call at a time, resolved
   against that same directory); pi pins a session cwd (bash has no `workdir` at all). Neither
   tracks `cd`. Both spawn a fresh shell per bash call. Atlas's "movable project directory" is a
   genuine divergence: if the project directory can move, pi's resume-time rebind is the model to
   copy — when the anchor changes, *recreate everything cwd-bound* (tool definitions, system prompt,
   resource loading) so file tools and bash never disagree about what `relative` means. A cd that
   only moves bash's cwd while file tools stay anchored elsewhere would be a state no reference
   harness permits.
4. **Resolve-then-key.** Both harnesses realpath-canonicalize the path used to key per-file
   serialization (opencode's edit locks, pi's mutation queue) but use the plain resolved path for
   I/O and permissions. For Atlas's read-before-write tracking, key on `path.resolve(anchor, input)`
   at minimum, realpath if symlink aliasing matters — never on the raw model-supplied string, since
   the same file arrives as absolute and relative spellings.
5. **Cheap model-ergonomic wins worth stealing:** pi's `@`-prefix stripping and `~` expansion before
   resolution; opencode's permission patterns expressed worktree-relative so approval UI shows short
   paths; both harnesses' actionable truncation notices that name the exact next `offset`.
