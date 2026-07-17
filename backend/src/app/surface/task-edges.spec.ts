import { describe, expect, it } from 'vitest';
import { applyEdge, hasBlockedByInput, inverseEdgeOps, mergeBlockedBy } from './task-edges';

describe('task-edges — pure blocked_by set logic', () => {
  describe('mergeBlockedBy', () => {
    it('unions prev with blockedBy + addBlockedBy, then subtracts removeBlockedBy, deduped', () => {
      expect(mergeBlockedBy(['a'], { addBlockedBy: ['b', 'a'], blockedBy: ['c'] })).toEqual([
        'a',
        'c',
        'b',
      ]);
      expect(mergeBlockedBy(['a', 'b'], { removeBlockedBy: ['a'] })).toEqual(['b']);
    });

    it('drops non-string members and returns [] when nothing survives', () => {
      expect(mergeBlockedBy([], { blockedBy: ['x', 2, null] })).toEqual(['x']);
      expect(mergeBlockedBy(['a'], { removeBlockedBy: ['a'] })).toEqual([]);
    });
  });

  describe('hasBlockedByInput', () => {
    it('is true only when a forward-edge field is present', () => {
      expect(hasBlockedByInput({ status: 'completed' })).toBe(false);
      expect(hasBlockedByInput({ blockedBy: [] })).toBe(true);
      expect(hasBlockedByInput({ addBlockedBy: ['x'] })).toBe(true);
      expect(hasBlockedByInput({ removeBlockedBy: ['x'] })).toBe(true);
    });
  });

  describe('inverseEdgeOps + applyEdge', () => {
    it('maps addBlocks → add ops and removeBlocks → remove ops', () => {
      expect(inverseEdgeOps({ addBlocks: ['1'], removeBlocks: ['2'] })).toEqual([
        { targetId: '1', op: 'add' },
        { targetId: '2', op: 'remove' },
      ]);
    });

    it('applyEdge appends (deduped) or removes the source id on a target row', () => {
      expect(applyEdge(['a'], 'b', 'add')).toEqual(['a', 'b']);
      expect(applyEdge(['a', 'b'], 'b', 'add')).toEqual(['a', 'b']);
      expect(applyEdge(['a', 'b'], 'a', 'remove')).toEqual(['b']);
      expect(applyEdge([], 'a', 'remove')).toEqual([]);
    });
  });
});
