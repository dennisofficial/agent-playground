import { describe, expect, it } from 'bun:test';
import { jobLabel, projectsLayout, removalCost, shortenHome } from '../projects-list.js';

describe('projectsLayout', () => {
  it('caps both columns on a wide terminal', () => {
    expect(projectsLayout(400)).toEqual({ name: 28, path: 52 });
  });

  it('keeps the path at its minimum while the name still grows', () => {
    expect(projectsLayout(60).path).toBeGreaterThanOrEqual(16);
  });

  it('drops the path rather than shrink it past legibility', () => {
    expect(projectsLayout(40).path).toBe(0);
  });

  it('never returns a negative column, however small the terminal gets', () => {
    for (const width of [0, 1, 12, 30]) {
      const layout = projectsLayout(width);
      expect(layout.name).toBeGreaterThanOrEqual(0);
      expect(layout.path).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('removalCost', () => {
  it('says what survives, not just what goes', () => {
    expect(removalCost(3)).toBe('3 jobs and their transcripts go with it · the folder on disk is untouched');
  });

  it('does not pluralise a single job', () => {
    expect(removalCost(1)).toStartWith('1 job and');
  });

  it('reads naturally when there is nothing to lose', () => {
    expect(removalCost(0)).toStartWith('no jobs to lose');
  });
});

describe('jobLabel', () => {
  it('draws a dash rather than a zero, which reads as a count worth acting on', () => {
    expect(jobLabel(0)).toBe('—');
  });

  it('pluralises past one', () => {
    expect(jobLabel(1)).toBe('1 job');
    expect(jobLabel(2)).toBe('2 jobs');
  });
});

describe('shortenHome', () => {
  it('collapses the home prefix', () => {
    expect(shortenHome({ path: '/Users/dennis/Developer/atlas', home: '/Users/dennis' })).toBe(
      '~/Developer/atlas',
    );
  });

  it('leaves a path outside home alone', () => {
    expect(shortenHome({ path: '/opt/src', home: '/Users/dennis' })).toBe('/opt/src');
  });

  it('leaves everything alone when there is no home to collapse', () => {
    expect(shortenHome({ path: '/Users/dennis/x', home: '' })).toBe('/Users/dennis/x');
  });
});
