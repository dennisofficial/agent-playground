import { z } from 'zod';
import type { EngineSpec } from '../../engines/engine-spec';
import type { ToolCapability } from '../capability';
import type { EmployeeContext } from '../employee-context';

/** Capability name = the LLM-visible tool name. */
export const DEEP_RESEARCH = 'deep_research';

const deepResearchSchema = z.object({
  question: z
    .string()
    .describe(
      'What to research — be specific. The background thread searches the web and reads primary sources.',
    ),
  worktreeId: z
    .string()
    .optional()
    .describe(
      'Reuse an existing worktree by id; omit to open a scratch one for the research session.',
    ),
});

/**
 * A discretionary, LLM-invoked research capability (Nora). It is bound into the chat allowlist at
 * graph-build time and, when called, opens a REAL read-only research session from its `EngineSpec`
 * (via the shared `CreateSessionTool` semantics — worktree, ownership, ALS detachment). The `spec` is
 * the research engine recipe, built by the employee via `this.engineSpec(ctx, …)`.
 */
export const deepResearchCapability = (
  spec: (ctx: EmployeeContext) => EngineSpec,
): ToolCapability => ({
  name: DEEP_RESEARCH,
  trigger: { kind: 'tool' },
  description:
    "Open a background RESEARCH session — searches the web and reads primary sources, then reports findings with citations. Read-only; you're notified when it reports back. Put a brief first-person heads-up in this message.",
  schema: deepResearchSchema,
  mode: 'plan',
  spec,
});
