import { describe, expect, it } from 'vitest';
import { isToastIncomplete } from './toast';

describe('isToastIncomplete', () => {
  it('is false for a null row (delete image)', () => {
    expect(isToastIncomplete(null)).toBe(false);
  });

  it('is false when every column is present (including real SQL nulls)', () => {
    expect(isToastIncomplete({ id: 1, body: 'x', deleted_at: null })).toBe(false);
  });

  it('distinguishes an unchanged-TOAST placeholder (undefined) from a SQL null', () => {
    // pgoutput sends an unchanged TOASTed column as `undefined`; a real NULL is `null`.
    expect(isToastIncomplete({ id: 1, body: undefined })).toBe(true);
    expect(isToastIncomplete({ id: 1, body: null })).toBe(false);
  });

  it('detects a placeholder among otherwise-present columns', () => {
    expect(isToastIncomplete({ id: 1, title: 'present', content: undefined })).toBe(true);
  });

  it('is false for an empty row', () => {
    expect(isToastIncomplete({})).toBe(false);
  });
});
