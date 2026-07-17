import { describe, expect, it } from 'vitest';
import { shipOpenPrBody } from '../ship-open-pr';

describe('turns / ship-open-pr', () => {
  describe('shipOpenPrBody', () => {
    const base = {
      branch: 'atlas/feat',
      defaultBranch: 'main',
      title: 'A feature',
    };

    it('carries the CC-style body sections + evidence bundle + git commands into the task body', () => {
      const task = shipOpenPrBody(base);
      expect(task).toContain('## Summary');
      expect(task).toContain('## Verification');
      expect(task).toContain('/context/evidence/');
      expect(task).toContain('gh pr create');
      // the branch + base flow through
      expect(task).toContain('atlas/feat');
      expect(task).toContain('origin/main');
      // the <70-char title discipline is instructed to the brain (host passes the title verbatim)
      expect(task).toContain('under 70 characters');
    });

    it('passes the PR body via a single-quoted heredoc (Claude Code idiom — no shell expansion)', () => {
      const task = shipOpenPrBody(base);
      expect(task).toContain("--body \"$(cat <<'EOF'");
      expect(task).toContain('EOF');
    });

    it('shell-quotes branch, base, and title values in command examples', () => {
      const task = shipOpenPrBody({
        branch: "feat/o'hara;$(touch bad)",
        defaultBranch: "release/x'y",
        title: "Fix $PATH's widget",
      });

      const quotedBranch = "'feat/o'\\''hara;$(touch bad)'";
      expect(task).toContain(`git log --oneline 'HEAD..origin/release/x'\\''y'`);
      expect(task).toContain(`git merge 'origin/release/x'\\''y'`);
      expect(task).toContain(`git push -u origin ${quotedBranch}`);
      expect(task).toContain(
        `gh pr create --base 'release/x'\\''y' --head ${quotedBranch} --title 'Fix $PATH'\\''s widget'`,
      );
      expect(task).toContain(`gh pr view ${quotedBranch} --json url -q .url`);
    });

    it('suppresses the default Claude attribution (per house style — no Co-Authored-By)', () => {
      const task = shipOpenPrBody(base);
      expect(task).toContain('Co-Authored-By');
      expect(task).toMatch(/Do NOT add.*attribution/);
    });

    it('tells the visible brain turn to close with ONE line (the PR url), not a play-by-play', () => {
      const task = shipOpenPrBody(base);
      expect(task).toContain('ONE LINE');
      expect(task).toContain('gh pr view');
    });

    it('tells the brain to free RAM by stopping the service fleet at ship', () => {
      const task = shipOpenPrBody(base);
      expect(task).toContain('atlas-svc stop-all');
    });

    it('folds the git-safety guardrail into the task body (task-only — no system prompt)', () => {
      expect(shipOpenPrBody(base)).toContain('NEVER run destructive');
    });

    it('does NOT ask for a report_pr_opened tool call (host latches by branch discovery)', () => {
      expect(shipOpenPrBody(base)).not.toContain('report_pr_opened');
    });
  });
});
