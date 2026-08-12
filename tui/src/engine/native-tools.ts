/**
 * The native kit, as an ALLOWLIST.
 *
 * Never a denylist: a denylist admits every tool Anthropic ships next month by nobody's decision,
 * where an allowlist means a new arrival is dark until someone chooses it. And the choosing follows
 * a rule rather than a list, so it survives the next SDK bump:
 *
 * > **A native tool is IN if it acts inside the current turn, on the workspace or the web. It is OUT
 * > if it manages context, orchestration, scheduling, or the human relationship — those are Atlas's
 * > seams.**
 *
 * One uniform list, not a per-role set. Legacy had a separate "read-only" review kit with `Bash` in
 * it, so it was theatre — any reviewer with a shell is one `sed -i` from writing. The honest version
 * is structural: the reviewer is a teammate that reports and the builder fixes in its own context.
 * **The Atlas tools are the only role-varying axis; the native kit is the same for every thread.**
 *
 * `Options.tools` is the lever, and this is a trap worth naming: `allowedTools` is the
 * auto-*approval* list ("these run without prompting"), NOT a restriction — passing a short
 * `allowedTools` while leaving `tools` unset leaves every other native tool present and merely
 * asking. `tools` is what makes an excluded tool absent.
 */
export const NATIVE_TOOLS: readonly string[] = [
  // Acts on the workspace, inside the turn. The whole reason a coding agent exists.
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  // Fan-out. Ruled out at first as a rival orchestrator and reinstated: a sweep over fifteen files
  // in a subagent's window is context OFFLOADING, which is the thesis, not a competing harness.
  'Agent',
  'TaskOutput',
  'TaskStop',
  // Watching a long build without burning a turn per poll is a builder's daily need.
  'Monitor',
  // Same reasoning as `Agent` — a declared fan-out over a list. Using it for JOB-level structure is
  // a system-prompt matter, not a tool-list one.
  'Workflow',
  'Skill',
  'WebSearch',
  'WebFetch',
  // Inert until an MCP server is wired, and kept now precisely so it is not forgotten later.
  'ListMcpResources',
  'ReadMcpResource',
  'RefreshMcpTools',
];

/**
 * The exclusions, recorded as data even though `tools` above already makes them absent.
 *
 * Not passed to the SDK — an allowlist needs no denylist beside it, and one that had to be
 * maintained would rot the moment a name changed. This exists so the reasoning is greppable from
 * the file that enforces it, and so a test can assert the two lists never overlap.
 */
export const NATIVE_TOOLS_OUT: Readonly<Record<string, string>> = {
  TodoWrite: 'replaced by Atlas thread tasks — the native list dies at session rotation',
  TaskCreate: 'same: native task state is session-scoped, Atlas tasks outlive the leg',
  TaskUpdate: 'same',
  TaskGet: 'same',
  TaskList: 'same',
  EnterPlanMode: 'advance_phase is the plan gate; plan mode is read-only and planning writes specs/',
  ExitPlanMode: 'see EnterPlanMode',
  AskUserQuestion: 'questions are prose — the turn ending IS the ask, on every engine',
  EnterWorktree: 'moves the work without telling Atlas, leaving Job.workspacePath a lie',
  ExitWorktree: 'see EnterWorktree',
  CronCreate: 'scheduling is a harness concern and Atlas has no host-initiated turn',
  CronDelete: 'see CronCreate',
  CronList: 'see CronCreate',
  ScheduleWakeup: 'deferred, not rejected — it needs a turn nobody typed',
  RemoteTrigger: 'see CronCreate',
  PushNotification: 'the human relationship is Atlas’s',
  Artifact: 'product surfaces, not workspace acts',
  ClaudeDesign: 'see Artifact',
  Projects: 'see Artifact',
  SendFeedback: 'see Artifact',
  ProposeSkills: 'skills are files',
  ShowOnboardingRolePicker: 'see Artifact',
  ReportFindings: 'folded into the hand-off prose',
  REPL: 'see Artifact',
  NotebookEdit: 'see Artifact',
};
