import { describe, expect, it } from 'vitest';
import { SHIP_OPEN_PR_SYSTEM, decisionsBlock, shipOpenPrTurn } from './ship-open-pr';

describe('turns / ship-open-pr', () => {
  describe('decisionsBlock', () => {
    it('renders the host-owned Decisions block from locked decisions', () => {
      const out = decisionsBlock([
        { title: 'Use pgvector', decisionClass: 'data-model', ruling: 'HNSW index on embeddings' },
      ]);
      expect(out).toContain('### Decisions');
      expect(out).toContain('- **Use pgvector** (data-model): HNSW index on embeddings');
    });

    it('is empty when there are no decisions', () => {
      expect(decisionsBlock([])).toBe('');
    });
  });

  describe('shipOpenPrTurn', () => {
    const base = { branch: 'atlas/feat', defaultBranch: 'main', title: 'A feature', decisionsBlock: '' };

    it('carries the CC-style body sections + evidence bundle + git commands into the task', () => {
      const { task } = shipOpenPrTurn(base);
      expect(task).toContain('## Summary');
      expect(task).toContain('## Verification');
      expect(task).toContain('/context/artifacts/RESULTS.md');
      expect(task).toContain('gh pr create');
      expect(task).toContain('report_pr_opened');
      // the branch + base flow through
      expect(task).toContain('atlas/feat');
      expect(task).toContain('origin/main');
      // the <70-char title discipline is instructed to the brain (host passes the title verbatim)
      expect(task).toContain('under 70 characters');
    });

    it('pastes the host Decisions block verbatim only when there are decisions', () => {
      const block = decisionsBlock([
        { title: 'Ship in-sandbox', decisionClass: 'mechanism', ruling: 'Atlas opens the PR itself' },
      ]);
      const withDecisions = shipOpenPrTurn({ ...base, decisionsBlock: block }).task;
      expect(withDecisions).toContain('VERBATIM');
      expect(withDecisions).toContain(block);

      const without = shipOpenPrTurn(base).task;
      expect(without).not.toContain('### Decisions');
      expect(without).not.toContain('VERBATIM');
    });

    it('pairs the shared open-PR system prompt with a git-safety guardrail', () => {
      expect(shipOpenPrTurn(base).system).toBe(SHIP_OPEN_PR_SYSTEM);
      expect(SHIP_OPEN_PR_SYSTEM).toContain('report_pr_opened');
      expect(SHIP_OPEN_PR_SYSTEM).toContain('NEVER run destructive');
    });
  });
});
