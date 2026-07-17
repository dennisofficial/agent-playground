import type { PipelineMarker } from '../../persistence/entities/job.entity';

export type { PipelineMarker };


interface PipelineStateView {
  status?: string;
  decisionRecordId?: string | null;
  prUrl?: string | null;
  threads?: Array<{
    id?: string;
    ordinal?: number;
    brief?: string;
    status?: string;
    steps?: Array<{ id?: string; stage?: string; status?: string }>;
  }>;
}

function isLivePipeline(s: PipelineStateView | null | undefined): s is PipelineStateView {
  return !!s && s.status != null && s.status !== 'no_job' && s.status !== 'open';
}

export function pipelineStateSignature(state: unknown): string | null {
  const s = state as PipelineStateView;
  if (!isLivePipeline(s)) return null;
  const parts = [`dr:${s.decisionRecordId ?? ''}`, `st:${s.status}`, `pr:${s.prUrl ?? ''}`];
  for (const sec of s.threads ?? []) {
    parts.push(`s${sec.ordinal ?? '?'}:${sec.status ?? '?'}`);
    for (const p of sec.steps ?? []) {
      parts.push(`p${(p.id ?? '').slice(0, 8)}:${p.stage ?? '?'}/${p.status ?? '?'}`);
    }
  }
  return parts.join('|');
}

export function renderPipelineStateSummary(state: unknown): string {
  const s = state as PipelineStateView;
  if (!isLivePipeline(s)) return '';
  const lines = [`Current build state: ${s.status}.`];
  if (s.prUrl) lines.push(`PR: ${s.prUrl}`);
  for (const sec of s.threads ?? []) {
    const steps = sec.steps ?? [];
    const phaseBit = steps.length
      ? ` [${steps.filter((p) => p.status === 'done').length}/${steps.length} steps done]`
      : '';
    lines.push(
      `  • Thread ${sec.ordinal ?? '?'} "${sec.brief ?? ''}": ${sec.status ?? '?'}${phaseBit}`,
    );
  }
  return lines.join('\n');
}

export function renderAwarenessPrefix(
  markers: PipelineMarker[],
  stateSummary: string | null,
): string {
  if (markers.length === 0 && !stateSummary) return '';
  const parts = [
    'Pipeline updates since your last message — informational, no action needed unless asked:',
  ];
  for (const m of markers) parts.push(`- ${m.text}`);
  if (stateSummary) parts.push('', stateSummary);
  return parts.join('\n');
}
