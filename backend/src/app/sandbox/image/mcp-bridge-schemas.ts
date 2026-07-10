/**
 * JSON-schema descriptions for the host bridge tools a Codex writer thread uses, so the model fills the
 * right fields. The MCP server forwards the WHOLE arguments object as the `tool_request` `args`, which is
 * exactly what the host handlers read (`args['summary']`, etc.). Unknown tools get a permissive schema
 * (kept in `mcp-bridge-server.ts`, alongside its ListTools handler). Extracted from `mcp-bridge-server.ts`
 * so it can be imported/tested without running that file's `main()` (which needs env + calls process.exit).
 */
export const TOOL_SCHEMAS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  report_verification: {
    description:
      'Report the verification you ran for a DIRECT BUILD before shipping. Pass passed:true only once ' +
      'diagnostics + the repo typecheck are clean AND — if you touched a runtime surface (HTTP endpoint, UI ' +
      'page/component, CLI entry point, or background job) — you have ACTUALLY EXERCISED IT LIVE (booted the ' +
      'process and curled the endpoint / drove the UI / ran the CLI for real). For internal plumbing whose ' +
      'effect is never echoed in an HTTP/UI/CLI surface (e.g. an option/value handed to an SDK), a capture ' +
      'from the booted process proving the changed value was passed at runtime counts instead. Include that ' +
      'live evidence in `verification` (the real command, its exit code, a tail of its output). finalize_build runs a ' +
      'live-verification judge over this evidence and refuses to ship a runtime change you only typechecked. ' +
      'If you cannot get things clean, pass passed:false with `remaining` listing the specific errors.',
    inputSchema: {
      type: 'object',
      properties: {
        passed: { type: 'boolean', description: 'true only when checks are clean AND live-exercised (if runtime).' },
        remaining: {
          type: 'array',
          items: { type: 'string' },
          description: 'When passed:false — the specific remaining errors (file:line — message).',
        },
        verification: {
          type: 'array',
          description:
            'Live-verification evidence — the real commands you ran and their results (curl / UI drive / CLI ' +
            'run — or, for internal plumbing, a booted-process log capture proving the changed value was passed ' +
            'at runtime; plus diagnostics/typecheck). Typecheck/build/lint/tests alone are NOT live verification.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              command: { type: 'string' },
              exitCode: { type: 'number' },
              outputTail: { type: 'string' },
            },
          },
        },
      },
      required: ['passed'],
      additionalProperties: true,
    },
  },
  complete_thread: {
    description:
      'Assert this thread is DONE. Call exactly once when the work is complete and verified. Provide a ' +
      'one-line summary plus, ideally, the changes you made and the verification you ran.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line: what this thread built/fixed.' },
        changes: { type: 'array', items: { type: 'string' }, description: 'Notable changes made.' },
        verification: {
          type: 'array',
          description: 'Verification evidence — the real commands you ran and their results.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              command: { type: 'string' },
              exitCode: { type: 'number' },
              outputTail: { type: 'string' },
            },
          },
        },
        deviations: { type: 'array', items: { type: 'string' }, description: 'Off-spec changes, if any.' },
        gaps: { type: 'array', items: { type: 'string' }, description: 'Known gaps / follow-ups.' },
      },
      required: ['summary'],
      additionalProperties: true,
    },
  },
  block_thread: {
    description:
      'Voluntarily HALT this thread — you cannot make progress this turn and there is nothing to poll for. ' +
      'Use complete_thread when done instead.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: ['question', 'needs_env', 'decision'], description: 'Why blocked.' },
        detail: { type: 'string', description: 'Specifically what blocks you and what you need.' },
      },
      required: ['reason', 'detail'],
      additionalProperties: true,
    },
  },
  reset_sandbox: {
    description:
      'Recreate this job’s sandbox so you can PROVE it cold-boots from durable config. Default: recreates the ' +
      'CONTAINER only (worktree + session survive). `hard:true`: recreates the WHOLE sandbox from scratch — ' +
      'fresh worktree AND container, as if the job just started — while keeping your coding session (history ' +
      'resumes) and the /context + /playground mounts. A hard reset is a TWO-CALL CONFIRM: the first call ' +
      'describes what happens / what is lost and does nothing; call it again to actually reset. It REFUSES on ' +
      'a dirty tree or unpushed commits (the host never commits for you — commit + push first). The reset ' +
      'happens on your NEXT turn — call it, then STOP.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why you are resetting (shown to the operator).' },
        hard: {
          type: 'boolean',
          description:
            'true = full from-scratch worktree + container re-provision (two-call confirm; refuses on a dirty/unpushed tree). Omit/false = container-only reset.',
        },
      },
      required: ['reason'],
      additionalProperties: true,
    },
  },
  // Live task list (parity with Claude Code's TaskCreate/TaskUpdate) — surfaces this thread's work as a
  // checklist in the operator console, identical to the build lanes. Create returns an id string ("Task #N
  // created …"); pass that `taskId` back to task_update to advance its status.
  task_create: {
    description:
      'Add ONE item to your live task list (shown to the operator as a checklist for this thread). Call it ' +
      'up front for each concrete step you plan to do, and as new work emerges. Returns the created task id.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Imperative one-line title, e.g. "Review the merged diff".' },
        description: { type: 'string', description: 'Optional longer detail about what this step involves.' },
        activeForm: {
          type: 'string',
          description: 'Present-continuous form shown while in progress, e.g. "Reviewing the merged diff".',
        },
      },
      required: ['subject'],
      additionalProperties: true,
    },
  },
  task_update: {
    description:
      'Update one task in your live task list — mark it in_progress when you start it and completed when it ' +
      'is done (exactly one task should be in_progress at a time). Use status "deleted" to remove a task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The id returned by task_create (e.g. "3").' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'deleted'],
          description: 'The new status.',
        },
        subject: { type: 'string', description: 'Optional revised title.' },
        description: { type: 'string', description: 'Optional revised detail.' },
        activeForm: { type: 'string', description: 'Optional revised present-continuous form.' },
      },
      required: ['taskId'],
      additionalProperties: true,
    },
  },
};
