import { describe, expect, it } from 'vitest';
import { parsePhases, renderPlanContext } from './planner-llm';

/**
 * W4 — the section planner's PURE helpers. The LLM adapter itself is faked in the driver tests; here we
 * pin the parsing + context-rendering that turn raw tool args / a plan input into the driver's shapes.
 */
describe('parsePhases', () => {
  it('keeps only well-formed phases (title + brief both present)', () => {
    const parsed = parsePhases({
      phases: [
        { title: 'A', brief: 'do a' },
        { title: 'B' }, // missing brief — dropped
        { brief: 'c' }, // missing title — dropped
        { title: 'D', brief: 'do d' },
      ],
    });
    expect(parsed).toEqual([
      { title: 'A', brief: 'do a' },
      { title: 'D', brief: 'do d' },
    ]);
  });

  it('returns undefined for empty / malformed args (driver falls back to a single phase)', () => {
    expect(parsePhases({ phases: [] })).toBeUndefined();
    expect(parsePhases({})).toBeUndefined();
    expect(parsePhases(undefined)).toBeUndefined();
    expect(parsePhases({ phases: [{ title: 'x' }] })).toBeUndefined();
  });
});

describe('renderPlanContext', () => {
  it('includes the overview, locked decisions, brief, and prior handoff', () => {
    const text = renderPlanContext({
      overview: 'Build it.',
      decisions: [{ decisionClass: 'data_model', title: 'Users table', ruling: 'one table' }],
      brief: 'Backend',
      handoffIn: 'API contract is X',
    });
    expect(text).toContain('Build it.');
    expect(text).toContain('[data_model] Users table: one table');
    expect(text).toContain('Backend');
    expect(text).toContain('Prior section handoff:\nAPI contract is X');
  });

  it('renders "(none)" for no decisions and omits the handoff line when null', () => {
    const text = renderPlanContext({
      overview: 'o',
      decisions: [],
      brief: 'b',
      handoffIn: null,
    });
    expect(text).toContain('(none)');
    expect(text).not.toContain('Prior section handoff');
  });
});
