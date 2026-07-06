import { describe, expect, it } from 'vitest';
import { decisionsBlock, shipOpenPrBody } from './ship-open-pr';

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

  describe('shipOpenPrBody', () => {
    const base = { branch: 'atlas/feat', defaultBranch: 'main', title: 'A feature', decisionsBlock: '' };

    it('carries the CC-style body sections + evidence bundle + git commands into the task body', () => {
      const task = shipOpenPrBody(base);
      expect(task).toContain('## Summary');
      expect(task).toContain('## Verification');
      expect(task).toContain('/context/artifacts/RESULTS.md');
      expect(task).toContain('gh pr create');
      // the branch + base flow through
      expect(task).toContain('atlas/feat');
      expect(task).toContain('origin/main');
      // the <70-char title discipline is instructed to the brain (host passes the title verbatim)
      expect(task).toContain('under 70 characters');
    });

    it('folds the git-safety guardrail into the task body (task-only — no system prompt)', () => {
      expect(shipOpenPrBody(base)).toContain('NEVER run destructive');
    });

    it('does NOT ask for a report_pr_opened tool call (host latches by branch discovery)', () => {
      expect(shipOpenPrBody(base)).not.toContain('report_pr_opened');
    });

    it('pastes the host Decisions block verbatim only when there are decisions', () => {
      const block = decisionsBlock([
        { title: 'Ship in-sandbox', decisionClass: 'mechanism', ruling: 'Atlas opens the PR itself' },
      ]);
      const withDecisions = shipOpenPrBody({ ...base, decisionsBlock: block });
      expect(withDecisions).toContain('VERBATIM');
      expect(withDecisions).toContain(block);

      const without = shipOpenPrBody(base);
      expect(without).not.toContain('### Decisions');
      expect(without).not.toContain('VERBATIM');
    });
  });
});
