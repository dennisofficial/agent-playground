import { describe, expect, it } from 'bun:test';
import { stripTerminalControls } from '../plain-text.js';

describe('stripTerminalControls', () => {
  it('removes the colour sequences a logger writes', () => {
    // The exact shape that smeared the transcript: Nest's logger, colourised.
    const line =
      '\x1b[32m[Nest] 15678\x1b[39m  - 08/13/2026, 11:57:05 PM     \x1b[32mLOG\x1b[39m ' +
      '\x1b[33m[TurnRunnerService]\x1b[39m \x1b[32mturn finished\x1b[39m';
    expect(stripTerminalControls(line)).toBe(
      '[Nest] 15678  - 08/13/2026, 11:57:05 PM     LOG [TurnRunnerService] turn finished',
    );
  });

  it('removes cursor moves, erases and OSC titles', () => {
    expect(stripTerminalControls('a\x1b[2Kb\x1b[1;1Hc')).toBe('abc');
    expect(stripTerminalControls('\x1b]0;a title\x07done')).toBe('done');
    expect(stripTerminalControls('\x1b(Bplain')).toBe('plain');
  });

  it('keeps only what a carriage return redrew', () => {
    expect(stripTerminalControls('50%\r100%')).toBe('100%');
    expect(stripTerminalControls('a\r\nb')).toBe('a\nb');
  });

  it('drops stray control bytes but keeps tabs and newlines', () => {
    expect(stripTerminalControls('a\x07b\x00c')).toBe('abc');
    expect(stripTerminalControls('a\tb\nc')).toBe('a\tb\nc');
  });

  it('leaves ordinary output untouched', () => {
    const text = 'src/domain/plain-text.ts:12  const x = [1, 2];  // ~ 100% ✓';
    expect(stripTerminalControls(text)).toBe(text);
  });
});
