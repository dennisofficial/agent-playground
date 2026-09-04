# Harness path styles: Anthropic Claude Code

How Anthropic's Claude Code handles filesystem paths in its model-visible Read/Write/Edit tools,
from a context-engineering perspective.

Research date: 2026-09-04. Claude Code is closed-source, so the primary artifact inspected is the
shipped minified bundle `@anthropic-ai/claude-code@2.0.77` (published 2026-01-06, the last 2.0.x;
2.1.x — currently 2.1.261, published 2026-09-04 — ships a platform-native binary with no `cli.js`
to inspect). Bundle URL: https://unpkg.com/@anthropic-ai/claude-code@2.0.77/cli.js . All
minified identifiers below (`H4`, `Yo`, `l1`, `f0.cwd`, …) are from that artifact; quoted English
strings are verbatim from it.

Two access limitations to be transparent about:

- `docs.anthropic.com`, `code.claude.com`, and `docs.claude.com` were unreachable from the
  research machine (TLS interception / OpenDNS block). Official-docs wording is cited secondhand —
  verbatim quotes preserved inside GitHub issues on the official `anthropics/claude-code`
  tracker — rather than fetched directly.
- Anything attributed to ccprompts.info is an **unofficial mirror** that claims to have extracted
  prompts from the shipped bundle (`src/tools/FileReadTool/prompt.ts` etc.). Every mirror quote
  used below was independently confirmed against the 2.0.77 bundle, so the bundle is the real
  citation and the mirror is corroboration only.

## 1. Read/Write/Edit schemas: absolute paths are demanded in prose, not enforced

All three tools declare `file_path` as a plain string with an absolute-path *description*; nothing
in the schema (zod `strictObject`) validates absoluteness.

Verbatim from the bundle (`cli.js@2.0.77`):

- Read: `file_path: h.string().describe("The absolute path to the file to read")`
- Write: `file_path: h.string().describe("The absolute path to the file to write (must be
  absolute, not relative)")`
- Edit: `describe("The absolute path to the file to modify")` (also NotebookEdit:
  `"The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)"`)

The **tool descriptions** repeat the constraint as behavioral guidance. Read, verbatim:

> Reads a file from the local filesystem. You can access any file directly by using this tool.
> Assume this tool is able to read all files on the machine. If the User provides a path to a file
> assume that path is valid. It is okay to read a file that does not exist; an error will be
> returned.
>
> Usage:
> - The file_path parameter must be an absolute path, not a relative path
> - By default, it reads up to ${...} lines starting from the beginning of the file
> - Results are returned using cat -n format, with line numbers starting at 1
> - This tool can only read files, not directories. To read a directory, use an ls command via the
>   Bash tool.
> - …

