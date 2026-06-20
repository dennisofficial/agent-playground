import { describe, expect, it } from 'vitest';
import { parseGrillArgs } from './brain-llm';

describe('parseGrillArgs', () => {
  it('parses an ask_question action', () => {
    const a = parseGrillArgs({ verb: 'ask_question', question: 'Which DB?' });
    expect(a).toEqual({ verb: 'ask_question', question: 'Which DB?' });
  });

  it('drops an ask_question with no question', () => {
    expect(parseGrillArgs({ verb: 'ask_question' })).toBeUndefined();
  });

  it('parses a propose_plan action, filtering malformed decisions and empty briefs', () => {
    const a = parseGrillArgs({
      verb: 'propose_plan',
      title: 'Export',
      kind: 'feature',
      overview: 'Add export.',
      decisions: [
        { decisionClass: 'data_model', title: 'No schema change', ruling: 'read-only' },
        { decisionClass: 'data_model', title: 'missing ruling' }, // dropped
      ],
      sectionBriefs: ['Backend', '', 'Frontend'],
    });
    expect(a?.verb).toBe('propose_plan');
    if (a?.verb !== 'propose_plan') throw new Error('expected propose_plan');
    expect(a.title).toBe('Export');
    expect(a.kind).toBe('feature');
    expect(a.decisions).toHaveLength(1);
    expect(a.sectionBriefs).toEqual(['Backend', 'Frontend']);
  });

  it('defaults a propose_plan kind to feature when not bugfix', () => {
    const a = parseGrillArgs({ verb: 'propose_plan', title: 'X', sectionBriefs: ['s'] });
    if (a?.verb !== 'propose_plan') throw new Error('expected propose_plan');
    expect(a.kind).toBe('feature');
  });

  it('honors kind=bugfix', () => {
    const a = parseGrillArgs({ verb: 'propose_plan', title: 'X', kind: 'bugfix', sectionBriefs: ['s'] });
    if (a?.verb !== 'propose_plan') throw new Error('expected propose_plan');
    expect(a.kind).toBe('bugfix');
  });

  it('returns undefined on an unknown verb', () => {
    expect(parseGrillArgs({ verb: 'nope' })).toBeUndefined();
    expect(parseGrillArgs(undefined)).toBeUndefined();
  });
});
