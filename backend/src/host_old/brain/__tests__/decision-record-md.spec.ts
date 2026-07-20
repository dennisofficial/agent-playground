import type { Decision } from '@shared/domain/decision-record';
import { describe, expect, it } from 'vitest';
import { renderDecisionRecordMd } from '../decision-record-md';

describe('renderDecisionRecordMd', () => {
  it('renders an empty-state doc when there are no decisions', () => {
    const md = renderDecisionRecordMd([]);
    expect(md).toContain('# Decision record');
    expect(md).toContain('No decisions locked yet.');
  });

  it('groups decisions by class and includes the captured Q&A', () => {
    const decisions: Decision[] = [
      {
        decisionClass: 'data_model',
        title: 'Subdomain column',
        ruling: 'Add a unique, normalized subdomain column on Server.',
        question: 'Where does the customer pick the subdomain?',
        answer: 'In the new-server wizard',
      },
      {
        decisionClass: 'api_contract',
        title: 'Availability endpoint',
        ruling: 'Add a live availability check that also considers held orders.',
      },
    ];
    const md = renderDecisionRecordMd(decisions, 'Customer-chosen subdomains for servers.');

    expect(md).toContain('## Overview');
    expect(md).toContain('Customer-chosen subdomains for servers.');
    expect(md).toContain('## Data model');
    expect(md).toContain('#### Subdomain column');
    expect(md).toContain('> **Q:** Where does the customer pick the subdomain?');
    expect(md).toContain('> **A:** In the new-server wizard');
    expect(md).toContain('## API contract');
    expect(md).not.toContain('> **Q:** \n');
  });

  it('renders an unambiguous provenance status line per decision', () => {
    const md = renderDecisionRecordMd([
      {
        decisionClass: 'data_model',
        title: 'Confirmed call',
        ruling: 'Operator picked this.',
        question: 'A or B?',
        answer: 'A',
        confirmedByOperator: true,
      },
      {
        decisionClass: 'api_contract',
        title: 'Authored default',
        ruling: 'Atlas chose this default.',
      },
    ]);
    expect(md).toContain('**Status:** Confirmed by the operator.');
    expect(md).toContain('**Status:** Authored by Atlas');
    expect(md).toContain('NOT confirmed by the operator');
  });

  it('omits classes with no decisions', () => {
    const md = renderDecisionRecordMd([
      {
        decisionClass: 'dependency',
        title: 'Use Stripe',
        ruling: 'Keep Stripe for checkout.',
      },
    ]);
    expect(md).toContain('## Dependencies');
    expect(md).not.toContain('## Data model');
    expect(md).not.toContain('## One-way doors');
  });
});
