import { describe, expect, it } from 'vitest';
import { contextConvoNodeForHref, resolveNode } from './node-registry';

describe('contextConvoNodeForHref', () => {
  it('maps absolute /context bucket hrefs to their node id', () => {
    expect(contextConvoNodeForHref('/context/artifacts/preview.html')).toBe(
      'artifact:preview.html',
    );
    expect(contextConvoNodeForHref('/context/specs/plan.md')).toBe('spec:plan.md');
    expect(contextConvoNodeForHref('/context/generated/decision-record.md')).toBe(
      'gen:decision-record.md',
    );
    expect(contextConvoNodeForHref('/context/evidence/010-backend/RESULTS.md')).toBe(
      'evidence:010-backend/RESULTS.md',
    );
  });

  it('maps bucket-relative hrefs (no leading /context) to their node id', () => {
    expect(contextConvoNodeForHref('specs/plan.md')).toBe('spec:plan.md');
    expect(contextConvoNodeForHref('generated/decision-record.md')).toBe('gen:decision-record.md');
    expect(contextConvoNodeForHref('artifacts/sub/dir/preview.html')).toBe(
      'artifact:sub/dir/preview.html',
    );
    expect(contextConvoNodeForHref('evidence/010-backend/boot.png')).toBe(
      'evidence:010-backend/boot.png',
    );
  });

  it('strips query and hash before resolving', () => {
    expect(contextConvoNodeForHref('/context/artifacts/preview.html?v=2#top')).toBe(
      'artifact:preview.html',
    );
    expect(contextConvoNodeForHref('/context/evidence/010-backend/run.log?v=2#tail')).toBe(
      'evidence:010-backend/run.log',
    );
  });

  it('returns null for non-context, external, or unknown-bucket hrefs', () => {
    expect(contextConvoNodeForHref('/etc/passwd')).toBeNull();
    expect(contextConvoNodeForHref('http://x')).toBeNull();
    expect(contextConvoNodeForHref('foo/bar')).toBeNull();
    expect(contextConvoNodeForHref('/context/other/file.md')).toBeNull();
  });

  it('returns null for a bucket with no file path', () => {
    expect(contextConvoNodeForHref('/context/artifacts/')).toBeNull();
    expect(contextConvoNodeForHref('specs')).toBeNull();
  });

  it('returns null for path traversal', () => {
    expect(contextConvoNodeForHref('artifacts/../x')).toBeNull();
    expect(contextConvoNodeForHref('/context/specs/../../etc/passwd')).toBeNull();
    expect(contextConvoNodeForHref('evidence/../secret')).toBeNull();
  });

  it('resolves an evidence: node id (fourth bucket, self-handling like the others)', () => {
    expect(resolveNode('evidence:010-backend/RESULTS.md', null, false)).toBe('found');
  });
});
