import { describe, expect, it } from 'vitest';
// Pins the exact rendered output of the role prompts (the snapshot was captured against the pre-refactor
// string-concat version and proves the tmpl rewrite is byte-identical).
import {
  DEFAULT_EXECUTE_PROMPT,
  DEFAULT_PLAN_PROMPT,
  DEFAULT_REVIEW_PROMPT,
} from './engine.prompts';

const TICKET = 'TKT-1: do the thing\n\nWith a multi-line { braces: true } description.';
const PLAN = '1. step one\n2. step two `{ json: example }`';

describe('engine role prompts byte-stability', () => {
  it('DEFAULT_PLAN_PROMPT (no context)', () => {
    expect(DEFAULT_PLAN_PROMPT({ ticket: TICKET })).toMatchSnapshot();
  });
  it('DEFAULT_PLAN_PROMPT (with context)', () => {
    expect(
      DEFAULT_PLAN_PROMPT({ ticket: TICKET, context: 'extra { ctx }' }),
    ).toMatchSnapshot();
  });
  it('DEFAULT_EXECUTE_PROMPT', () => {
    expect(DEFAULT_EXECUTE_PROMPT({ ticket: TICKET, plan: PLAN })).toMatchSnapshot();
  });
  it('DEFAULT_REVIEW_PROMPT', () => {
    expect(
      DEFAULT_REVIEW_PROMPT({ goal: 'ship it', ticket: TICKET, plan: PLAN }),
    ).toMatchSnapshot();
  });
});
