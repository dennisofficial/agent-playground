import type { DecisionClass, DecisionRecord } from '../../_shared/domain';

export type DecisionVerdict = 'covered' | 'proceed' | 'ask';

export interface ProposedDecision {
  description: string;
  context?: string;
}

export interface DecisionClassification {
  verdict: DecisionVerdict;
  decisionClass?: DecisionClass;
  reason: string;
  via: 'rule' | 'llm';
  coveredBy?: string;
}

export type ClassifierRecord = Pick<DecisionRecord, 'decisions'>;
