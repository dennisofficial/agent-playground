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

export function audit(entry: AuditEntry): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}
