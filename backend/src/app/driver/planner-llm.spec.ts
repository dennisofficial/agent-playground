import { describe, expect, it } from 'vitest';
import { renderPlanContext } from './planner-llm';

/**
 * W4 — the section planner's PURE helper. The LLM chains themselves are faked in the driver tests (the
 * adapter is bound behind `PLANNER_LLM`); here we pin the context-rendering that turns a plan input into
 * the prompt text. (Phase parsing is now the declarative chain's `withStructuredOutput`, no hand parser.)
 */
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
