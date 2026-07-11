export interface AuditEntry {
  ts?: string;
  tool: string;
  jobId?: string;
  orgId?: string;
  ok: boolean;
  remote?: string;
  error?: string;
  sql?: string;
  rows?: number;
}

/** One JSON line to stdout per tool call and per rejected auth attempt — the entire audit trail (no file,
 *  no DB; the deployment's log collector owns retention). */
export function audit(entry: AuditEntry): void {
  // eslint-disable-next-line no-console -- stdout IS the audit log for this process
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}