(Mirror corroboration: https://ccprompts.info/prompts/tool/tool-file-read — same wording.)

Write, verbatim (https://ccprompts.info/prompts/tool/tool-file-write, confirmed in bundle):

> Writes a file to the local filesystem.
>
> Usage:
> - This tool will overwrite the existing file if there is one at the provided path.
> - If this is an existing file, you MUST use the Read tool first to read the file's contents. This
>   tool will fail if you did not read the file first.
> - ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly
>   required.

Edit, verbatim (https://ccprompts.info/prompts/tool/tool-file-edit, confirmed in bundle):

> Performs exact string replacements in files.
>
> Usage:
> - You must use your `Read` tool at least once in the conversation before editing. This tool will
>   error if you attempt an edit without reading the file.
> - The edit will FAIL if `old_string` is not unique in the file. …

## 2. Relative paths: told "no" in prose, silently resolved at runtime

This is the central finding. The description says absolute-only, but **no code path rejects a
relative path**. Every file tool resolves it against the harness-tracked current working directory:

- Read `validateInput`/`call`: `Yo(A)` = `isAbsolute(A) ? A : resolve(l1(), A)` where `l1()` is the
  tracked cwd.
- Edit `validateInput`: `let Y = isAbsolute(A) ? A : resolve(l1(), A)` — same pattern.
- Write `call`/`validateInput`: `H4(A)` — a normalizer that trims, expands `~`/`~/...` to the home
  directory, passes absolutes through `normalize()`, and resolves relatives against the tracked
  cwd (`resolve(B, Z)` with `B = l1() ?? originalCwd`).

Evidence that Anthropic *knows* models send relative paths anyway and measures it rather than
blocking it: Edit's read-before-write rejection carries telemetry
`meta: { isFilePathAbsolute: String(isAbsolute(A)) }` on both the "not read yet" and "string not
found" errors — they record how often the model disobeys the prose instead of hard-failing on it.

When a relative path resolves to nothing, the error message repairs the model's mental model by
naming the anchor. Verbatim from Read and Edit validation:

> File does not exist. Current working directory: ${cwd}  (appended only when cwd ≠ originalCwd)
> … Did you mean ${fuzzyMatch}?

So the context-engineering posture is: **prose demands absolute paths, the runtime forgives
relative ones against a movable anchor, and the error channel re-teaches the anchor when the
guess fails.** This is the opposite of Atlas's current zod hard-reject.

## 3. cwd: one movable anchor, tracked by `pwd` readback

**Verified: the Bash tool tracks a single persistent, mutable cwd in app state.** The bundle holds
a state object with both `f0.originalCwd` (launch dir) and `f0.cwd` (current), with setter
`Iy0(A){f0.cwd=A}`; `l1()` returns the current cwd, falling back to `originalCwd`.

The mechanism, verbatim from the bundle: every Bash command is wrapped as

> `source <shell-snapshot> && eval <command> && pwd -P >| <tmpfile>`

and on successful completion the harness reads the tempfile back and calls `TL(pwd)`, which
canonicalizes it (`realpathSync`) and stores it in `f0.cwd`. The next Bash spawn starts with
`cwd: <stored cwd>`.

Qualifiers, all verified in the bundle or in the official issue tracker:

- **cd only sticks on success.** The readback runs only when the command succeeded and wasn't a
  background task (`if (m && !Y && !m.backgroundTaskId) try { TL(...) }`). Official issue
  [#30720](https://github.com/anthropics/claude-code/issues/30720): "When a Bash tool command
  includes cd and exits with a non-zero exit code, the working directory change is silently
  discarded."
- **Workspace-boundary auto-reset.** After each command, if the new cwd falls outside the
  permission context's working directories, the harness resets `f0.cwd` back to `originalCwd` and
  appends a line to the tool result — verbatim: `Shell cwd was reset to ${originalCwd}` (bundle;
  empirically confirmed in official issue
  [#45478](https://github.com/anthropics/claude-code/issues/45478)). The env var
  `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` forces reset-to-project-dir after every command
  (bundle: `G0(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)`). The official
  tools-reference doc, quoted verbatim in issue #45478: "Working directory persists across
  commands. Set `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` to reset to the project directory
  after each command." (https://code.claude.com/docs/en/tools-reference — not directly fetched;
  quote preserved in the issue.)
- **The tool description instructs the model not to move it.** Bash description, verbatim from the
  bundle: "The working directory persists between commands, but shell state does not." and "Try to
  maintain your current working directory throughout the session by using absolute paths and
  avoiding usage of `cd`. You may use `cd` if the User explicitly requests it." — with a
  `<bad-example>` of `cd /foo/bar && pytest tests` versus `<good-example>` `pytest /foo/bar/tests`.
- **File tools follow the shell's anchor.** Read/Edit/Write all resolve relatives against the same
  `f0.cwd` (§2), so a `cd` inside Bash silently re-roots the file tools too — the "two roots"
  failure mode `docs/architecture.md` warns about is real, and Claude Code manages it with the
  readback + reset + error-message machinery above rather than by refusing the split.

## 4. The architecture.md claims, checked

Claim under test (`docs/architecture.md:890-891`): Claude Code "lets one cwd move and pays for it
in validation: seven read-back rejections, forced approval for compound `cd`, per-subagent cwd
pinning."

- **"lets one cwd move"** — **Verified.** §3: one mutable `f0.cwd`, moved by `pwd` readback.
- **"forced approval for compound cd"** — **Verified, verbatim.** The Bash permission gate
  contains two distinct hard-`ask` paths (bundle):
  > "Commands that change directories and perform write operations require explicit approval to
  > ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine
  > the final working directory when 'cd' is used in compound commands."
  > (decisionReason: "Compound command contains cd with write operation - manual approval required
  > to prevent path resolution bypass")

  and the same message for output redirection ("…write via output redirection require explicit
  approval…", decisionReason "Compound command contains cd with output redirection …"). So a
  compound command containing `cd` + a write/redirect is never auto-approved; it falls to the
  human.
- **"seven read-back rejections"** — **Loose; the verifiable structure is different.** Edit's
  `validateInput` has **nine** enumerated rejection sites (`errorCode` 1–9): 1 no-changes,
  2 denied-directory, 3 create-over-existing, 4 file-does-not-exist, 5 ipynb, 6 **not-read-yet**,
  7 **modified-since-read**, 8 string-not-found, 9 multiple-matches. Write's has three (1 denied,
  2 not-read-yet, 3 modified-since-read). Of these, only four sites total (Write 2–3, Edit 6–7)
  are read-back rejections in the read-before-write sense. If "seven" meant "Edit's validation
  rejects through errorCode 7 before touching content", that reading works, but the bundle does
  not contain a natural group of seven. The claim's substance — the movable cwd is paid for with a
  stack of pre-write validation rejections — is accurate; the numeral is not precisely checkable.
- **"per-subagent cwd pinning"** — **Not found in 2.0.77; refuted for that version.** The subagent
  spawn (`Task` tool path) invokes the query loop with **no cwd parameter at all**; subagents run
  against the same global `f0.cwd` as the parent (their Bash calls spawn with the shared tracked
  cwd and mutate the same state on readback). What subagents *do* get is (a) a **copy** of the
  parent's `readFileState` (`readFileState: P2A(parent.readFileState)` — a clone of the
  read-before-write map, so a subagent may edit files the parent read), and (b) the parent's
  `additionalWorkingDirectories` threaded into the subagent system-prompt builder. No per-subagent
  cwd pin, snapshot, or restore is visible in the bundle. (Caveat: 2.1.x is a native binary and
  uninspectable by this method; pinning may have been added after 2026-01-06.)

## 5. Other notable findings

- **Path normalization before permission checks — verified.** Both the deny check and the
  allow-rule evaluation run on the *resolved* absolute path, not the model's raw string:
  `SF(Y, permissionContext, "edit"|"read", "deny")` where `Y = isAbsolute(A) ? A : resolve(cwd,
  A)`, and Write uses the fuller `H4` normalizer. The path the human approved against is the
  canonical one. The workspace-containment check (`MP`) additionally flattens the macOS
  `/private/var` ↔ `/var` symlink pair before comparing, so permission rules can't be bypassed or
  spuriously broken by that alias.
- **Tilde expansion — verified, but inconsistent across tools.** `H4` expands `~` and `~/...` to
  the home directory; Write (and anything else routed through `H4`) accepts tilde paths. Read's
  `Yo` and Edit's *validateInput* resolver are plain `isAbsolute ? A : resolve(cwd, A)` — a `~`
  path there resolves to `<cwd>/~/...` and fails. Edit's `call` then re-resolves through `H4`, so
  the validate and execute paths of Edit can key on different strings for tilde inputs.
- **Read-before-write is keyed on the resolved path *string* — verified.** `readFileState` is an
  LRU map (`max: 1000`) keyed by the resolved absolute path. Read populates it with
  `{ content, timestamp: mtimeMs(path), offset, limit }`; Write/Edit look up
  `readFileState.get(resolvedPath)` and reject with "File has not been read yet. Read it first
  before writing to it." when absent, and compare current `mtimeMs` against the stored timestamp,
  rejecting with "File has been modified since read, either by the user or by a linter. Read it
  again before attempting to write it." when stale. Because the key is a string produced by two
  different resolvers (see tilde inconsistency above), alias paths can miss the cache.
- **Subagents inherit read state by copy.** `readFileState: P2A(parent.readFileState)` — a clone,
  so subagent edits to parent-read files pass the freshness check, but reads the subagent performs
  do not flow back into the parent's map.
- **Permissions docs (secondhand).** Per https://code.claude.com/docs/en/permissions (fetched via
  search-engine extraction, not directly): "Claude Code checks file permissions against Edit
  (path) and Read (path) rules only. If you write a path rule for Write, NotebookEdit, Glob, or
  the legacy MultiEdit tool instead, Claude Code accepts the rule but never consults it, and warns
  at startup…" — i.e. Write permission is governed by the *Edit* rules, consistent with Write and
  Edit sharing the same read-before-write state machine in the bundle.

## Implications for Atlas

1. **The absolute-path requirement is prose in Claude Code, not schema.** Atlas currently encodes
   in zod what Anthropic encodes in the system prompt plus a forgiving resolver. The observed
   Claude Code failure mode — model sends a relative path — is *measured and repaired in the error
   channel* ("Current working directory: …"), not rejected. Atlas's hard-reject dies before the
   Guard hook that was designed to absolutize: the ordering bug means Atlas is stricter than the
   reference harness it cites, in a way that produces dead turns rather than teaching moments.
2. **Fixing the ordering (Guard absolutizes before validation) matches the reference design.**
   Claude Code's resolver is exactly "absolutize against the tracked anchor, then permission-check
   the canonical string" — the shape the Guard hook was designed for. The bundle also shows the
   two prerequisites Atlas needs to get right when it does so: resolve **before** the permission
   check (never approve a raw string), and key read-before-write state on the **same canonical
   string** the resolver emits, with one resolver shared by every tool (Claude Code's two-resolver
   split is what produces its tilde key-mismatch).
3. **One anchor, one error channel.** Claude Code's repair message names the anchor whenever it
   matters (`Current working directory: <cwd>` appended to not-found errors). If Atlas keeps a
   single project-directory anchor and resolves relatives against it, its not-found errors should
   say what the path resolved to — that is the cheapest anti-confusion lever the reference harness
   demonstrates.
4. **The architecture.md numeral should be softened.** "Seven read-back rejections" and
   "per-subagent cwd pinning" are not what the shipped artifact shows (nine-point Edit validator
   with four read-back sites; subagents share the parent's cwd and inherit read state by copy).
   The load-bearing contrast — movable cwd paid for in validation vs. Atlas's fixed project
   directory — stands, but the sentence's specifics overclaim.
