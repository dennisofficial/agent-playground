import type { WorkerQuestion } from '../engines/worker-engine.port';
import { renderQaAppendix, renderQuestionsReport } from './question-report';

const q = (overrides: Partial<WorkerQuestion> = {}): WorkerQuestion => ({
  question: 'Which auth approach should the new endpoints use?',
  header: 'Auth',
  options: [
    { label: 'Session cookie', description: 'reuse the existing middleware' },
    { label: 'API token' },
  ],
  ...overrides,
});

describe('renderQuestionsReport', () => {
  it('renders a single question with numbered options and answer instructions', () => {
    const out = renderQuestionsReport([q()]);
    expect(out).toContain(
      'I need answers before I can finish this plan — 1 question:',
    );
    expect(out).toContain(
      '**Q1 — Auth (pick one):** Which auth approach should the new endpoints use?',
    );
    expect(out).toContain(
      '  1. Session cookie — reuse the existing middleware',
    );
    expect(out).toContain('  2. API token'); // no description → no dash
    expect(out).not.toContain('  2. API token —');
    expect(out).toContain('answer for EVERY question, by number');
    expect(out).toContain('"Your call" is a valid answer');
  });

  it('numbers multiple questions and marks multi-select', () => {
    const out = renderQuestionsReport([
      q(),
      q({
        question: 'Which environments should the backfill cover?',
        header: 'Backfill',
        multiSelect: true,
        options: [{ label: 'Production' }, { label: 'Staging' }],
      }),
    ]);
    expect(out).toContain('2 questions:');
    expect(out).toContain('**Q1 — Auth (pick one):**');
    expect(out).toContain('**Q2 — Backfill (pick one or more):**');
  });

  it('tolerates a missing header and empty options', () => {
    const out = renderQuestionsReport([q({ header: undefined, options: [] })]);
    expect(out).toContain(
      '**Q1:** Which auth approach should the new endpoints use?',
    );
    expect(out).not.toContain('(pick one)'); // no options → no pick hint
  });

  it('appends a captured partial plan when the turn produced both', () => {
    const out = renderQuestionsReport([q()], 'Step 1: do the thing.');
    expect(out).toContain('--- Partial plan so far ---');
    expect(out).toContain('Step 1: do the thing.');
  });
});

describe('renderQaAppendix', () => {
  it('renders each asked/answered round in order', () => {
    const out = renderQaAppendix([
      { q: 'questions round one', a: 'Q1: option 1' },
      { q: 'questions round two', a: 'Q1: your call' },
    ]);
    expect(out).toContain('### Decisions made while planning (Q&A)');
    expect(out).toContain('**Asked (round 1):**\nquestions round one');
    expect(out).toContain('**Answered:** Q1: option 1');
    expect(out).toContain('**Asked (round 2):**\nquestions round two');
    expect(out.indexOf('round one')).toBeLessThan(out.indexOf('round two'));
  });
});
