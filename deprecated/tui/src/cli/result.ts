/**
 * What every subcommand returns. A miss — no such job, no map written yet — is a normal outcome of
 * a read and is reported as text an agent can act on, never as a thrown stack trace it would have to
 * interpret.
 */
export type CliResult = { ok: true; text: string } | { ok: false; message: string };

export function found(text: string): CliResult {
  return { ok: true, text };
}

export function missing(message: string): CliResult {
  return { ok: false, message };
}
