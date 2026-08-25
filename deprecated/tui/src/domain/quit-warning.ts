/**
 * What quitting is about to cost, or `null` when it costs nothing.
 *
 * Ctrl+c arms once and quits on the second press, and this sentence is the whole of the warning. It
 * used to count only working agents, on the reasoning that *"turns are subprocesses of this process,
 * so quitting kills them"* — true, and no longer the whole truth. A service is a detached process
 * group that the reaper kills on the way out, deliberately, so a human who quits while a dev server
 * is up loses it with no other notice anywhere in the app.
 *
 * Agents come first because they are what you lose WORK in: a killed turn's thinking is gone, while a
 * killed service is one `service_start` away from being back.
 *
 * Pure, and in `domain/`, because "is there anything to warn about" is the same decision as "what
 * does the warning say" — splitting them across a component and a helper is how the two drift.
 */
export function quitWarning(args: {
  agents: number;
  services: number;
}): string | null {
  const clauses = [
    countClause({ count: args.agents, one: 'agent still working', many: 'agents still working' }),
    countClause({ count: args.services, one: 'service running', many: 'services running' }),
  ].filter((clause): clause is string => clause !== null);

  return clauses.length === 0 ? null : clauses.join(' · ');
}

function countClause(args: {
  count: number;
  one: string;
  many: string;
}): string | null {
  // A count that is not a positive whole number is nothing to warn about. Both callers read live
  // registries, and a warning built from a `NaN` would arm ctrl+c forever without saying why.
  if (!Number.isFinite(args.count) || args.count < 1) return null;
  const count = Math.floor(args.count);
  return `${count} ${count === 1 ? args.one : args.many}`;
}
