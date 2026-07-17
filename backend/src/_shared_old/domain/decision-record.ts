export const DECISION_CLASS_META = [
  { id: 'data_model', heading: 'Data model', grill: 'data model/schema' },
  {
    id: 'api_contract',
    heading: 'API contract',
    grill: 'public API contracts',
  },
  { id: 'dependency', heading: 'Dependencies', grill: 'new dependencies' },
  {
    id: 'infrastructure',
    heading: 'Infrastructure',
    grill: 'infrastructure/topology',
  },
  {
    id: 'cross_cutting',
    heading: 'Cross-cutting',
    grill: 'cross-cutting patterns (auth, caching, state, concurrency, error-handling)',
  },
  { id: 'one_way_door', heading: 'One-way doors', grill: 'one-way doors' },
] as const satisfies ReadonlyArray<{
  id: string;
  heading: string;
  grill: string;
}>;

export type DecisionClass = (typeof DECISION_CLASS_META)[number]['id'];

export const DECISION_CLASS_IDS: readonly DecisionClass[] = DECISION_CLASS_META.map((c) => c.id);

export function nextDecisionId(existing: Pick<Decision, 'id'>[]): string {
  const max = existing.reduce((m, d) => {
    const match = /^d(\d+)$/.exec(d.id ?? '');
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return `d${max + 1}`;
}

export interface Decision {
  id?: string;
  decisionClass: DecisionClass;
  title: string;
  ruling: string;
  question?: string;
  answer?: string;
  confirmedByOperator?: boolean;
}

export type DecisionRecordStatus = 'draft' | 'approved' | 'superseded';

export interface DecisionRecord {
  id: string;
  orgId: string;
  repoId: string;
  jobId: string;
  status: DecisionRecordStatus;
  overview: string;
  decisions: Decision[];
  threadTitles: string[];
  approvedBy: string | null;
  approvedAt: Date | null;
}
