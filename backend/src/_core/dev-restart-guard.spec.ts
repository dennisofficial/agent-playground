import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkRestartLoop,
  renderRestartStormWarning,
  DEFAULT_RESTART_WINDOW_MS,
} from './dev-restart-guard';

describe('checkRestartLoop', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dev-restart-guard-'));
    filePath = join(dir, '.dev-boot-log.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a single boot with no history is not a storm', () => {
    const result = checkRestartLoop({ filePath, now: () => 1_000 });
    expect(result).toEqual({
      recentCount: 1,
      looksLikeAStorm: false,
      windowMs: DEFAULT_RESTART_WINDOW_MS,
    });
    expect(existsSync(filePath)).toBe(true);
  });

  it('boots spaced well beyond the window never trip the threshold', () => {
    const spacingMs = 60_000; // > the 30s default window
    let last: ReturnType<typeof checkRestartLoop> | undefined;
    for (let i = 0; i < 8; i++) {
      last = checkRestartLoop({
        filePath,
        windowMs: 30_000,
        threshold: 5,
        now: () => i * spacingMs,
      });
    }
    expect(last!.looksLikeAStorm).toBe(false);
    expect(last!.recentCount).toBe(1); // only itself falls inside its own 30s window
  });

  it('a burst of boots inside the window trips the threshold', () => {
    const times = [0, 2_000, 4_000, 6_000, 8_000]; // 5 boots inside a 30s window
    let last: ReturnType<typeof checkRestartLoop> | undefined;
    for (const t of times) {
      last = checkRestartLoop({
        filePath,
        windowMs: 30_000,
        threshold: 5,
        now: () => t,
      });
    }
    expect(last!.recentCount).toBe(5);
    expect(last!.looksLikeAStorm).toBe(true);
  });

  it('boots outside the window age out of the recent count', () => {
    checkRestartLoop({
      filePath,
      windowMs: 30_000,
      threshold: 5,
      now: () => 0,
    });
    checkRestartLoop({
      filePath,
      windowMs: 30_000,
      threshold: 5,
      now: () => 1_000,
    });
    checkRestartLoop({
      filePath,
      windowMs: 30_000,
      threshold: 5,
      now: () => 2_000,
    });
    // Jump far past the window — only this boot itself should count as "recent".
    const result = checkRestartLoop({
      filePath,
      windowMs: 30_000,
      threshold: 5,
      now: () => 100_000,
    });
    expect(result.recentCount).toBe(1);
    expect(result.looksLikeAStorm).toBe(false);
  });

  it('trims stored history to `keep` entries (bounded file size)', () => {
    for (let i = 0; i < 30; i++) {
      checkRestartLoop({ filePath, keep: 5, now: () => i * 100_000 }); // spaced out — never a storm
    }
    // The 31st call still only sees the last 5 kept, none within its own window → recentCount is just itself.
    const result = checkRestartLoop({
      filePath,
      keep: 5,
      now: () => 3_000_000,
    });
    expect(result.recentCount).toBe(1);
  });

  it('a corrupt history file is treated as empty, never throws', () => {
    const badFile = join(dir, 'corrupt.json');
    writeFileSync(badFile, 'not json{{{');
    expect(() =>
      checkRestartLoop({ filePath: badFile, now: () => 0 }),
    ).not.toThrow();
    const result = checkRestartLoop({ filePath: badFile, now: () => 0 });
    expect(result.recentCount).toBeGreaterThanOrEqual(1);
  });

  it('an unwritable path degrades to a safe non-storm result instead of throwing', () => {
    const unwritable = join(
      dir,
      'nonexistent-parent',
      'sub',
      '.dev-boot-log.json',
    );
    const result = checkRestartLoop({ filePath: unwritable, now: () => 0 });
    expect(result).toEqual({
      recentCount: 1,
      looksLikeAStorm: false,
      windowMs: DEFAULT_RESTART_WINDOW_MS,
    });
  });
});

describe('renderRestartStormWarning', () => {
  it('names the recent count and window so the message is actionable', () => {
    const msg = renderRestartStormWarning({
      recentCount: 6,
      looksLikeAStorm: true,
      windowMs: 30_000,
    });
    expect(msg).toContain('6 boots');
    expect(msg).toContain('30s');
    expect(msg).toMatch(/pnpm dev|dev-server/i);
  });
});
