/**
 * Two ways an Atlas tool call ends badly, and they ask opposite things of the agent.
 *
 * A REFUSAL is ordinary conversation: the phase does not host that role, the file you named is not
 * in the context folder, a sibling thread is still open. The agent misjudged something, the harness
 * is working exactly as designed, and the right response is to read the sentence and call again.
 *
 * A HARNESS fault is Atlas being broken. Retrying is pointless — the same call will take the same
 * path into the same bug — and an agent that treats it as a refusal will burn its turn inventing
 * workarounds for a tool that is simply not there. This distinction exists because that is precisely
 * what happened: `advance_thread` came back `rolesFor is not defined`, which reads exactly like a
 * refusal about roles and is in fact a half-applied rename.
 */
export enum EToolFault {
  /** The agent can fix this and call again. */
  refusal = 'refusal',
  /** Atlas is broken. Calling again identically will fail identically. */
  harness = 'harness',
}

export type ToolFault = {
  kind: EToolFault;
  /** What the agent reads back as the tool result's content. */
  reply: string;
  /**
   * The blob for the fault log — stack and all. `null` for a refusal, which is not a fault and
   * would drown the log in ordinary conversation. The caller stamps it; this stays pure.
   */
  detail: string | null;
};

/**
 * The error types the JavaScript engine mints, which Atlas never throws on purpose.
 *
 * This is the whole classifier, and it is a denylist rather than an allowlist by necessity: there
 * are ~50 deliberate `throw new Error(prose)` sites across `app/`, every one of them a refusal, and
 * a rule that needed each to opt in would misreport the ones nobody remembered to touch. Being
 * wrong in that direction is the expensive one — a real harness fault silently dressed as a refusal
 * is the bug this module exists to stop.
 *
 * `TypeError` earns its place twice over: `undefined is not an object (evaluating 'this.foo.bar')`
 * is what a lost `emitDecoratorMetadata` looks like at runtime, and that failure mode is documented
 * in `tui/CLAUDE.md` because it has already shipped once.
 */
const ENGINE_ERRORS: ReadonlySet<string> = new Set([
  'ReferenceError',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'EvalError',
  'InternalError',
]);

/**
 * Sort a thrown value into the two kinds, and compose both of the things a caller needs from it:
 * the sentence the agent reads and the blob the human reads.
 *
 * Takes `unknown` because that is what `catch` binds. A throw that is not an `Error` at all is a
 * harness fault by definition — nothing in Atlas throws a bare string deliberately, and a value with
 * no message is one the agent could not act on even if it were a refusal.
 */
export function classifyToolFault(args: {
  tool: string;
  error: unknown;
}): ToolFault {
  if (!(args.error instanceof Error)) {
    return harnessFault({ tool: args.tool, label: String(args.error), stack: null });
  }
  if (!ENGINE_ERRORS.has(args.error.name)) {
    // The message alone, exactly as before: a refusal is prose written FOR the agent, and prefixing
    // it with machinery would make every ordinary "you may open charting, research" read like a
    // crash.
    return { kind: EToolFault.refusal, reply: args.error.message, detail: null };
  }
  return harnessFault({
    tool: args.tool,
    label: `${args.error.name}: ${args.error.message}`,
    stack: args.error.stack ?? null,
  });
}

/**
 * What the agent is told when the harness itself broke.
 *
 * Three things, in this order, because the agent's failure modes are in this order: it does not know
 * this is not its fault, so it will apologise and try a variation; it does not know retrying is
 * futile, so it will spend the turn doing that; and it does not know it should say so out loud, so
 * the human finds out hours later from a thread that quietly did something else instead.
 *
 * The raw text rides along rather than being swallowed — the transcript is where the human is
 * already looking, and `~/.atlas/faults.log` is a second stop, not the only one.
 */
function harnessFault(args: {
  tool: string;
  label: string;
  stack: string | null;
}): ToolFault {
  return {
    kind: EToolFault.harness,
    reply: [
      `Atlas could not run \`${args.tool}\` — ${args.label}.`,
      'This is a fault in the harness, not a mistake in your call: the same call will fail the same',
      'way, so do not retry it and do not invent a way around it.',
      'Say plainly in your reply what you were trying to do and that the tool is broken, then stop.',
    ].join(' '),
    detail: [`${args.tool} — ${args.label}`, args.stack]
      .filter((part): part is string => part !== null)
      .join('\n'),
  };
}
