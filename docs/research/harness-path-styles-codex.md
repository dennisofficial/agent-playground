# Harness path styles: OpenAI Codex

How OpenAI's `codex` coding-agent harness handles filesystem paths in its model-visible file
tools, from a context-engineering perspective. All citations are permalinks pinned to
`main` HEAD `9c4253ffc1b954337bf2f494aadc55e9cd132a48` (2026-09-04).

Repo: https://github.com/openai/codex (Rust core under `codex-rs/`).

## 1. Tool surface: no read_file/write_file; shell + apply_patch only

Codex does **not** expose `read_file` or `write_file` tools to the model. The full tool tree under
`codex-rs/core/src/tools/handlers/`
([directory listing](https://github.com/openai/codex/tree/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers))
contains `exec_command` / `write_stdin` (unified shell exec), `apply_patch`, `view_image`
(images only), plan/agent/MCP tools — and no generic file read or write tool. File I/O is
funneled through two surfaces:

- **Reads** go through the shell. The system prompt says so explicitly:
  "Parallelize tool calls whenever possible - especially file reads, such as `cat`, `rg`, `sed`,
  `ls`, `git show`, `nl`, `wc`."
  ([gpt_5_2_prompt.md:252](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/gpt_5_2_prompt.md#L252))
  and "When searching for text or files, prefer using `rg`..."
  ([gpt_5_codex_prompt.md:5](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/gpt_5_codex_prompt.md#L5))
- **Writes/edits** go through the `apply_patch` tool (a freeform, grammar-constrained custom
  tool, not JSON). Registration is gated per-model on
  `model_info.apply_patch_tool_type.is_some()`
  ([spec_plan.rs:1255-1258](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/spec_plan.rs#L1255-L1258)),
  and the only variant left in the enum is `Freeform` — the older JSON-schema variant is gone
  ([openai_models.rs:314-318](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/protocol/src/openai_models.rs#L314-L318)).

Stated rationale:

- The tool-spec comment: "Returns a custom tool that can be used to edit files. Well-suited for
  GPT-5 models https://platform.openai.com/docs/guides/function-calling#custom-tools"
  ([apply_patch_spec.rs:7-8](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L7-L8))
  — i.e. the format is grammar-constrained (Lark grammar attached to the tool) and the model is
  trained on it.
- The prompt frames it as a safety/parseability choice: "Your patch language is a stripped-down,
  file-oriented diff format designed to be easy to parse and safe to apply."
  ([gpt_5_2_prompt.md:256](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/gpt_5_2_prompt.md#L256))
- Editing policy in the codex prompt: "Try to use apply_patch for single file edits, but it is
  fine to explore other options to make the edit if it does not work well. Do not use apply_patch
  for changes that are auto-generated (i.e. generating package.json or running a lint or format
  command like gofmt) or when scripting is more efficient (such as search and replacing a string
  across a codebase)."
  ([gpt_5_codex_prompt.md:11](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/gpt_5_codex_prompt.md#L11))
  — i.e. shell remains the sanctioned escape hatch for writes apply_patch is bad at.
- Token-economy rationale for the patch surface: "Do not waste tokens by re-reading files after
  calling `apply_patch` on them. The tool call will fail if it didn't work."
  ([gpt_5_2_prompt.md:130](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/gpt_5_2_prompt.md#L130))

Notable: even when the model bypasses the tool and runs `apply_patch` as a shell command, codex
**intercepts** it inside the exec_command handler and routes it through the same verified native
patch pipeline (`intercept_apply_patch`,
[handlers/apply_patch.rs:499-545](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/apply_patch.rs#L499-L545),
called from
[exec_command.rs:385-418](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L385-L418)).
A legacy warning told the model "Use the apply_patch tool instead of exec_command"
([legacy_apply_patch_exec_command_warning.rs:22-24](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/context/legacy_apply_patch_exec_command_warning.rs#L22-L24)).

## 2. Path style and resolution: both absolute and relative, anchored to the environment cwd

The grammar accepts any path — `filename: /(.+)/`
([apply_patch.lark:10](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/assets/tools/apply_patch.lark#L10))
— with no absolute/relative restriction anywhere in the schema, grammar, or validation. There is a
dedicated test named `test_parse_patch_accepts_relative_and_absolute_hunk_paths`
([parser.rs:455](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/apply-patch/src/parser.rs#L455))
and `test_apply_patch_hunks_accept_relative_and_absolute_paths`
([lib.rs:928](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/apply-patch/src/lib.rs#L928)).

The resolution chain, verbatim:

1. The handler passes the **turn environment's cwd** into verification
   ([handlers/apply_patch.rs:403-409](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/apply_patch.rs#L403-L409)):
   ```rust
   match codex_apply_patch::verify_apply_patch_args_with_mode(
       args,
       turn_environment.cwd(),
       ...
   ```
2. Verification computes an effective cwd (an optional `workdir` — only set when a patch arrives
   via shell interception — is joined onto the environment cwd) and resolves every hunk against it
   ([invocation.rs:227-234](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/apply-patch/src/invocation.rs#L227-L234)):
   ```rust
   let effective_cwd = workdir
       .as_ref()
       .map(|dir| cwd.join(dir))
       .transpose()?
       .unwrap_or_else(|| cwd.clone());
   ...
       let path = hunk.resolve_path(&effective_cwd)?;
   ```
3. `resolve_path` is just a join
   ([parser.rs:85-91](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/apply-patch/src/parser.rs#L85-L91)):
   ```rust
   pub fn resolve_path(&self, cwd: &PathUri) -> Result<PathUri, PathUriParseError> {
       let path = match self { ... };
       cwd.join(&path.to_string_lossy())
   }
   ```
4. `PathUri::join` semantics
   ([path-uri/src/lib.rs:445-463](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/utils/path-uri/src/lib.rs#L445-L463)):
   an **absolute native path replaces the base entirely** ("An absolute native path is already
   fully resolved, so replace the base URI's main path instead of appending it"), a relative path
   is appended segment-by-segment with `.`/`..` resolved **lexically** (each `..` pops one segment,
   clamped at the root — so `../../etc` cannot escape the filesystem root but *can* walk above the
   anchor cwd)
   ([lib.rs:514-530](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/utils/path-uri/src/lib.rs#L514-L530)).
   A separate `join_descendant` rejects absolute or escaping relative paths
   ([lib.rs:534-553](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/utils/path-uri/src/lib.rs#L534-L553))
   but is used for permission-config paths, not for model-supplied patch paths.

The anchor is **turn/environment-scoped, never the process cwd**. The (deprecated-but-explicit)
doc comment on the turn context states the contract
([turn_context.rs:223-227](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/session/turn_context.rs#L223-L227)):

```rust
/// The session's absolute working directory. All relative paths provided
/// by the model as well as sandbox policies are resolved against this path
/// instead of `std::env::current_dir()`.
#[deprecated(note = "use the selected turn environment cwd instead")]
pub(crate) cwd: AbsolutePathBuf,
```

The current anchor is `TurnEnvironment.cwd()` = `selection.cwd`
([turn_context.rs:112-114](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/session/turn_context.rs#L112-L114)).
The model is told the anchor via the injected `<environment_context>` message, which renders a
`<cwd>` element
([world_state/environment.rs:316-319](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/context/world_state/environment.rs#L316-L319)).

## 3. What the model is told about path style (verbatim)

The apply_patch tool description says nothing about paths at all:

> "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the
> patch in JSON."
> ([apply_patch_spec.rs:20](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L20))

Path style is taught by *example*, not rule: the prompt's grammar walkthrough uses relative paths
(`*** Add File: hello.txt`, `*** Update File: src/app.py`)
([gpt_5_2_prompt.md:254-278](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/gpt_5_2_prompt.md#L254-L278)).

The shell tool's `workdir` parameter description states the anchor:

> "Working directory for the command. Defaults to the turn cwd."
> ([shell_spec.rs:40-46](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/shell_spec.rs#L40-L46))

The permission-request surface does state a style rule — approvals want absolute paths:

> "Absolute paths to grant read access; omit when none are needed." / "Absolute paths to grant
> write access; omit when none are needed."
> ([shell_spec.rs:311-330](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/shell_spec.rs#L311-L330))

while the `request_permissions` description adds "Relative filesystem paths resolve against the
selected environment cwd."
([shell_spec.rs:193-196](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/shell_spec.rs#L193-L196)).

For *prose* file references in the final message, both styles are explicitly accepted:

> "Accepted: absolute, workspace‑relative, a/ or b/ diff prefixes, or bare filename/suffix."
> ([gpt_5_codex_prompt.md:64](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/gpt_5_codex_prompt.md#L64))

## 4. Shell cwd behavior vs. the patch anchor

Same anchor, one override parameter, no cross-call persistence:

- Each `exec_command` call resolves its `workdir` against the **turn environment cwd**
  (`native_environment_cwd`), falling back to it when omitted — absolute `workdir` replaces the
  base via the same `join` semantics
  ([exec_command.rs:196-205](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L196-L205)):
  ```rust
  let cwd = environment_args
      .workdir
      .as_deref()
      .filter(|workdir| !workdir.is_empty())
      .map_or_else(
          || Ok(native_environment_cwd.clone()),
          |workdir| native_environment_cwd.join(workdir),
      )
      ...
  ```
- There is **no `cd` tracking**: the resolved cwd is per-request state (`request.cwd`,
  [process_manager.rs:244](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/unified_exec/process_manager.rs#L244));
  nothing writes a `cd` back into the turn environment. A `cd` inside a `cmd` affects only that
  process. Persistence exists only *within* one interactive session (a still-running process kept
  alive across `write_stdin` calls via `session_id`), not across tool calls.
- The request carries both `cwd` (where the command runs) and `sandbox_cwd:
  native_environment_cwd` (the sandbox anchor)
  ([exec_command.rs:428-429](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L428-L429))
  — so a `workdir` override never moves the sandbox's notion of home base.
- Net effect: shell `workdir` and apply_patch paths share **one immutable-per-turn anchor**; the
  model can deviate per call but cannot drift the anchor. This is exactly the "movable project
  directory" problem Atlas faces, solved by *not* moving it mid-turn.

## 5. Enforcement: sandbox and approvals key on resolved absolute paths

Path style is never a hard validation error in codex; enforcement happens **after** resolution,
on the absolute `PathUri`:

- **Sandbox gating per patch path.** `assess_patch_safety` auto-approves only if every target
  (including `*** Move to:` destinations) passes
  `file_system_sandbox_policy.can_write_path(path, context)`; otherwise it asks the user, or
  rejects outright with a reason string the model can act on ("writing outside of the project;
  rejected by user approval settings")
  ([safety.rs:29-85](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/safety.rs#L29-L85),
  [safety.rs:106-140](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/safety.rs#L106-L140),
  rejection strings at
  [safety.rs:11-14](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/safety.rs#L11-L14)).
  Even an in-policy patch still runs sandboxed because "it is possible that paths in the patch are
  hard links to files outside the writable roots"
  ([safety.rs:66-69](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/safety.rs#L66-L69)).
- **Approval gating by path.** For patch targets not already writable, codex derives
  *parent-directory* write permissions and folds them into the approval request
  (`write_permissions_for_paths`,
  [handlers/apply_patch.rs:238-280](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/apply_patch.rs#L238-L280)).
  Shell commands can carry per-command `additional_permissions` with absolute read/write path
  lists ([shell_spec.rs:308-337](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/shell_spec.rs#L308-L337)),
  and granted permissions are sticky per turn or per session.
- **No read-before-write keying.** Nothing tracks "did the model read this file first." The only
  freshness control is the prompt's dirty-worktree rules ("NEVER revert existing changes you did
  not make...", [gpt_5_codex_prompt.md:12-19](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/gpt_5_codex_prompt.md#L12-L19))
  and the patch applier's own context-match failure ("The tool call will fail if it didn't work").
- **Descendant-only joins for config-supplied paths.** Where a path comes from trusted-ish config
  rather than the model, `join_descendant` rejects absolute or `..`-escaping paths
  ([path-uri/src/lib.rs:534-553](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/utils/path-uri/src/lib.rs#L534-L553)).
  Model-supplied patch paths get the permissive `join`; the sandbox writable-root check is the
  backstop.
- Windows tool guidance tells the model to verify resolved absolute paths before recursive
  deletes ([shell_spec.rs:339-344](https://github.com/openai/codex/blob/9c4253ffc1b954337bf2f494aadc55e9cd132a48/codex-rs/core/src/tools/handlers/shell_spec.rs#L339-L344)).

## Implications for Atlas

Atlas's read/edit/write tools currently hard-reject relative paths in zod, and the Guard-stage
hook that would absolutize them against the project directory runs *after* validation, so
relative paths die before they can be fixed. Codex's design points the other way on every axis:

1. **Accept both styles; resolve late.** Codex's schema/grammar places zero restriction on path
   form. Relative paths resolve against a single turn-scoped anchor (`environment cwd`), absolute
   paths pass through unchanged (`join` replaces the base). The Atlas analog: let the schema
   accept relative paths and absolutize in the Guard hook — the fix is ordering validation after
   absolutization (or dropping the absolute-only rule), not a new mechanism.
2. **One immutable anchor, stated in context and in tool prose.** Codex injects `<cwd>` into
   `<environment_context>` and restates "Defaults to the turn cwd" in the `workdir` parameter
   description. The anchor never moves mid-turn — `cd` in a shell command does not drift it, and
   `workdir` overrides are per-call. Atlas's movable project directory is fine exactly because the
   resolution anchor should be the session/turn snapshot of it, not a live global.
3. **Teach by example and description, not by rejection.** Codex's apply_patch description says
   nothing about paths; the prompt's examples model relative usage, and failures surface as
   actionable errors ("writing outside of the project; rejected by user approval settings")
   rather than schema rejections.
4. **Enforce on resolved paths at execution time.** Sandbox writable-root checks and
   approval-by-path all operate on the absolute resolved path, after resolution. Whatever Atlas
   rejects should be rejected there ( Guard/hook stage, post-absolutization), where the path being
   judged is the path that will actually be touched.
