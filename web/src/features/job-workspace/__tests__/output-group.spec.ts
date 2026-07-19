import { describe, expect, it } from 'vitest';
import { isOutputGroupHidden } from '../output-group';

describe('isOutputGroupHidden (EVIDENCE hidden-when-empty region)', () => {
  it('hides a hideWhenEmpty group with no files, nothing loading, and no children', () => {
    expect(
      isOutputGroupHidden({
        hideWhenEmpty: true,
        fileCount: 0,
        loading: false,
        hasChildren: false,
      }),
    ).toBe(true);
  });

  it('shows the group once it has at least one file', () => {
    expect(
      isOutputGroupHidden({
        hideWhenEmpty: true,
        fileCount: 1,
        loading: false,
        hasChildren: false,
      }),
    ).toBe(false);
  });

  it('shows the group while it is still loading', () => {
    expect(
      isOutputGroupHidden({
        hideWhenEmpty: true,
        fileCount: 0,
        loading: true,
        hasChildren: false,
      }),
    ).toBe(false);
  });

  it('shows the group when it has children even with no files', () => {
    expect(
      isOutputGroupHidden({
        hideWhenEmpty: true,
        fileCount: 0,
        loading: false,
        hasChildren: true,
      }),
    ).toBe(false);
  });

  it('never hides a group that did not opt into hideWhenEmpty (SPECS/ARTIFACTS/GENERATED)', () => {
    expect(
      isOutputGroupHidden({
        hideWhenEmpty: false,
        fileCount: 0,
        loading: false,
        hasChildren: false,
      }),
    ).toBe(false);
    expect(isOutputGroupHidden({ fileCount: 0, hasChildren: false })).toBe(false);
  });
});
